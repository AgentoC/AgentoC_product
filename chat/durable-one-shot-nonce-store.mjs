/**
 * Durable one-shot nonce state for privileged semantic execution.
 *
 * The capability-grant store owns the cross-process lock and atomic durable
 * CAS. This wrapper adds the execution-channel audit precondition: a fresh
 * store may initialize an empty audit file, but once durable usage state
 * exists, a missing, unreadable, or corrupt audit file fails closed.
 *
 * A successful claim persists the usage CAS before the audit append. If the
 * process dies between those two operations, the durable CAS still rejects a
 * replay. The next process also refuses to execute when the audit cannot be
 * restored. There is deliberately no seed/in-memory fallback.
 */

import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { openCapabilityGrantStore } from './capability-grant-store.mjs';

const STATE_FILE_NAME = '.usage-registry.json';
const DEFAULT_AUDIT_MODE = 0o640;
const durableTrackers = new WeakSet();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function statePath(dir) {
  return join(dir, STATE_FILE_NAME);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readAudit(auditFile) {
  let raw;
  try {
    raw = await readFile(auditFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, missing: true, error: 'one-shot nonce audit is missing' };
    }
    return { ok: false, error: `unable to read one-shot nonce audit: ${error?.message || String(error)}` };
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return { ok: false, error: 'one-shot nonce audit contains invalid JSON' };
    }
    if (!isPlainObject(record) || !trimString(record.event)) {
      return { ok: false, error: 'one-shot nonce audit contains an invalid record' };
    }
    records.push(record);
  }
  return { ok: true, records };
}

async function initializeAudit(auditFile) {
  await mkdir(dirname(auditFile), { recursive: true, mode: 0o750 });
  const handle = await open(auditFile, 'a', DEFAULT_AUDIT_MODE);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(auditFile, DEFAULT_AUDIT_MODE).catch(() => {});
}

async function appendAudit(auditFile, record) {
  await mkdir(dirname(auditFile), { recursive: true, mode: 0o750 });
  const handle = await open(auditFile, 'a', DEFAULT_AUDIT_MODE);
  try {
    await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(auditFile, DEFAULT_AUDIT_MODE).catch(() => {});
}

function stateError(errorCode, message) {
  const error = new Error(message);
  error.code = errorCode;
  return error;
}

/**
 * @param {object} options
 * @param {string} options.dir Durable CAS directory.
 * @param {string} options.auditFile Dedicated or shared append-only audit.
 * @param {string} [options.errorCode] Error code used when storage cannot be
 * restored or consumed.
 * @param {string} [options.auditEvent] Event name for claims.
 */
export function createDurableOneShotNonceTracker({
  dir,
  auditFile = '',
  errorCode = 'SEMANTIC_CAPABILITY_NONCE_STATE_REQUIRED',
  auditEvent = 'semantic_capability_consumed',
} = {}) {
  const normalizedDir = trimString(dir);
  const normalizedAuditFile = trimString(auditFile) || join(normalizedDir, 'audit.jsonl');
  if (!normalizedDir) {
    throw new Error('durable one-shot nonce tracker requires a storage directory');
  }

  const store = openCapabilityGrantStore({ dir: normalizedDir });
  const seen = new Set();
  let readyError = null;

  const ready = (async () => {
    // listGrantStates validates the complete durable registry. It is not an
    // authorization decision by itself; claimGrant remains the CAS authority.
    const states = await store.listGrantStates();
    if (!states.ok) throw stateError(errorCode, states.error || 'unable to restore one-shot nonce state');
    for (const state of Object.values(states.states || {})) {
      for (const nonce of state.useNonces || []) seen.add(nonce);
    }

    const stateExists = await pathExists(statePath(normalizedDir));
    const audit = await readAudit(normalizedAuditFile);
    if (audit.missing) {
      if (stateExists) {
        throw stateError(errorCode, 'one-shot nonce audit is missing while durable usage state exists');
      }
      // Explicit first-boot initialization. A later missing audit cannot take
      // this path because the durable registry then exists.
      await initializeAudit(normalizedAuditFile);
    } else if (!audit.ok) {
      throw stateError(errorCode, audit.error || 'one-shot nonce audit cannot be restored');
    }
    return true;
  })().catch((error) => {
    readyError = error;
    throw error;
  });

  const tracker = {
    durable: true,
    ready,
    isUsed(nonce) {
      return seen.has(trimString(nonce));
    },
    async consume(nonce, binding = {}) {
      try {
        await ready;
        if (readyError) throw readyError;
        const value = trimString(nonce);
        const grantId = trimString(binding.grantId || binding.capabilityId);
        const expiresAt = binding.expiresAt;
        const now = binding.now ?? Date.now();
        if (!value || !grantId || expiresAt === undefined) {
          throw stateError(errorCode, 'one-shot nonce claim is missing its exact capability binding');
        }
        const audit = await readAudit(normalizedAuditFile);
        if (!audit.ok) {
          throw stateError(errorCode, audit.error || 'one-shot nonce audit cannot be restored');
        }
        const claim = await store.claimGrant({
          grantId,
          useNonce: value,
          usageMax: 1,
          expiresAt,
          now,
        });
        if (!claim.ok) {
          if (claim.code === 'permission_use_nonce_replay' || claim.code === 'permission_capability_usage_exhausted') return false;
          throw stateError(errorCode, claim.error || 'one-shot nonce CAS failed');
        }
        try {
          await appendAudit(normalizedAuditFile, {
            event: auditEvent,
            semanticNonce: value,
            capabilityId: grantId,
            ...(isPlainObject(binding.audit) ? binding.audit : {}),
          });
        } catch (error) {
          throw stateError(errorCode, `one-shot nonce audit append failed: ${error?.message || String(error)}`);
        }
        seen.add(value);
        return true;
      } catch (error) {
        if (error?.code === errorCode) throw error;
        throw stateError(errorCode, error?.message || String(error));
      }
    },
    snapshot() {
      return [...seen];
    },
    close() {
      store.close();
    },
  };
  durableTrackers.add(tracker);
  return tracker;
}

export function isDurableOneShotNonceTracker(value) {
  return durableTrackers.has(value);
}
