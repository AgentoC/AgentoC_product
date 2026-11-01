// install-auto quota persistence (design §5.3; P3 hardening slice).
//
// privileged-quota.json holds a mutable sliding-window counter for install-auto
// operations. The pure window decision lives in checkInstallQuota
// (chat/privileged-ops.mjs); this module adds the durable state file so quota
// counts survive chat-server restarts. Written atomically (writeJsonAtomic) and
// mode-restricted to 0600 — the file itself is not secret, but it lives next
// to signing keys in the config dir and defaults must not widen permissions.
//
// Window semantics: a fresh window starts on the first use after
// (windowStartedAtMs + windowMs); uses within the same window are capped by
// `max`. The counter is incremented when an install-auto token is minted, so
// the check-and-record pair in the mint path is the authoritative gate.

import { readJson, writeJsonAtomic } from './fs-utils.mjs';
import { checkInstallQuota } from './privileged-ops.mjs';

export const INSTALL_AUTO_QUOTA_MAX_DEFAULT = 5;
export const INSTALL_AUTO_QUOTA_WINDOW_MS_DEFAULT = 60 * 60 * 1000;

const QUOTA_STATE_VERSION = 1;

function sanitizeState(value, now) {
  const count = Math.max(0, Number(value?.count) || 0);
  const windowStartedAtMs = Number(value?.windowStartedAtMs) || now;
  return { count, windowStartedAtMs };
}

// Read the durable counter state; missing/corrupt state falls back to an
// empty window starting now (count 0 → first use allowed).
export async function loadInstallQuotaState(filePath, { now = Date.now() } = {}) {
  const raw = await readJson(filePath, null);
  return sanitizeState(raw, now);
}

// Pure window reset decision: is `now` past the end of the current window?
export function installQuotaWindowExpired({ windowStartedAtMs, windowMs }, now = Date.now()) {
  return now - Number(windowStartedAtMs || 0) >= Math.max(0, Number(windowMs) || 0);
}

// Record one install-auto use, applying sliding-window reset first. Returns
// the new counter state. Atomic write via writeJsonAtomic (tmp + rename).
export async function recordInstallQuotaUse(filePath, { now = Date.now(), max, windowMs } = {}) {
  const state = await loadInstallQuotaState(filePath, { now });
  const window = Math.max(0, Number(windowMs) || INSTALL_AUTO_QUOTA_WINDOW_MS_DEFAULT);
  const next = installQuotaWindowExpired({ windowStartedAtMs: state.windowStartedAtMs, windowMs: window }, now)
    ? { count: 1, windowStartedAtMs: now }
    : { count: state.count + 1, windowStartedAtMs: state.windowStartedAtMs };
  await writeJsonAtomic(filePath, {
    version: QUOTA_STATE_VERSION,
    count: next.count,
    windowStartedAtMs: next.windowStartedAtMs,
    updatedAt: new Date(now).toISOString(),
  }, { mode: 0o600 });
  return checkInstallQuota({ count: next.count, max, windowMs: window });
}

// Durable check-and-record gate for the mint path: returns the quota verdict
// WITHOUT recording (caller records only when it proceeds to mint), or the
// recorded verdict when `record: true`. Mirrors the pure checkInstallQuota
// shape so callers can branch on `allowed` uniformly.
export async function checkInstallQuotaFile(filePath, { now = Date.now(), max, windowMs, record = false } = {}) {
  const window = Math.max(0, Number(windowMs) || INSTALL_AUTO_QUOTA_WINDOW_MS_DEFAULT);
  if (record) {
    return recordInstallQuotaUse(filePath, { now, max, windowMs: window });
  }
  const state = await loadInstallQuotaState(filePath, { now });
  const count = installQuotaWindowExpired({ windowStartedAtMs: state.windowStartedAtMs, windowMs: window }, now)
    ? 0
    : state.count;
  return checkInstallQuota({ count, max, windowMs: window });
}
