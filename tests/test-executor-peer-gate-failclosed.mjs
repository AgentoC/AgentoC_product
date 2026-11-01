#!/usr/bin/env node
/**
 * Security-review §10.3 regression: the executor-peer gate must fail closed
 * when no trusted transport has resolved peer facts, and it must never be fed
 * caller-declared facts by the dispatch path.
 *
 * The gate (validateWindowsExecutorPeerConnect) is a pure fact validator: it
 * returns ok only for a well-formed, OS-resolved peer (win32 / named-pipe /
 * authenticated / same-user / high-integrity / expected SID). The security
 * boundary is that scripts/privileged-executor.mjs supplies the facts — it now
 * passes none (DENY) rather than trusting request.peer from the request body.
 */

import assert from 'node:assert/strict';

import {
  WINDOWS_PEER_CHANNEL_ERROR,
  validateWindowsExecutorPeerConnect,
} from '../chat/semantic-windows-executor-peer.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const EXPECTED_SID = 'S-1-5-21-111-222-333-1001';

// 1. No trusted transport -> no peer facts -> DENY (transport unsupported).
//    This is the default the dispatch path now relies on.
eq('no peer facts denies',
  validateWindowsExecutorPeerConnect({}, { sid: EXPECTED_SID }).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_TRANSPORT_UNSUPPORTED);

// 2. A caller guessing the expected SID but omitting the named-pipe transport
//    contract is still denied — the gate validates every fact, not just the SID.
eq('non-named-pipe transport denies even with correct SID',
  validateWindowsExecutorPeerConnect({
    platform: 'win32', transport: 'unix',
    authenticated: true, sameUser: true, integrity: 'high', sid: EXPECTED_SID,
  }, { sid: EXPECTED_SID }).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_TRANSPORT_UNSUPPORTED);

// 3. Identity still checked: forged SID denies even when every other fact is
//    present and the transport is named-pipe.
eq('forged SID mismatch denies',
  validateWindowsExecutorPeerConnect({
    platform: 'win32', transport: 'named-pipe',
    authenticated: true, sameUser: true, integrity: 'high', sid: 'S-1-5-21-999',
  }, { sid: EXPECTED_SID }).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_IDENTITY_MISMATCH);

// 4. A fully well-formed peer (as a trusted transport would resolve) passes.
//    Documents that the gate itself is a fact validator, not a transport —
//    the boundary is that scripts/privileged-executor.mjs only ever feeds it
//    facts resolved by the trusted adapter, never request.peer.
check('well-formed OS-resolved peer passes',
  validateWindowsExecutorPeerConnect({
    platform: 'win32', transport: 'named-pipe',
    authenticated: true, sameUser: true, integrity: 'high', sid: EXPECTED_SID,
  }, { sid: EXPECTED_SID }).ok === true);

console.log(`executor-peer-gate-failclosed: ${passed} checks passed`);
