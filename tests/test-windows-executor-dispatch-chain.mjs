#!/usr/bin/env node
/**
 * Unit contract for the Windows named-pipe executor semantic dispatch module
 * (chat/windows-executor-dispatch.mjs): signed capability verification ->
 * one-shot nonce -> target revalidation -> fixed-argv exec. The real Windows
 * transport is covered by the live test; these checks mock the revalidate/exec
 * seams and lock the fail-closed chain.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { compileSemanticOperations } from '../chat/semantic-compiler.mjs';
import { evaluateSemanticOperation } from '../chat/semantic-policy.mjs';
import { resolveSemanticContext } from '../chat/semantic-resolver.mjs';
import {
  SEMANTIC_ADAPTER_APT_INSTALL_V1,
  SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  createSemanticCapability,
  signSemanticCapability,
} from '../chat/semantic-capability.mjs';
import { computeSemanticManifestHash } from '../chat/semantic-operation.mjs';
import {
  createWindowsNonceTracker,
  dispatchWindowsSemanticExec,
} from '../chat/windows-executor-dispatch.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const NOW = Date.parse('2026-08-12T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const kid = 'kid_win_test';

// Capabilities are signed at a fixed NOW and bounded to a 60s TTL, so every
// dispatch must verify at the same clock.
//
// Phase 2B-5 makes the policy gate mandatory fail-closed, so the chain
// fixture defaults every dispatch to a passing Phase 2A gate (the gate's own
// behavior is covered by test-windows-executor-policy-gate.mjs). A call can
// override by passing `policyGate: null` (or omit it via a direct call) to
// exercise the no-gate fail-closed path.
const passingGate = async () => ({ ok: true, code: 'permission_capability_matched', decision: 'ALLOW', reasons: [] });
const dispatch = (options) => dispatchWindowsSemanticExec({
  now: NOW,
  policyGate: passingGate,
  policyContext: { operation: packageDecision?.operation },
  ...options,
});

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
const unsigned = createSemanticCapability({
  selectedDecisions: [packageDecision],
  adapter: SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  sessionId: 's_win', runId: 'r_win', turnId: 't_win', credentialId: 'cred_win', kid, now: NOW,
});
const signedCapability = signSemanticCapability(unsigned, keys.privateKey);

const publicKeyByKid = async (inputKid) => (inputKid === kid ? keys.publicKey : null);
const okRevalidate = async () => ({
  ok: true,
  code: '',
  invocation: { executable: 'C:\\Windows\\System32\\where.exe', argv: ['notepad'], cwd: 'C:\\' },
});
const okExec = async () => ({ ok: true, code: '', result: { exitCode: 0, stdout: 'C:\\Windows\\System32\\notepad.exe', stderr: '' } });
const badRevalidate = async () => ({ ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: 'winget metadata changed' });
const failExec = async () => ({ ok: false, code: 'WINDOWS_EXECUTOR_EXEC_FAILED', error: 'spawn failed', result: { exitCode: 1, stdout: '', stderr: 'boom' } });

// ── happy path ─────────────────────────────────────────────────────────────────

const happy = await dispatch({
  request: { capability: signedCapability },
  publicKeyByKid,
  revalidate: okRevalidate,
  execInvocation: okExec,
  nonceState: createWindowsNonceTracker(),
});
check('valid capability with verified signature admits', happy.ok === true);

// ── missing capability fails closed ────────────────────────────────────────────

const noCap = await dispatch({ request: {}, publicKeyByKid, revalidate: okRevalidate, execInvocation: okExec });
eq('missing capability DENYs', noCap.code, 'SEMANTIC_CAPABILITY_REQUIRED');

// ── unknown key fails closed ───────────────────────────────────────────────────

const unknownKey = await dispatch({
  request: { capability: { ...signedCapability, kid: 'kid_unknown' } },
  publicKeyByKid,
  revalidate: okRevalidate,
  execInvocation: okExec,
});
eq('unknown signing key DENYs', unknownKey.code, 'SEMANTIC_CAPABILITY_SIGNATURE_INVALID');

// ── tampered capability fails closed ───────────────────────────────────────────

const tampered = await dispatch({
  request: { capability: { ...signedCapability, sessionId: 's_forged' } },
  publicKeyByKid,
  revalidate: okRevalidate,
  execInvocation: okExec,
});
check('tampered capability DENYs (signature or binding check)', tampered.ok === false);

// ── nonce reuse fails closed ───────────────────────────────────────────────────

const tracker = createWindowsNonceTracker();
const first = await dispatch({
  request: { capability: signedCapability },
  publicKeyByKid,
  revalidate: okRevalidate,
  execInvocation: okExec,
  nonceState: tracker,
});
check('first dispatch consumes the nonce', first.ok && tracker.isUsed(signedCapability.nonce));
const replay = await dispatch({
  request: { capability: signedCapability },
  publicKeyByKid,
  revalidate: okRevalidate,
  execInvocation: okExec,
  nonceState: tracker,
});
eq('replayed nonce DENYs', replay.code, 'SEMANTIC_CAPABILITY_CONSUMED');

// ── revalidation failure fails closed before exec ──────────────────────────────

let execRan = false;
const revalFail = await dispatch({
  request: { capability: signedCapability },
  publicKeyByKid,
  revalidate: badRevalidate,
  execInvocation: async () => { execRan = true; return okExec(); },
  nonceState: createWindowsNonceTracker(),
});
eq('revalidation failure DENYs', revalFail.code, 'WINDOWS_REVALIDATION_FAILED');
check('exec never runs after revalidation failure', execRan === false);

// ── exec failure is surfaced but fails closed ──────────────────────────────────

const execFail = await dispatch({
  request: { capability: signedCapability },
  publicKeyByKid,
  revalidate: okRevalidate,
  execInvocation: failExec,
  nonceState: createWindowsNonceTracker(),
});
eq('exec failure DENYs with exec code', execFail.code, 'WINDOWS_EXECUTOR_EXEC_FAILED');

// ── the exec invocation comes from revalidation, never the request ─────────────

let seenInvocation = null;
await dispatch({
  request: { capability: signedCapability, invocationHint: { executable: 'C:\\evil.exe', argv: ['pwn'] } },
  publicKeyByKid,
  revalidate: okRevalidate,
  execInvocation: async (invocation) => { seenInvocation = invocation; return okExec(); },
  nonceState: createWindowsNonceTracker(),
});
check('exec uses the revalidation invocation, not the request',
  seenInvocation?.executable === 'C:\\Windows\\System32\\where.exe');

// The signed capability and the Phase 2A policy envelope are separate inputs
// at this boundary. A policy grant for another package must never authorize
// execution of the package carried by the signed capability.
let crossResourceRevalidateRan = false;
let crossResourceExecRan = false;
const crossResourceOperation = JSON.parse(JSON.stringify(packageDecision.operation));
crossResourceOperation.target.packages = ['7zip.7zip'];
crossResourceOperation.target.resourceSnapshot.packages = [{
  name: '7zip.7zip', requestedVersion: '', availableVersion: '2.0',
}];
const crossResource = await dispatch({
  policyContext: { operation: crossResourceOperation },
  policyGate: passingGate,
  request: { capability: signedCapability },
  publicKeyByKid,
  revalidate: async () => { crossResourceRevalidateRan = true; return okRevalidate(); },
  execInvocation: async () => { crossResourceExecRan = true; return okExec(); },
  nonceState: createWindowsNonceTracker(),
});
eq('cross-resource policy operation DENYs before dispatch', crossResource.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');
check('cross-resource mismatch never reaches target revalidation', crossResourceRevalidateRan === false);
check('cross-resource mismatch never reaches exec', crossResourceExecRan === false);

// Windows dispatch must not become a generic executor for a signed Linux
// capability merely because a custom gate returns ALLOW.
const linuxOperation = JSON.parse(JSON.stringify(packageDecision.operation));
linuxOperation.target.platform = 'linux';
linuxOperation.target.manager = 'apt';
linuxOperation.target.source = 'trusted_repository';
linuxOperation.target.packages = ['git'];
linuxOperation.target.resourceSnapshot.manager = 'apt';
linuxOperation.target.resourceSnapshot.source = 'trusted_repository';
linuxOperation.target.resourceSnapshot.packages = [{ name: 'git', requestedVersion: '', availableVersion: '2.0' }];
linuxOperation.target.resourceSnapshot.repositories = [{ id: 'ubuntu', trust: 'configured' }];
linuxOperation.scope.manager = 'apt';
linuxOperation.scope.source = 'trusted_repository';
linuxOperation.scope.packages = linuxOperation.target.resourceSnapshot.packages;
linuxOperation.scope.repositories = linuxOperation.target.resourceSnapshot.repositories;
const linuxCapability = signSemanticCapability(createSemanticCapability({
  selectedDecisions: [{
    operation: linuxOperation,
    decision: 'ASK',
    operationManifestHash: computeSemanticManifestHash(linuxOperation),
  }],
  adapter: SEMANTIC_ADAPTER_APT_INSTALL_V1,
  sessionId: binding.sessionId,
  runId: binding.runId,
  turnId: binding.turnId,
  credentialId: 'cred_linux',
  kid,
  now: NOW,
}), keys.privateKey);
let crossPlatformRevalidateRan = false;
const crossPlatform = await dispatchWindowsSemanticExec({
  request: { capability: linuxCapability },
  publicKeyByKid,
  policyGate: passingGate,
  policyContext: { operation: linuxOperation },
  revalidate: async () => { crossPlatformRevalidateRan = true; return okRevalidate(); },
  execInvocation: okExec,
  nonceState: createWindowsNonceTracker(),
  now: NOW,
});
eq('Linux apt capability DENYs on Windows dispatch', crossPlatform.code, 'SEMANTIC_CAPABILITY_ADAPTER_DENIED');
check('cross-platform capability never reaches target revalidation', crossPlatformRevalidateRan === false);

// ── Phase 2B-5: no policy gate is fail-closed (POLICY_GATE_REQUIRED) ───────────

let noGateExecRan = false;
let noGateRevalidateRan = false;
const noGateTracker = createWindowsNonceTracker();
const noGate = await dispatchWindowsSemanticExec({
  request: { capability: signedCapability },
  publicKeyByKid,
  revalidate: async () => { noGateRevalidateRan = true; return okRevalidate(); },
  execInvocation: async () => { noGateExecRan = true; return okExec(); },
  nonceState: noGateTracker,
  now: NOW,
  // No policyGate and no policyContext on a host-capable dispatch.
});
eq('host-capable dispatch with no gate DENYs with POLICY_GATE_REQUIRED', noGate.code, 'permission_policy_gate_required');
check('no-gate dispatch never reaches revalidation', noGateRevalidateRan === false);
check('no-gate dispatch never reaches exec', noGateExecRan === false);
check('no-gate dispatch does not consume the one-shot nonce', noGateTracker.isUsed(signedCapability.nonce) === false);

console.log(`windows-executor-dispatch-chain: ${passed} checks passed`);
