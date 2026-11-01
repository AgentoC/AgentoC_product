#!/usr/bin/env node
/**
 * Phase 2B slice 2B-1 tests for the durable capability grant store.
 *
 * Run: node tests/test-capability-grant-store.mjs
 *
 * Covers: first use ok; same useNonce replay DENY; usage budget exhaustion
 * DENY; expired grant DENY; concurrent double-claim of the same
 * (grantId, useNonce) has exactly one winner (both within one store and across
 * two store instances sharing a dir); persistence across store re-open;
 * getGrantState; invalid/unknown field fail-closed; claims after close fail
 * closed.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCapabilityGrantStore } from '../chat/capability-grant-store.mjs';
import { PERMISSION_REASON_CODES } from '../chat/permission-policy.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const C = PERMISSION_REASON_CODES;
const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const EXPIRES = NOW + 60_000;

const tempDirs = [];
async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'capability-grant-store-'));
  tempDirs.push(dir);
  return { dir, store: await openCapabilityGrantStore({ dir }) };
}

function claimArgs(grantId, useNonce, overrides = {}) {
  return { grantId, useNonce, usageMax: 3, expiresAt: EXPIRES, now: NOW, ...overrides };
}

async function main() {
  // --- first use ok ---
  {
    const { store } = await freshStore();
    const result = await store.claimGrant(claimArgs('cgrant_first', 'nonce-1'));
    eq('first claim ok', result.ok, true);
    eq('first claim consumed', result.state.consumed, 1);
    check('first claim records the nonce', result.state.useNonces.length === 1 && result.state.useNonces[0] === 'nonce-1');
  }

  // --- same useNonce replay DENY ---
  {
    const { store } = await freshStore();
    await store.claimGrant(claimArgs('cgrant_replay', 'nonce-2'));
    const replay = await store.claimGrant(claimArgs('cgrant_replay', 'nonce-2'));
    eq('replay denied', replay.ok, false);
    eq('replay reason', replay.code, C.CAPABILITY_USE_NONCE_REPLAY);
  }

  // --- usage budget exhaustion DENY ---
  {
    const { store } = await freshStore();
    const first = await store.claimGrant(claimArgs('cgrant_budget', 'n-a', { usageMax: 2 }));
    const second = await store.claimGrant(claimArgs('cgrant_budget', 'n-b', { usageMax: 2 }));
    eq('budget first use ok', first.ok, true);
    eq('budget second use ok', second.ok, true);
    const third = await store.claimGrant(claimArgs('cgrant_budget', 'n-c', { usageMax: 2 }));
    eq('budget exhausted denied', third.ok, false);
    eq('budget exhausted reason', third.code, C.CAPABILITY_USAGE_EXHAUSTED);
  }

  // --- grant budget and expiry are immutable after first use ---
  {
    const { dir, store } = await freshStore();
    const first = await store.claimGrant(claimArgs('cgrant_bound', 'n-bound-1', { usageMax: 1 }));
    eq('bound grant first use ok', first.ok, true);
    const widened = await store.claimGrant(claimArgs('cgrant_bound', 'n-bound-2', { usageMax: 2 }));
    eq('bound grant cannot widen usage budget', widened.ok, false);
    eq('widened usage budget is invalid', widened.code, C.CAPABILITY_INVALID);
    const extended = await store.claimGrant(claimArgs('cgrant_bound', 'n-bound-3', { usageMax: 1, expiresAt: EXPIRES + 1 }));
    eq('bound grant cannot extend expiry', extended.ok, false);
    eq('extended expiry is invalid', extended.code, C.CAPABILITY_INVALID);
    await store.close();
    const reopened = await openCapabilityGrantStore({ dir });
    const reopenedWidened = await reopened.claimGrant(claimArgs('cgrant_bound', 'n-bound-4', { usageMax: 2 }));
    eq('reopened grant still rejects widened budget', reopenedWidened.ok, false);
    eq('reopened widened budget is invalid', reopenedWidened.code, C.CAPABILITY_INVALID);
    await reopened.close();
  }

  // An expired first observation binds the expiry even though it does not
  // consume a nonce; retrying with a later expiry must remain denied.
  {
    const { store } = await freshStore();
    const expired = await store.claimGrant(claimArgs('cgrant_expiry_bound', 'n-expired-first', { expiresAt: NOW - 1 }));
    eq('expired first observation denied', expired.ok, false);
    eq('expired first observation reason', expired.code, C.CAPABILITY_EXPIRED);
    const extended = await store.claimGrant(claimArgs('cgrant_expiry_bound', 'n-expired-retry', { expiresAt: EXPIRES }));
    eq('expired grant cannot be extended on retry', extended.ok, false);
    eq('extended expired grant is invalid', extended.code, C.CAPABILITY_INVALID);
  }

  // --- expired grant DENY ---
  {
    const { store } = await freshStore();
    const expired = await store.claimGrant(claimArgs('cgrant_expired', 'n-exp', { expiresAt: NOW - 1 }));
    eq('expired denied', expired.ok, false);
    eq('expired reason', expired.code, C.CAPABILITY_EXPIRED);
  }

  // --- exact expiry boundary is expired (contract matches pure policy:
  // now >= expiresAt → EXPIRED; inclusive, not exclusive) ---
  {
    const { store } = await freshStore();
    const boundary = await store.claimGrant(claimArgs('cgrant_boundary', 'n-bound', { expiresAt: NOW }));
    eq('exact expiry boundary denied', boundary.ok, false);
    eq('exact expiry boundary reason', boundary.code, C.CAPABILITY_EXPIRED);
    // A claim strictly before expiry still succeeds.
    const before = await store.claimGrant(claimArgs('cgrant_boundary_before', 'n-before', { expiresAt: NOW + 1 }));
    eq('claim just before expiry ok', before.ok, true);
  }

  // --- concurrent double-claim of same (grantId, useNonce): exactly one ok ---
  {
    const { store } = await freshStore();
    const [a, b] = await Promise.all([
      store.claimGrant(claimArgs('cgrant_concurrent', 'n-conc')),
      store.claimGrant(claimArgs('cgrant_concurrent', 'n-conc')),
    ]);
    const winners = [a, b].filter((r) => r.ok === true);
    const losers = [a, b].filter((r) => r.ok === false);
    eq('concurrent exactly one winner', winners.length, 1);
    eq('concurrent exactly one loser', losers.length, 1);
    eq('concurrent loser reason', losers[0].code, C.CAPABILITY_USE_NONCE_REPLAY);
  }

  // --- two store instances on the same dir: lock keeps exactly one winner ---
  {
    const dir = await mkdtemp(join(tmpdir(), 'capability-grant-store-'));
    tempDirs.push(dir);
    const storeA = await openCapabilityGrantStore({ dir });
    const storeB = await openCapabilityGrantStore({ dir });
    const [a, b] = await Promise.all([
      storeA.claimGrant(claimArgs('cgrant_cross', 'n-cross')),
      storeB.claimGrant(claimArgs('cgrant_cross', 'n-cross')),
    ]);
    const winners = [a, b].filter((r) => r.ok === true);
    const losers = [a, b].filter((r) => r.ok === false);
    eq('cross-instance exactly one winner', winners.length, 1);
    eq('cross-instance exactly one loser', losers.length, 1);
  }

  // --- concurrent multi-grant claim sets are atomic -------------------------
  {
    const dir = await mkdtemp(join(tmpdir(), 'capability-grant-store-'));
    tempDirs.push(dir);
    const storeA = await openCapabilityGrantStore({ dir });
    const storeB = await openCapabilityGrantStore({ dir });
    const claims = [
      claimArgs('cgrant_set_a', 'n-set-a', { usageMax: 1 }),
      claimArgs('cgrant_set_b', 'n-set-b', { usageMax: 1 }),
    ];
    const [a, b] = await Promise.all([
      storeA.claimGrantSet({ claims }),
      storeB.claimGrantSet({ claims }),
    ]);
    const winners = [a, b].filter((result) => result.ok === true);
    const losers = [a, b].filter((result) => result.ok === false);
    eq('concurrent claim sets have exactly one winner', winners.length, 1);
    eq('concurrent claim sets have exactly one loser', losers.length, 1);
    eq('concurrent claim set loser reports replay', losers[0].code, C.CAPABILITY_USE_NONCE_REPLAY);
    eq('claim set winner records first grant', (await storeA.getGrantState({ grantId: 'cgrant_set_a' })).state.consumed, 1);
    eq('claim set winner records second grant', (await storeA.getGrantState({ grantId: 'cgrant_set_b' })).state.consumed, 1);
  }

  // --- an incomplete lock is never stolen ----------------------------------
  // A contender can observe the file after open('wx') but before the holder has
  // written its owner payload. That is not evidence of a stale lock.
  {
    const dir = await mkdtemp(join(tmpdir(), 'capability-grant-store-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '.usage-registry.lock'), '', 'utf8');
    const store = openCapabilityGrantStore({ dir, lockAcquireTimeoutMs: 25 });
    const result = await store.claimGrant(claimArgs('cgrant_partial_lock', 'n-partial-lock'));
    eq('incomplete lock fails closed', result.ok, false);
    eq('incomplete lock reports storage denial', result.code, C.CAPABILITY_INVALID);
  }

  // --- persistence across store re-open ---
  {
    const dir = await mkdtemp(join(tmpdir(), 'capability-grant-store-'));
    tempDirs.push(dir);
    let store = await openCapabilityGrantStore({ dir });
    const first = await store.claimGrant(claimArgs('cgrant_persist', 'n-persist'));
    eq('persist first claim ok', first.ok, true);
    await store.close();

    store = await openCapabilityGrantStore({ dir });
    const replay = await store.claimGrant(claimArgs('cgrant_persist', 'n-persist'));
    eq('persist replay denied after reopen', replay.ok, false);
    eq('persist replay reason after reopen', replay.code, C.CAPABILITY_USE_NONCE_REPLAY);
    const state = await store.getGrantState({ grantId: 'cgrant_persist' });
    eq('persist state consumed survives reopen', state.state.consumed, 1);
    check('persist state nonce survives reopen', state.state.useNonces.includes('n-persist'));
  }

  // --- getGrantState reflects consumption ---
  {
    const { store } = await freshStore();
    const before = await store.getGrantState({ grantId: 'cgrant_state' });
    eq('getGrantState initial ok', before.ok, true);
    eq('getGrantState initial consumed', before.state.consumed, 0);
    await store.claimGrant(claimArgs('cgrant_state', 'n-state'));
    const after = await store.getGrantState({ grantId: 'cgrant_state' });
    eq('getGrantState after claim consumed', after.state.consumed, 1);
    check('getGrantState after claim records nonce', after.state.useNonces.includes('n-state'));
  }

  // --- unknown/missing/invalid fields fail closed with CAPABILITY_INVALID ---
  {
    const { store } = await freshStore();
    const badInputs = [
      {},
      { grantId: 'cgrant_bad', useNonce: 'n', usageMax: 1, expiresAt: EXPIRES },
      { grantId: 'cgrant_bad', useNonce: 'n', usageMax: 1, now: NOW },
      { grantId: 'cgrant_bad', useNonce: 'n', expiresAt: EXPIRES, now: NOW },
      { grantId: 'cgrant_bad', usageMax: 1, expiresAt: EXPIRES, now: NOW },
      { grantId: 'cgrant_bad', useNonce: 'n', usageMax: 1, expiresAt: EXPIRES, now: NOW, extra: true },
      { grantId: '../escape', useNonce: 'n', usageMax: 1, expiresAt: EXPIRES, now: NOW },
      { grantId: 'cgrant/bad', useNonce: 'n', usageMax: 1, expiresAt: EXPIRES, now: NOW },
      { grantId: 'cgrant_bad', useNonce: '', usageMax: 1, expiresAt: EXPIRES, now: NOW },
      { grantId: 'cgrant_bad', useNonce: 'n', usageMax: 0, expiresAt: EXPIRES, now: NOW },
      { grantId: 'cgrant_bad', useNonce: 'n', usageMax: 1.5, expiresAt: EXPIRES, now: NOW },
      { grantId: 'cgrant_bad', useNonce: 'n', usageMax: 1, expiresAt: 'not-a-date', now: NOW },
      { grantId: 'cgrant_bad', useNonce: 'n', usageMax: 1, expiresAt: EXPIRES, now: 'not-a-date' },
      { grantId: 'cgrant_bad', useNonce: 'n', usageMax: 10001, expiresAt: EXPIRES, now: NOW },
    ];
    for (const [index, input] of badInputs.entries()) {
      const result = await store.claimGrant(input);
      eq(`invalid input ${index} denied`, result.ok, false);
      eq(`invalid input ${index} reason`, result.code, C.CAPABILITY_INVALID);
    }
  }

  // --- claims after close fail closed ---
  {
    const { store } = await freshStore();
    await store.close();
    const result = await store.claimGrant(claimArgs('cgrant_closed', 'n-closed'));
    eq('closed store claim denied', result.ok, false);
    eq('closed store claim reason', result.code, C.CAPABILITY_INVALID);
    const state = await store.getGrantState({ grantId: 'cgrant_closed' });
    eq('closed store getGrantState denied', state.ok, false);
  }

  // --- authorization material is opaque, durable, and binding-checked ------
  {
    const dir = await mkdtemp(join(tmpdir(), 'capability-grant-store-'));
    tempDirs.push(dir);
    const store = await openCapabilityGrantStore({ dir });
    const material = {
      source: 'owner',
      permissionMode: 'standard',
      capabilities: [{ grantId: 'cgrant_secret', grantProof: { kid: 'kid', sig: 'secret-signature' } }],
      factsProofs: { op: { kid: 'kid', sig: 'facts-secret' } },
      useNonces: { cgrant_secret: 'nonce-secret' },
    };
    const saved = await store.putAuthorization({
      actionId: 'aa_auth_record', sessionId: 'session-auth', runId: 'run-auth', turnId: 'turn-auth',
      authorization: material,
    });
    eq('authorization record persisted', saved.ok, true);
    check('authorization ref is opaque', /^capref_[A-Za-z0-9_-]{16,127}$/.test(saved.capabilityRef));
    const reopened = await openCapabilityGrantStore({ dir });
    const loaded = await reopened.getAuthorization({
      capabilityRef: saved.capabilityRef,
      actionId: 'aa_auth_record', sessionId: 'session-auth', runId: 'run-auth', turnId: 'turn-auth',
    });
    eq('authorization record survives reopen', loaded.ok, true);
    eq('authorization proof survives reopen', loaded.authorization.factsProofs.op.sig, 'facts-secret');
    const mismatch = await reopened.getAuthorization({ capabilityRef: saved.capabilityRef, actionId: 'aa_other' });
    eq('authorization binding mismatch denied', mismatch.ok, false);
    eq('authorization binding mismatch fail-closed', mismatch.code, C.CAPABILITY_INVALID);

    const idempotent = await reopened.putAuthorization({
      capabilityRef: saved.capabilityRef,
      actionId: 'aa_auth_record', sessionId: 'session-auth', runId: 'run-auth', turnId: 'turn-auth',
      authorization: material,
    });
    eq('identical authorization ref retry is idempotent', idempotent.ok, true);
    eq('identical authorization ref retry is marked duplicate', idempotent.duplicate, true);

    const overwrite = await reopened.putAuthorization({
      capabilityRef: saved.capabilityRef,
      actionId: 'aa_attacker', sessionId: 'session-auth', runId: 'run-auth', turnId: 'turn-auth',
      authorization: { ...material, useNonces: { cgrant_secret: 'replacement-nonce' } },
    });
    eq('authorization ref overwrite is denied', overwrite.ok, false);
    eq('authorization ref overwrite fails closed', overwrite.code, C.CAPABILITY_INVALID);
    const unchanged = await reopened.getAuthorization({
      capabilityRef: saved.capabilityRef,
      actionId: 'aa_auth_record', sessionId: 'session-auth', runId: 'run-auth', turnId: 'turn-auth',
    });
    eq('denied overwrite preserves original authorization', unchanged.authorization.useNonces.cgrant_secret, 'nonce-secret');
  }

  // --- multi-grant claim is all-or-nothing ----------------------------------
  {
    const { store } = await freshStore();
    const result = await store.claimGrantSet({ claims: [
      claimArgs('cgrant_atomic_a', 'n-a', { usageMax: 1 }),
      claimArgs('cgrant_atomic_b', 'n-b', { usageMax: 1, expiresAt: NOW - 1 }),
    ] });
    eq('multi-grant claim rejects expired member', result.ok, false);
    eq('multi-grant claim reports expiry', result.code, C.CAPABILITY_EXPIRED);
    const stateA = await store.getGrantState({ grantId: 'cgrant_atomic_a' });
    eq('failed multi-grant claim does not consume first member', stateA.state.consumed, 0);
  }

  // --- openCapabilityGrantStore rejects a missing dir (fail-closed factory) ---
  check('openCapabilityGrantStore rejects missing dir', (() => {
    try {
      openCapabilityGrantStore({});
      return false;
    } catch {
      return true;
    }
  })());

  console.log(`capability-grant-store: ${passed} checks passed`);
}

main()
  .then(() => {})
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
  });
