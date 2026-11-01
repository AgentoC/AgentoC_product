#!/usr/bin/env node
/**
 * Phase 2B-5: Phase 2A permission policy gate on the Windows dispatch chain
 * (chat/windows-executor-dispatch.mjs).
 *
 * The signed semantic-capability chain (signature -> nonce -> revalidation ->
 * fixed-argv exec) is preserved, and an additional authoritative Phase 2A
 * policy gate runs after the signature verifies and immediately before target
 * revalidation/exec. The gate is fail-closed:
 *
 *   - a host-capable Windows operation with no server-computed facts envelope,
 *     or with facts but no trusted resolver proof, is DENIED;
 *   - a valid signed facts proof WITHOUT an exact matching Phase 2A capability
 *     is ASK at most (the executor never proceeds);
 *   - an exact matching Phase 2A capability ALLOWs and the dispatch proceeds;
 *   - platform/executionClass smuggling is DENIED;
 *   - the existing signature/nonce/revalidation chain still runs in order when
 *     the gate passes.
 */

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
  buildWindowsDispatchPermissionFacts,
  createWindowsDispatchPolicyGate,
  createWindowsNonceTracker,
  defaultWindowsDispatchPolicyGate,
  dispatchWindowsSemanticExec,
} from '../chat/windows-executor-dispatch.mjs';
import {
  CAPABILITY_WORKLOAD_SCOPES,
  PERMISSION_MODES,
  PERMISSION_REASON_CODES,
  createCapabilityGrant,
} from '../chat/permission-policy.mjs';
import {
  createCapabilityGrantProof,
  createPermissionFactsProof,
  createPermissionProofVerifier,
} from '../chat/permission-proof-verifier.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

// ── server fixture: a real signed win32 winget semantic capability ─────────────

const NOW = Date.parse('2026-08-12T00:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const kid = 'kid_win_policy';
const binding = { sessionId: 's_win_policy', runId: 'r_win_policy', turnId: 't_win_policy', requestKey: 'req_win_policy', executionClass: 'host' };
const trustedContext = { cwd: 'C:\\project', projectRoot: 'C:\\project', home: 'C:\\Users\\owner', platform: 'win32' };
const compile = (rawCommand) => compileSemanticOperations({ request: { ...binding, rawCommand }, trustedContext });
const packageOperation = compile('winget install --id Git.Git --exact --source winget').operations[0];
// A server resolver marks complete effect enumeration before minting a
// Phase 2A capability; buildPermissionFacts requires it.
packageOperation.analysis.effectsComplete = true;
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
const resolvedOperation = packageDecision.operation;
eq('server decision for winget install is ASK', packageDecision.decision, 'ASK');

const unsigned = createSemanticCapability({
  selectedDecisions: [packageDecision],
  adapter: SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  sessionId: 's_win_policy', runId: 'r_win_policy', turnId: 't_win_policy', credentialId: 'cred_win_policy', kid, now: NOW,
});
const signedCapability = signSemanticCapability(unsigned, keys.privateKey);
const publicKeyByKid = async (inputKid) => (inputKid === kid ? keys.publicKey : null);
const okRevalidate = async () => ({
  ok: true,
  code: '',
  invocation: { executable: 'C:\\Windows\\System32\\where.exe', argv: ['notepad'], cwd: 'C:\\' },
});
const okExec = async () => ({ ok: true, code: '', result: { exitCode: 0, stdout: 'C:\\Windows\\System32\\notepad.exe', stderr: '' } });

// Server-computed facts derived ONLY from the capability's bound operation /
// resolver snapshot / Windows facts (never requester-declared).
const serverFacts = buildWindowsDispatchPermissionFacts(resolvedOperation, signedCapability);
check('server facts derive the win32 resource from the capability', serverFacts.resource.manager === 'winget');
check('server facts carry the resolver snapshot identity', typeof serverFacts.resourceSnapshotIdentity === 'string' && serverFacts.resourceSnapshotIdentity.length > 0);

// Trusted proof verifier (Phase 2B-2) + server-signed facts proof + grant proof.
const proofKeys = generateKeyPairSync('ed25519');
const factsKid = 'kid_facts_win';
const verifier = createPermissionProofVerifier({ publicKeyByKid: { [factsKid]: proofKeys.publicKey }, now: NOW });
const signedFacts = createPermissionFactsProof({
  operation: resolvedOperation,
  facts: serverFacts,
  privateKey: proofKeys.privateKey,
  kid: factsKid,
  now: NOW,
  ttlMs: 15 * 60 * 1000,
});
check('signed facts proof verifies under the trusted verifier', verifier.verifyFactsProof(resolvedOperation, signedFacts) === true);

const grant = createCapabilityGrant({
  mode: PERMISSION_MODES.STANDARD,
  issuedAtTurn: 'turn-approval-win',
  issuedAt: new Date(NOW),
  ttlMs: 15 * 60 * 1000,
  usageMax: 1,
  workload: {
    scope: CAPABILITY_WORKLOAD_SCOPES.RUN,
    sessionId: resolvedOperation.requestBinding.sessionId,
    runId: resolvedOperation.requestBinding.runId,
    turnBinding: 'provenance',
  },
  constraints: {
    action: resolvedOperation.primaryAction,
    scope: serverFacts.scope,
    resourceSnapshotIdentity: serverFacts.resourceSnapshotIdentity,
    executionClass: serverFacts.executionClass,
    impact: {
      reversible: serverFacts.impact.reversible,
      containsSensitiveMaterial: serverFacts.impact.containsSensitiveMaterial,
      containsGitMetadata: serverFacts.impact.containsGitMetadata,
    },
    target: resolvedOperation.target,
    targetFlags: { recursive: false, force: false, exact: serverFacts.selection.exact === true },
    resource: serverFacts.resource,
    selection: serverFacts.selection,
    effects: { subset: resolvedOperation.effects },
  },
  grantProof: 'owner-proof-win',
});
const signedGrant = createCapabilityGrantProof({ grant, privateKey: proofKeys.privateKey, kid: factsKid, now: NOW, ttlMs: 15 * 60 * 1000 });
check('signed grant proof verifies under the trusted verifier', verifier.verifyGrantProof(signedGrant) === true);

// ── 1. host-capable Windows capability with no facts/proof → DENY (fail closed) ──

// 1a: facts present but no trusted resolver proof.
{
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyContext: { operation: resolvedOperation, facts: serverFacts, mode: PERMISSION_MODES.STANDARD },
  });
  eq('host-capable with facts but no trusted proof DENYs', dispatchResult.ok, false);
  eq('...reason is FACTS_PROOF_REQUIRED', dispatchResult.code, PERMISSION_REASON_CODES.FACTS_PROOF_REQUIRED);
}

// 1b: no server-computed facts envelope at all (explicit fail-closed gate).
{
  let revalidateRan = false;
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => { revalidateRan = true; return okRevalidate(); },
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyGate: createWindowsDispatchPolicyGate(),
  });
  eq('host-capable with no facts envelope DENYs', dispatchResult.ok, false);
  eq('...reason is FACTS_REQUIRED', dispatchResult.code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
  check('a denied gate never reaches target revalidation', revalidateRan === false);
}

// A custom gate is not an authorization bypass: it still needs the same
// server-computed operation binding before it can return ALLOW.
{
  let revalidateRan = false;
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => { revalidateRan = true; return okRevalidate(); },
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyGate: async () => ({ ok: true, decision: 'ALLOW' }),
  });
  eq('custom gate without server operation context DENYs', dispatchResult.ok, false);
  eq('...custom gate bypass is FACTS_REQUIRED', dispatchResult.code, PERMISSION_REASON_CODES.FACTS_REQUIRED);
  check('custom gate without context never reaches target revalidation', revalidateRan === false);
}

// 1c: a denied gate must not consume the one-shot nonce.
{
  const tracker = createWindowsNonceTracker();
  await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: tracker,
    now: NOW,
    policyContext: { operation: resolvedOperation },
    policyGate: createWindowsDispatchPolicyGate(),
  });
  check('denied gate does not consume the one-shot nonce', tracker.isUsed(signedCapability.nonce) === false);
}

// 1d: the default gate is fail-closed on its own (STANDARD, no verifier/proof).
{
  const gateResult = await defaultWindowsDispatchPolicyGate({ operation: resolvedOperation, facts: serverFacts, now: NOW });
  eq('default gate without a verifier fails closed', gateResult.ok, false);
  eq('...reason is FACTS_PROOF_REQUIRED', gateResult.code, PERMISSION_REASON_CODES.FACTS_PROOF_REQUIRED);
}

// 1e: non-revalidatable host effect fails closed.
{
  const nonRevalidatableFacts = JSON.parse(JSON.stringify(serverFacts));
  nonRevalidatableFacts.hostEffects = { dynamic: false, revalidatable: false };
  const gateResult = await defaultWindowsDispatchPolicyGate({ operation: resolvedOperation, facts: nonRevalidatableFacts, now: NOW });
  eq('non-revalidatable host effect DENYs', gateResult.ok, false);
  eq('...reason is NON_REVALIDATABLE_HOST_EFFECT', gateResult.code, PERMISSION_REASON_CODES.NON_REVALIDATABLE_HOST_EFFECT);
}

// ── 2. valid signed facts proof + no matching Phase 2A capability → ASK at most ──

{
  let execRan = false;
  const tracker = createWindowsNonceTracker();
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: async () => { execRan = true; return okExec(); },
    nonceState: tracker,
    now: NOW,
    policyContext: {
      operation: resolvedOperation,
      facts: signedFacts,
      mode: PERMISSION_MODES.STANDARD,
      verifyFactsProof: verifier.verifyFactsProof,
      verifyGrantProof: verifier.verifyGrantProof,
    },
  });
  eq('valid proof without an exact capability is ASK at most', dispatchResult.ok, false);
  eq('...reason is ASK_DEFAULT', dispatchResult.code, PERMISSION_REASON_CODES.ASK_DEFAULT);
  check('ASK never reaches exec', execRan === false);
  check('ASK does not consume the one-shot nonce', tracker.isUsed(signedCapability.nonce) === false);
}

// ── 3. exact matching Phase 2A capability → proceeds through the chain ─────────

{
  let execRan = false;
  const tracker = createWindowsNonceTracker();
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: async () => { execRan = true; return okExec(); },
    nonceState: tracker,
    now: NOW,
    policyContext: {
      operation: resolvedOperation,
      facts: signedFacts,
      mode: PERMISSION_MODES.STANDARD,
      capability: signedGrant,
      verifyFactsProof: verifier.verifyFactsProof,
      verifyGrantProof: verifier.verifyGrantProof,
      useNonce: 'use-win-1',
    },
  });
  check('exact matching Phase 2A capability proceeds through the gate', dispatchResult.ok === true);
  check('exec runs only when the gate ALLOWs', execRan === true);
  check('the capability nonce is consumed after a granted dispatch', tracker.isUsed(signedCapability.nonce) === true);
}

// ── 4. platform / executionClass smuggling → DENY ──────────────────────────────

// 4a: re-resolved operation claims a non-win32 platform on a win32 capability.
{
  const smuggledOperation = JSON.parse(JSON.stringify(resolvedOperation));
  smuggledOperation.target.platform = 'linux';
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyContext: { operation: smuggledOperation, mode: PERMISSION_MODES.STANDARD },
  });
  eq('platform smuggling (linux target on a win32 capability) DENYs', dispatchResult.ok, false);
  eq('...fails closed with capability revalidation failure', dispatchResult.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');
}

// 4b: re-resolved operation claims a non-host executionClass.
{
  const smuggledOperation = JSON.parse(JSON.stringify(resolvedOperation));
  smuggledOperation.executionClass = 'session';
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyContext: { operation: smuggledOperation, mode: PERMISSION_MODES.STANDARD },
  });
  eq('executionClass smuggling (session on a host capability) DENYs', dispatchResult.ok, false);
  eq('...fails closed with capability revalidation failure', dispatchResult.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');
}

// ── 5. existing chain (signature/nonce/revalidation/exec) still runs in order ──

{
  const order = [];
  const tracker = createWindowsNonceTracker();
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => { order.push('revalidate'); return okRevalidate(); },
    execInvocation: async () => { order.push('exec'); return okExec(); },
    nonceState: {
      isUsed: (nonce) => { order.push('nonce:isUsed'); return tracker.isUsed(nonce); },
      consume: (nonce) => { order.push('nonce:consume'); return tracker.consume(nonce); },
      snapshot: () => tracker.snapshot(),
    },
    now: NOW,
    policyContext: {
      operation: resolvedOperation,
      facts: signedFacts,
      mode: PERMISSION_MODES.STANDARD,
      capability: signedGrant,
      verifyFactsProof: verifier.verifyFactsProof,
      verifyGrantProof: verifier.verifyGrantProof,
      useNonce: 'use-win-2',
    },
  });
  check('gate passes for an exact matching capability', dispatchResult.ok === true);
  check('existing nonce/revalidation/exec order is preserved with the gate',
    order.join(',') === 'nonce:isUsed,revalidate,nonce:consume,exec');
}

// 5b: nonce state is mandatory, and consumption is atomic across concurrent
// dispatches even though policy and target revalidation are asynchronous.
{
  let execCount = 0;
  const missingState = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: async () => { execCount += 1; return okExec(); },
    now: NOW,
    policyContext: { operation: resolvedOperation },
    policyGate: async () => ({ ok: true, decision: 'ALLOW' }),
  });
  eq('missing nonce store DENYs', missingState.ok, false);
  eq('missing nonce store reports required state', missingState.code, 'SEMANTIC_CAPABILITY_NONCE_STATE_REQUIRED');
  eq('missing nonce store never executes', execCount, 0);

  const tracker = createWindowsNonceTracker();
  const dispatchOptions = {
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return okRevalidate();
    },
    execInvocation: async () => { execCount += 1; return okExec(); },
    nonceState: tracker,
    now: NOW,
    policyContext: { operation: resolvedOperation },
    policyGate: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { ok: true, decision: 'ALLOW' };
    },
  };
  const concurrent = await Promise.all([
    dispatchWindowsSemanticExec(dispatchOptions),
    dispatchWindowsSemanticExec(dispatchOptions),
  ]);
  eq('concurrent nonce dispatch has one winner', concurrent.filter((result) => result.ok).length, 1);
  eq('concurrent nonce dispatch has one replay denial',
    concurrent.filter((result) => result.code === 'SEMANTIC_CAPABILITY_CONSUMED').length, 1);
  eq('concurrent nonce dispatch executes once', execCount, 1);
}

// ── 6. permission-set (entries) envelope can reach ALLOW via per-entry match ──
// evaluatePermissionSet returns { decision, results } with no top-level
// capabilityMatched; the gate must derive it so a multi-operation envelope of
// exact Phase 2A matches ALLOWs, and any non-matching member blocks ALLOW.

// 6a: every entry is an exact capability match → ALLOW.
{
  const gate = createWindowsDispatchPolicyGate();
  const gateResult = await gate({
    entries: [
      { operation: resolvedOperation, facts: signedFacts },
      { operation: resolvedOperation, facts: signedFacts },
    ],
    mode: PERMISSION_MODES.STANDARD,
    capability: signedGrant,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'use-win-entries-1',
    usageConsumed: 0,
    consumedUseNonces: [],
    now: NOW,
  });
  check('permission-set of exact matches ALLOWs', gateResult.ok === true);
  eq('...reason is CAPABILITY_MATCHED', gateResult.code, PERMISSION_REASON_CODES.CAPABILITY_MATCHED);
}

// 6b: one entry has valid proof but no matching capability → ASK, not ALLOW.
{
  const gate = createWindowsDispatchPolicyGate();
  const gateResult = await gate({
    entries: [
      { operation: resolvedOperation, facts: signedFacts },
      { operation: resolvedOperation, facts: signedFacts },
    ],
    mode: PERMISSION_MODES.STANDARD,
    // No capability: each member is ASK, so the set cannot be all-matched.
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'use-win-entries-2',
    usageConsumed: 0,
    consumedUseNonces: [],
    now: NOW,
  });
  eq('permission-set with a non-matching member does not ALLOW', gateResult.ok, false);
  eq('...aggregated decision is ASK', gateResult.decision, 'ASK');
  eq('...reason is ASK_DEFAULT', gateResult.code, PERMISSION_REASON_CODES.ASK_DEFAULT);
}

// ── 7. host-capable dispatch with no gate/context is fail-closed ───────────────

{
  let revalidateRan = false;
  let execRan = false;
  const tracker = createWindowsNonceTracker();
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: async () => { revalidateRan = true; return okRevalidate(); },
    execInvocation: async () => { execRan = true; return okExec(); },
    nonceState: tracker,
    now: NOW,
    // No policyGate and no policyContext: host-capable dispatch must fail closed.
  });
  eq('host-capable dispatch with no gate DENYs', dispatchResult.ok, false);
  eq('...reason is POLICY_GATE_REQUIRED', dispatchResult.code, PERMISSION_REASON_CODES.POLICY_GATE_REQUIRED);
  check('no-gate dispatch never reaches revalidation', revalidateRan === false);
  check('no-gate dispatch never reaches exec', execRan === false);
  check('no-gate dispatch does not consume the one-shot nonce', tracker.isUsed(signedCapability.nonce) === false);
}

// ── 8. uncertainty cannot bypass the Windows policy gate ──────────────────────

{
  const lowConfidenceOperation = JSON.parse(JSON.stringify(resolvedOperation));
  lowConfidenceOperation.analysis.confidence = 'low';
  const lowFacts = buildWindowsDispatchPermissionFacts(lowConfidenceOperation, signedCapability);
  const lowSignedFacts = createPermissionFactsProof({
    operation: lowConfidenceOperation,
    facts: lowFacts,
    privateKey: proofKeys.privateKey,
    kid: factsKid,
    now: NOW,
    ttlMs: 15 * 60 * 1000,
  });
  const gateResult = await defaultWindowsDispatchPolicyGate({
    operation: lowConfidenceOperation,
    facts: lowSignedFacts,
    mode: PERMISSION_MODES.STANDARD,
    capability: signedGrant,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    useNonce: 'use-win-low-confidence',
    now: NOW,
  });
  eq('Windows gate rejects low confidence despite signed facts and capability', gateResult.ok, false);
  eq('Windows low confidence hits the security ceiling', gateResult.code, PERMISSION_REASON_CODES.SECURITY_CEILING);
}

{
  const unknownOperation = JSON.parse(JSON.stringify(resolvedOperation));
  unknownOperation.analysis.unknowns = ['host:unclassified-effect'];
  const dispatchResult = await dispatchWindowsSemanticExec({
    request: { capability: signedCapability },
    publicKeyByKid,
    revalidate: okRevalidate,
    execInvocation: okExec,
    nonceState: createWindowsNonceTracker(),
    now: NOW,
    policyContext: { operation: unknownOperation, mode: PERMISSION_MODES.STANDARD },
  });
  eq('Windows dispatch rejects analysis unknowns before execution', dispatchResult.ok, false);
  eq('Windows analysis unknowns cannot be rebound to a signed capability', dispatchResult.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');
}

console.log(`windows-executor-policy-gate: ${passed} checks passed`);
