#!/usr/bin/env node
import assert from 'node:assert/strict';

import { generateKeyPairSync } from 'node:crypto';

import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';
import { resolveSemanticContext } from '../chat/semantic-resolver.mjs';
import {
  SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  createSemanticCapability,
  signSemanticCapability,
} from '../chat/semantic-capability.mjs';
import {
  WINDOWS_PEER_CHANNEL_ERROR,
  createWindowsPeerNonceTracker,
  validateWindowsExecutorPeerCapability,
  validateWindowsExecutorPeerConnect,
} from '../chat/semantic-windows-executor-peer.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519');

const EXPECTED_SID = 'S-1-5-21-111-222-333';
const GOOD_PEER = Object.freeze({
  platform: 'win32',
  transport: 'named-pipe',
  authenticated: true,
  sameUser: true,
  integrity: 'high',
  sid: EXPECTED_SID,
});
const EXPECTED = Object.freeze({ sid: EXPECTED_SID });

// A real signed winget capability produced by the same server pipeline the
// executor would consume: compile → server-resolved facts → ASK → sign.
const binding = { sessionId: 's_win', runId: 'r_win', turnId: 't_win', requestKey: 'req_win', executionClass: 'host' };
const trustedContext = { cwd: 'C:\\project', projectRoot: 'C:\\project', home: 'C:\\Users\\owner', platform: 'win32' };
const compile = (rawCommand) => compileSemanticOperations({ request: { ...binding, rawCommand }, trustedContext });
const packageOperation = compile('winget install --id Git.Git --exact --source winget').operations[0];
const packageResolution = await resolveSemanticContext({
  operation: packageOperation,
  options: {
    trustedContext,
    windowsFactsProvider: {
      name: 'winget-fixture',
      async packageFacts(query) {
        return {
          manager: 'winget',
          source: 'winget',
          sourceTrust: 'configured',
          repositories: [{ id: 'winget', trust: 'configured' }],
          packages: query.packages.map((name) => ({ name, requestedVersion: '', availableVersion: '2.0' })),
        };
      },
    },
  },
});
const packageDecision = evaluateSemanticOperation(packageOperation, packageResolution);
eq('fixture decision is ASK', packageDecision.decision, 'ASK');
const unsigned = createSemanticCapability({
  selectedDecisions: [packageDecision],
  adapter: SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  sessionId: 's_win', runId: 'r_win', turnId: 't_win', credentialId: 'cred_win', kid: 'kid_win', now: NOW,
});
const signedCapability = signSemanticCapability(unsigned, keys.privateKey);

// ── connect-time peer identity (validateWindowsPeerIdentity wiring) ───────────

const accepted = validateWindowsExecutorPeerConnect(GOOD_PEER, EXPECTED);
eq('good peer connect is admitted', accepted.ok, true);
eq('connect returns verified SID', accepted.peer.sid, EXPECTED_SID);
eq('connect binds channel version', accepted.peer.channelVersion, 'windows-executor-peer/v1');

eq('non-named-pipe transport denies connect',
  validateWindowsExecutorPeerConnect({ ...GOOD_PEER, transport: 'unix' }, EXPECTED).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_TRANSPORT_UNSUPPORTED);
eq('SID mismatch denies connect',
  validateWindowsExecutorPeerConnect({ ...GOOD_PEER, sid: 'S-1-5-21-999' }, EXPECTED).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_IDENTITY_MISMATCH);
eq('missing expected SID denies connect',
  validateWindowsExecutorPeerConnect(GOOD_PEER, {}).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_IDENTITY_MISMATCH);
eq('unauthenticated peer denies connect',
  validateWindowsExecutorPeerConnect({ ...GOOD_PEER, authenticated: false }, EXPECTED).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_IDENTITY_UNVERIFIED);
eq('different-user peer denies connect',
  validateWindowsExecutorPeerConnect({ ...GOOD_PEER, sameUser: false }, EXPECTED).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_IDENTITY_UNVERIFIED);
eq('non-high-integrity peer denies connect',
  validateWindowsExecutorPeerConnect({ ...GOOD_PEER, integrity: 'medium' }, EXPECTED).code,
  WINDOWS_PEER_CHANNEL_ERROR.PEER_IDENTITY_UNVERIFIED);

// ── exec-time capability gate ─────────────────────────────────────────────────

const okRevalidate = async () => ({ ok: true, code: '' });
const targetSwapped = async () => ({
  ok: false,
  code: 'WINDOWS_FACTS_REVALIDATION_FAILED',
  error: 'winget target or repository metadata changed',
});

const gate = await validateWindowsExecutorPeerCapability({
  capability: signedCapability,
  facts: GOOD_PEER,
  expected: EXPECTED,
  publicKey: keys.publicKey,
  now: NOW,
  nonceState: createWindowsPeerNonceTracker(),
  revalidate: okRevalidate,
});
eq('valid capability with verified peer is admitted', gate.ok, true);
eq('admitted gate returns peer SID', gate.peer, EXPECTED_SID);

// Replay: the same signed one-shot nonce cannot be used twice.
const tracker = createWindowsPeerNonceTracker();
const first = await validateWindowsExecutorPeerCapability({
  capability: signedCapability, facts: GOOD_PEER, expected: EXPECTED, publicKey: keys.publicKey, now: NOW,
  nonceState: tracker,
  revalidate: okRevalidate,
});
check('one-shot gate consumes the nonce', first.ok && tracker.isUsed(signedCapability.nonce));
const replay = await validateWindowsExecutorPeerCapability({
  capability: signedCapability, facts: GOOD_PEER, expected: EXPECTED, publicKey: keys.publicKey, now: NOW,
  nonceState: tracker,
  revalidate: okRevalidate,
});
eq('replayed nonce is denied', replay.code, WINDOWS_PEER_CHANNEL_ERROR.NONCE_REUSED);

// TTL expiry: a signed capability cannot outlive its bounded TTL.
const expired = await validateWindowsExecutorPeerCapability({
  capability: signedCapability, facts: GOOD_PEER, expected: EXPECTED, publicKey: keys.publicKey,
  now: Date.parse(signedCapability.expiresAt),
  nonceState: createWindowsPeerNonceTracker(),
  revalidate: okRevalidate,
});
eq('expired capability is denied', expired.code, WINDOWS_PEER_CHANNEL_ERROR.CAPABILITY_TTL_EXPIRED);

// Target swap: the resource approved at policy time changed before dispatch.
const swapped = await validateWindowsExecutorPeerCapability({
  capability: signedCapability, facts: GOOD_PEER, expected: EXPECTED, publicKey: keys.publicKey, now: NOW,
  nonceState: createWindowsPeerNonceTracker(),
  revalidate: targetSwapped,
});
eq('target-swap revalidation is denied', swapped.code, 'WINDOWS_FACTS_REVALIDATION_FAILED');

// The gate re-verifies peer identity on every request (no mid-channel swap).
const peerSwapped = await validateWindowsExecutorPeerCapability({
  capability: signedCapability,
  facts: { ...GOOD_PEER, sid: 'S-1-5-21-999' },
  expected: EXPECTED,
  publicKey: keys.publicKey,
  now: NOW,
  nonceState: createWindowsPeerNonceTracker(),
  revalidate: okRevalidate,
});
eq('peer identity drift denies the request', peerSwapped.code, WINDOWS_PEER_CHANNEL_ERROR.PEER_IDENTITY_MISMATCH);

// Fail-closed: a capability gate without a revalidation source refuses.
const noRevalidate = await validateWindowsExecutorPeerCapability({
  capability: signedCapability, facts: GOOD_PEER, expected: EXPECTED, publicKey: keys.publicKey, now: NOW,
  nonceState: createWindowsPeerNonceTracker(),
});
eq('missing revalidation denies the request', noRevalidate.code, WINDOWS_PEER_CHANNEL_ERROR.REVALIDATION_REQUIRED);

// Fail-closed: the executor cannot fall back to a non-atomic or absent nonce
// store, even when the signature and peer identity are valid.
const noNonceState = await validateWindowsExecutorPeerCapability({
  capability: signedCapability, facts: GOOD_PEER, expected: EXPECTED, publicKey: keys.publicKey, now: NOW,
  revalidate: okRevalidate,
});
eq('missing atomic nonce state denies the request', noNonceState.code, WINDOWS_PEER_CHANNEL_ERROR.NONCE_STATE_REQUIRED);

// Fail-closed: a request without a signed capability refuses.
const noCapability = await validateWindowsExecutorPeerCapability({
  facts: GOOD_PEER, expected: EXPECTED, now: NOW, revalidate: okRevalidate,
});
eq('missing capability denies the request', noCapability.code, WINDOWS_PEER_CHANNEL_ERROR.CAPABILITY_REQUIRED);

console.log(`semantic-windows-peer-channel: ${passed} checks passed`);
