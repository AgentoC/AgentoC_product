#!/usr/bin/env node
/**
 * Phase 2B slice 2B-2 tests for the trusted proof verifier.
 *
 * Run: node tests/test-permission-proof-verifier.mjs
 *
 * Covers: valid facts proof ok; missing facts proof DENY; tampered digest DENY;
 * unknown kid DENY; expired proof DENY; valid grant proof ok; forged/missing
 * grant proof DENY; evaluatePermissionOperation with the real verifiers on a
 * valid ASK-decision capability grant (ALLOW only via an exact capability
 * match, DENY/ASK otherwise); no invalid proof ever yields ok:true.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import {
  PERMISSION_PROOF_REASON_CODES,
  createCapabilityGrantProof,
  createPermissionFactsProof,
  createPermissionProofVerifier,
} from '../chat/permission-proof-verifier.mjs';
import {
  CAPABILITY_WORKLOAD_SCOPES,
  PERMISSION_MODES,
  PERMISSION_REASON_CODES,
  buildPermissionFacts,
  computeCapabilityConstraintHash,
  createCapabilityGrant,
  evaluatePermissionOperation,
  validateCapabilityGrant,
  validatePermissionFacts,
} from '../chat/permission-policy.mjs';
import {
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_RESOLVER_VERSION,
} from '../chat/semantic-operation.mjs';

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
const V = PERMISSION_PROOF_REASON_CODES;
const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const KID = 'test-kid-001';

function operation(overrides = {}) {
  return {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: 'sop_phase2a_001',
    requestBinding: { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1', requestKey: 'request-1' },
    primaryAction: 'package.install',
    effects: ['process.execute'],
    executionClass: 'host',
    target: { kind: 'package', platform: 'linux', manager: 'apt', source: 'trusted_repository', exact: true },
    scope: { kind: 'system', computed: true },
    impact: { estimatedItems: 1, containsSensitiveMaterial: false, containsGitMetadata: false, reversible: true },
    source: { rawRequestHash: `sha256:${'1'.repeat(64)}`, commandForm: 'argv' },
    analysis: {
      confidence: 'high', unknowns: [], policyVersion: SEMANTIC_POLICY_VERSION,
      compilerVersion: SEMANTIC_COMPILER_VERSION, resolverVersion: SEMANTIC_RESOLVER_VERSION,
      effectsComplete: true,
    },
    ...overrides,
  };
}

function factsFor(op = operation(), overrides = {}) {
  return buildPermissionFacts({
    operation: op,
    executionClass: op.executionClass,
    impact: {
      reversible: op.impact?.reversible === true,
      containsSensitiveMaterial: op.impact?.containsSensitiveMaterial === true,
      containsGitMetadata: op.impact?.containsGitMetadata === true,
    },
    resource: { manager: 'apt', source: 'trusted_repository', repository: 'main' },
    selection: { packages: ['cmake'], exact: true },
    resourceSnapshotIdentity: 'snapshot-1',
    effectEnumerationProof: 'effects-proof',
    attestation: 'resolver-proof',
    ...overrides,
  });
}

function grantFor(op = operation(), facts = factsFor(op), overrides = {}) {
  return createCapabilityGrant({
    mode: PERMISSION_MODES.FULL_AUTONOMY,
    issuedAtTurn: 'turn-approval-1',
    issuedAt: new Date(NOW),
    ttlMs: 60 * 60 * 1000,
    usageMax: 2,
    workload: {
      scope: CAPABILITY_WORKLOAD_SCOPES.RUN,
      sessionId: op.requestBinding.sessionId,
      runId: op.requestBinding.runId,
      turnBinding: 'provenance',
    },
    constraints: {
      action: op.primaryAction,
      scope: facts.scope,
      resourceSnapshotIdentity: facts.resourceSnapshotIdentity,
      executionClass: facts.executionClass,
      impact: {
        reversible: facts.impact.reversible,
        containsSensitiveMaterial: facts.impact.containsSensitiveMaterial,
        containsGitMetadata: facts.impact.containsGitMetadata,
      },
      target: op.target,
      targetFlags: { recursive: false, force: false, exact: facts.selection?.exact === true },
      resource: facts.resource,
      selection: facts.selection,
      effects: { subset: op.effects },
    },
    grantProof: '',
    ...overrides,
  });
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const forgedSig = Buffer.alloc(64).toString('base64url');

const baseOp = operation();
const baseFacts = factsFor(baseOp);
const signedFacts = createPermissionFactsProof({
  operation: baseOp, facts: baseFacts, privateKey, kid: KID, now: NOW, ttlMs: 60 * 60 * 1000,
});
const baseGrant = grantFor(baseOp);
const signedGrant = createCapabilityGrantProof({
  grant: baseGrant, privateKey, kid: KID, now: NOW, ttlMs: 60 * 60 * 1000,
});

// A verifier with a fixed clock and the server public key.
const verifier = createPermissionProofVerifier({ publicKeyByKid: { [KID]: publicKey }, now: NOW });
const arrayVerifier = createPermissionProofVerifier({
  publicKeyByKid: [{ kid: KID, publicKey }],
  now: NOW,
});

// ── facts proof ──────────────────────────────────────────────────────────────
check('signed facts envelope still validates', validatePermissionFacts(baseOp, signedFacts).ok === true);
eq('valid facts proof ok', verifier.verifyFactsProof(baseOp, signedFacts), true);
eq('array key-ring facts proof ok', arrayVerifier.verifyFactsProof(baseOp, signedFacts), true);

const missingProof = verifier.verifyFactsProof(baseOp, { ...signedFacts, proof: undefined });
eq('missing facts proof not ok', missingProof.ok, false);
eq('missing facts proof code', missingProof.code, V.FACTS_PROOF_REQUIRED);

const tamperedFacts = verifier.verifyFactsProof(baseOp, {
  ...signedFacts, resource: { ...signedFacts.resource, repository: 'evil' },
});
eq('tampered facts digest not ok', tamperedFacts.ok, false);
eq('tampered facts digest code', tamperedFacts.code, V.FACTS_MANIFEST_MISMATCH);

const tamperedOperationHash = verifier.verifyFactsProof(baseOp, {
  ...signedFacts, operationManifestHash: '0'.repeat(64),
});
eq('tampered operation manifest hash not ok', tamperedOperationHash.ok, false);
eq('tampered operation manifest hash code', tamperedOperationHash.code, V.FACTS_MANIFEST_MISMATCH);

const unknownKidFacts = verifier.verifyFactsProof(baseOp, {
  ...signedFacts, proof: { ...signedFacts.proof, kid: 'unknown-kid' },
});
eq('unknown facts kid not ok', unknownKidFacts.ok, false);
eq('unknown facts kid code', unknownKidFacts.code, V.FACTS_PROOF_UNKNOWN_KID);

const expiredFacts = verifier.verifyFactsProof(baseOp, {
  ...signedFacts, proof: { ...signedFacts.proof, expiresAt: new Date(NOW - 1000).toISOString() },
});
eq('expired facts proof not ok', expiredFacts.ok, false);
eq('expired facts proof code', expiredFacts.code, V.FACTS_PROOF_EXPIRED);

const forgedFacts = verifier.verifyFactsProof(baseOp, {
  ...signedFacts, proof: { ...signedFacts.proof, sig: forgedSig },
});
eq('forged facts signature not ok', forgedFacts.ok, false);
eq('forged facts signature code', forgedFacts.code, V.FACTS_PROOF_INVALID);

// A verifier that does not know the signing kid cannot accept the proof.
const noKeyVerifier = createPermissionProofVerifier({ publicKeyByKid: { other: publicKey }, now: NOW });
eq('unknown kid to another verifier not ok', noKeyVerifier.verifyFactsProof(baseOp, signedFacts) !== true, true);

// ── grant proof ──────────────────────────────────────────────────────────────
check('signed grant still validates', validateCapabilityGrant(signedGrant, { now: NOW }).ok === true);
check('signed grant constraint hash is consistent', signedGrant.constraintManifestHash === computeCapabilityConstraintHash(signedGrant));
eq('valid grant proof ok', verifier.verifyGrantProof(signedGrant), true);
eq('array key-ring grant proof ok', arrayVerifier.verifyGrantProof(signedGrant), true);

const missingGrantProof = verifier.verifyGrantProof({ ...signedGrant, grantProof: undefined });
eq('missing grant proof not ok', missingGrantProof.ok, false);
eq('missing grant proof code', missingGrantProof.code, V.GRANT_PROOF_REQUIRED);

const forgedGrantSig = verifier.verifyGrantProof({
  ...signedGrant, grantProof: { ...signedGrant.grantProof, sig: forgedSig },
});
eq('forged grant signature not ok', forgedGrantSig.ok, false);
eq('forged grant signature code', forgedGrantSig.code, V.GRANT_PROOF_INVALID);

const tamperedGrant = verifier.verifyGrantProof({
  ...signedGrant, constraints: { ...signedGrant.constraints, resource: { manager: 'evil' } },
});
eq('tampered grant constraints not ok', tamperedGrant.ok, false);
eq('tampered grant constraints code', tamperedGrant.code, V.GRANT_PROOF_INVALID);

const unknownKidGrant = verifier.verifyGrantProof({
  ...signedGrant, grantProof: { ...signedGrant.grantProof, kid: 'unknown-kid' },
});
eq('unknown grant kid not ok', unknownKidGrant.ok, false);
eq('unknown grant kid code', unknownKidGrant.code, V.GRANT_PROOF_UNKNOWN_KID);

const expiredGrant = verifier.verifyGrantProof({
  ...signedGrant, grantProof: { ...signedGrant.grantProof, expiresAt: new Date(NOW - 1000).toISOString() },
});
eq('expired grant proof not ok', expiredGrant.ok, false);
eq('expired grant proof code', expiredGrant.code, V.GRANT_PROOF_EXPIRED);

// ── evaluatePermissionOperation with the real verifiers ──────────────────────
function evaluateWithProof(options) {
  return evaluatePermissionOperation({
    now: NOW,
    verifyFactsProof: verifier.verifyFactsProof,
    verifyGrantProof: verifier.verifyGrantProof,
    ...options,
  });
}

// package.install is an ASK-decision operation. With valid proofs and no grant
// the decision is unchanged (ASK); with an exact grant it is ALLOW.
eq('valid proof without grant asks', evaluateWithProof({
  operation: baseOp, facts: signedFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
}).decision, 'ASK');
eq('valid exact grant allows', evaluateWithProof({
  operation: baseOp, facts: signedFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: signedGrant, useNonce: 'use-1', usageConsumed: 0,
}).decision, 'ALLOW');
eq('valid exact grant reason', evaluateWithProof({
  operation: baseOp, facts: signedFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: signedGrant, useNonce: 'use-1', usageConsumed: 0,
}).reasonCode, C.CAPABILITY_MATCHED);

// Missing facts proof → DENY (the evaluator maps any non-true callback result
// to FACTS_PROOF_INVALID; the verifier itself distinguishes REQUIRED).
const missingFactsResult = evaluateWithProof({
  operation: baseOp, facts: { ...signedFacts, proof: undefined }, mode: PERMISSION_MODES.FULL_AUTONOMY,
});
eq('missing facts proof denies', missingFactsResult.decision, 'DENY');
eq('missing facts proof reason', missingFactsResult.reasonCode, C.FACTS_PROOF_INVALID);

// Forged facts proof → DENY.
const forgedFactsResult = evaluateWithProof({
  operation: baseOp, facts: { ...signedFacts, proof: { ...signedFacts.proof, sig: forgedSig } }, mode: PERMISSION_MODES.FULL_AUTONOMY,
});
eq('forged facts proof denies', forgedFactsResult.decision, 'DENY');
eq('forged facts proof reason', forgedFactsResult.reasonCode, C.FACTS_PROOF_INVALID);

// Tampered facts content → DENY with a manifest mismatch (caught by the pure
// facts validation before the proof callback even runs).
const tamperedFactsResult = evaluateWithProof({
  operation: baseOp, facts: { ...signedFacts, resource: { ...signedFacts.resource, repository: 'evil' } }, mode: PERMISSION_MODES.FULL_AUTONOMY,
});
eq('tampered facts digest denies', tamperedFactsResult.decision, 'DENY');
eq('tampered facts digest reason', tamperedFactsResult.reasonCode, C.FACTS_MANIFEST_MISMATCH);

// A grant with an empty (missing) proof never allows; it falls back to the
// base ASK decision with the proof-required reason.
const emptyProofGrantResult = evaluateWithProof({
  operation: baseOp, facts: signedFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: baseGrant, useNonce: 'use-2', usageConsumed: 0,
});
eq('empty grant proof not allow', emptyProofGrantResult.decision !== 'ALLOW', true);
eq('empty grant proof reason', emptyProofGrantResult.reasonCode, C.CAPABILITY_PROOF_REQUIRED);

// A grant whose embedded signature does not verify never allows. Build it with
// a consistent constraint manifest hash so the pure validator passes and only
// the proof callback can reject it.
const forgedProofGrant = {
  ...signedGrant,
  grantProof: { kid: KID, expiresAt: signedGrant.grantProof.expiresAt, sig: forgedSig },
};
forgedProofGrant.constraintManifestHash = computeCapabilityConstraintHash(forgedProofGrant);
check('forged-proof grant validates', validateCapabilityGrant(forgedProofGrant, { now: NOW }).ok === true);
const forgedProofGrantResult = evaluateWithProof({
  operation: baseOp, facts: signedFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: forgedProofGrant, useNonce: 'use-3', usageConsumed: 0,
});
eq('forged grant proof not allow', forgedProofGrantResult.decision !== 'ALLOW', true);
eq('forged grant proof reason', forgedProofGrantResult.reasonCode, C.CAPABILITY_PROOF_INVALID);

// Exact-match constraint: actual facts richer than the granted selection do
// not match a narrower grant → ASK (never ALLOW) with a constraint mismatch.
const broadOp = operation();
const broadFacts = factsFor(broadOp, { selection: { packages: ['cmake', 'curl'], exact: true } });
const signedBroadFacts = createPermissionFactsProof({
  operation: broadOp, facts: broadFacts, privateKey, kid: KID, now: NOW, ttlMs: 60 * 60 * 1000,
});
const expansionResult = evaluateWithProof({
  operation: broadOp, facts: signedBroadFacts, mode: PERMISSION_MODES.FULL_AUTONOMY,
  capability: signedGrant, useNonce: 'use-4', usageConsumed: 0,
});
eq('broader facts do not match narrow grant', expansionResult.decision, 'ASK');
eq('broader facts mismatch reason', expansionResult.reasonCode, C.CAPABILITY_CONSTRAINT_MISMATCH);

// ── no invalid proof ever yields ok:true ─────────────────────────────────────
const invalidFactsVariants = [
  ['missing proof', { ...signedFacts, proof: undefined }],
  ['forged signature', { ...signedFacts, proof: { ...signedFacts.proof, sig: forgedSig } }],
  ['unknown kid', { ...signedFacts, proof: { ...signedFacts.proof, kid: 'unknown-kid' } }],
  ['expired proof', { ...signedFacts, proof: { ...signedFacts.proof, expiresAt: new Date(NOW - 1).toISOString() } }],
  ['empty signature', { ...signedFacts, proof: { ...signedFacts.proof, sig: '' } }],
  ['non-object proof', { ...signedFacts, proof: 'proof' }],
  ['tampered resource', { ...signedFacts, resource: { ...signedFacts.resource, repository: 'evil' } }],
  ['tampered selection', { ...signedFacts, selection: { packages: ['evil'], exact: true } }],
];
for (const [label, facts] of invalidFactsVariants) {
  eq(`invalid facts proof never ok (${label})`, verifier.verifyFactsProof(baseOp, facts) !== true, true);
}

const invalidGrantVariants = [
  ['missing proof', { ...signedGrant, grantProof: undefined }],
  ['forged signature', { ...signedGrant, grantProof: { ...signedGrant.grantProof, sig: forgedSig } }],
  ['unknown kid', { ...signedGrant, grantProof: { ...signedGrant.grantProof, kid: 'unknown-kid' } }],
  ['expired proof', { ...signedGrant, grantProof: { ...signedGrant.grantProof, expiresAt: new Date(NOW - 1).toISOString() } }],
  ['empty signature', { ...signedGrant, grantProof: { ...signedGrant.grantProof, sig: '' } }],
  ['non-object proof', { ...signedGrant, grantProof: 'proof' }],
  ['tampered constraints', { ...signedGrant, constraints: { ...signedGrant.constraints, resource: { manager: 'evil' } } }],
  ['tampered usage budget', { ...signedGrant, usageBudget: { max: 9999 } }],
];
for (const [label, grant] of invalidGrantVariants) {
  eq(`invalid grant proof never ok (${label})`, verifier.verifyGrantProof(grant) !== true, true);
}

console.log(`permission-proof-verifier: ${passed} checks passed`);
