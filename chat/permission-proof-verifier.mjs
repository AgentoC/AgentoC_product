/**
 * Phase 2B slice 2B-2 — trusted proof verifier.
 *
 * Pure, injectable ed25519 proof verification that backs the Phase 2A policy
 * evaluator's injectable callbacks:
 *   - `verifyFactsProof(operation, facts)`
 *   - `verifyGrantProof(grant)`
 *
 * The evaluator (chat/permission-policy.mjs) requires a literal `true` from
 * each callback and treats any other return as a failed proof (DENY). This
 * module therefore returns `true` on success and `{ ok: false, code }` on every
 * failure, reusing PERMISSION_REASON_CODES values where they exist and adding
 * new codes in the same namespace for unknown-kid/expired cases.
 *
 * Trust boundary:
 *   - The proof is a server-produced ed25519 signature over a canonical digest
 *     that binds the facts manifest hash / operation manifest hash (facts) or
 *     the masked constraint manifest hash (grant) to a fixed server marker and
 *     to the proof's own kid + expiry.
 *   - No caller-supplied field (`serverComputed`, `source`, `attestation`,
 *     `constraintManifestHash`, ...) is trusted as authority. The signature
 *     verifies against a trusted public key looked up by kid, and the bound
 *     hashes are recomputed from the actual content by the verifier.
 *   - No I/O, no key paths at import. Keys arrive via `publicKeyByKid`; time
 *     arrives via `now` (a fixed number or a function).
 *
 * Server-side signing helpers (`createPermissionFactsProof`,
 * `createCapabilityGrantProof`) are exported for the resolver/approval server
 * so the signer and verifier share one digest computation. They are never used
 * on the verification path.
 */

import { createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

import {
  CAPABILITY_GRANT_VERSION,
  PERMISSION_FACTS_VERSION,
  PERMISSION_REASON_CODES,
  computeCapabilityConstraintHash,
  computePermissionFactsManifestHash,
  validateCapabilityGrant,
  validatePermissionFacts,
} from './permission-policy.mjs';
import { canonicalSemanticJson, computeSemanticManifestHash } from './semantic-operation.mjs';

export const PERMISSION_PROOF_REASON_CODES = Object.freeze({
  FACTS_PROOF_REQUIRED: PERMISSION_REASON_CODES.FACTS_PROOF_REQUIRED,
  FACTS_PROOF_INVALID: PERMISSION_REASON_CODES.FACTS_PROOF_INVALID,
  FACTS_PROOF_UNKNOWN_KID: 'permission_facts_proof_unknown_kid',
  FACTS_PROOF_EXPIRED: 'permission_facts_proof_expired',
  FACTS_MANIFEST_MISMATCH: PERMISSION_REASON_CODES.FACTS_MANIFEST_MISMATCH,
  GRANT_PROOF_REQUIRED: PERMISSION_REASON_CODES.CAPABILITY_PROOF_REQUIRED,
  GRANT_PROOF_INVALID: PERMISSION_REASON_CODES.CAPABILITY_PROOF_INVALID,
  GRANT_PROOF_UNKNOWN_KID: 'permission_capability_proof_unknown_kid',
  GRANT_PROOF_EXPIRED: 'permission_capability_proof_expired',
});

const C = PERMISSION_PROOF_REASON_CODES;

// Fixed server marker embedded in every signed proof. It identifies the
// server-produced proof domain and keeps facts proofs and grant proofs in
// distinct domains, so a signature minted for one can never be replayed for
// the other.
const FACTS_PROOF_PURPOSE = 'permission-facts-proof/v2';
const GRANT_PROOF_PURPOSE = 'capability-grant-proof/v2';
const PROOF_MARKER = 'server-resolver';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function fail(code, error) {
  return { ok: false, code, error };
}

function normalizePublicKey(publicKey) {
  if (!publicKey) return null;
  if (typeof publicKey === 'string') {
    try {
      return createPublicKey({ key: Buffer.from(publicKey, 'base64url'), type: 'spki', format: 'der' });
    } catch {
      return null;
    }
  }
  // Node KeyObject (matches verifySemanticCapability's publicKey contract).
  if (publicKey && typeof publicKey.export === 'function') return publicKey;
  return null;
}

/**
 * Read a well-formed proof envelope: { kid, sig, expiresAt }.
 *
 * `expiresAt` is kept as the original ISO string so the signed digest always
 * uses the same serialized form the signer used; `expiresAtMs` is the parsed
 * number used for the expiry comparison.
 */
function proofEnvelope(proof) {
  if (!isPlainObject(proof)) return null;
  const kid = trim(proof.kid);
  const sig = trim(proof.sig);
  const expiresAt = trim(proof.expiresAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (!kid || !sig || !expiresAt || !Number.isFinite(expiresAtMs)) return null;
  return { kid, sig, expiresAt, expiresAtMs };
}

/** Deterministic signable for a facts proof; the sig is never part of the digest. */
function factsSignable(operation, facts, proof) {
  return {
    purpose: FACTS_PROOF_PURPOSE,
    version: PERMISSION_FACTS_VERSION,
    marker: PROOF_MARKER,
    kid: proof.kid,
    expiresAt: proof.expiresAt,
    factsManifestHash: computePermissionFactsManifestHash(facts),
    operationManifestHash: computeSemanticManifestHash(operation),
  };
}

/**
 * Deterministic signable for a grant proof. The constraint manifest hash is
 * recomputed with the proof's signature masked to '' so the digest never
 * depends on the signature it carries (no self-reference). The stored
 * `constraintManifestHash` (which includes the full grantProof envelope) is
 * validated separately by the evaluator and defensively by the verifier.
 */
function grantSignable(grant, proof) {
  return {
    purpose: GRANT_PROOF_PURPOSE,
    version: CAPABILITY_GRANT_VERSION,
    marker: PROOF_MARKER,
    kid: proof.kid,
    expiresAt: proof.expiresAt,
    constraintManifestHash: computeCapabilityConstraintHash({
      ...grant,
      grantProof: { kid: proof.kid, expiresAt: proof.expiresAt, sig: '' },
    }),
  };
}

/**
 * Create a proof verifier.
 *
 * @param {object} options
 * @param {object|Array} options.publicKeyByKid — either { kid: publicKey, ... }
 *   (KeyObject or base64url SPKI DER string) or an array of { kid, publicKey }.
 * @param {number|function} [options.now] — fixed ms epoch or function returning
 *   ms epoch used as "current time" for proof expiry. Defaults to Date.now().
 * @returns {{verifyFactsProof: function, verifyGrantProof: function}}
 */
export function createPermissionProofVerifier({ publicKeyByKid = {}, now } = {}) {
  const keys = new Map();
  const entries = Array.isArray(publicKeyByKid)
    ? publicKeyByKid.map((entry) => [entry?.kid, entry?.publicKey])
    : isPlainObject(publicKeyByKid)
      ? Object.entries(publicKeyByKid)
      : [];
  for (const [kid, publicKey] of entries) {
    const normalized = normalizePublicKey(publicKey);
    if (normalized) keys.set(kid, normalized);
  }

  const currentNow = () => {
    const raw = typeof now === 'function' ? now() : (now ?? Date.now());
    const value = Number(raw);
    return Number.isFinite(value) ? value : Date.now();
  };

  function verifyFactsProof(operation, facts) {
    if (!isPlainObject(facts)) return fail(C.FACTS_PROOF_REQUIRED, 'permission facts are required');
    const proof = proofEnvelope(facts.proof);
    if (!proof) return fail(C.FACTS_PROOF_REQUIRED, 'facts.proof with kid, signature, and expiresAt is required');
    const publicKey = keys.get(proof.kid);
    if (!publicKey) return fail(C.FACTS_PROOF_UNKNOWN_KID, `unknown facts proof key id ${proof.kid}`);
    if (currentNow() >= proof.expiresAtMs) return fail(C.FACTS_PROOF_EXPIRED, 'facts proof has expired');

    // Recompute the bound hashes from the actual content; a caller-supplied
    // hash field is data, not authority.
    const factsManifestHash = computePermissionFactsManifestHash(facts);
    const operationManifestHash = computeSemanticManifestHash(operation);
    if (factsManifestHash !== trim(facts.factsManifestHash)) {
      return fail(C.FACTS_MANIFEST_MISMATCH, 'facts manifest hash does not match the facts envelope');
    }
    if (operationManifestHash !== trim(facts.operationManifestHash)) {
      return fail(C.FACTS_MANIFEST_MISMATCH, 'operation manifest hash does not match the operation');
    }

    const payload = Buffer.from(canonicalSemanticJson(factsSignable(operation, facts, proof)), 'utf8');
    try {
      return edVerify(null, payload, publicKey, Buffer.from(proof.sig, 'base64url'))
        ? true
        : fail(C.FACTS_PROOF_INVALID, 'facts proof signature is invalid');
    } catch {
      return fail(C.FACTS_PROOF_INVALID, 'facts proof signature is invalid');
    }
  }

  function verifyGrantProof(grant) {
    if (!isPlainObject(grant)) return fail(C.GRANT_PROOF_REQUIRED, 'capability grant is required');
    const proof = proofEnvelope(grant.grantProof);
    if (!proof) return fail(C.GRANT_PROOF_REQUIRED, 'grant.grantProof with kid, signature, and expiresAt is required');
    const publicKey = keys.get(proof.kid);
    if (!publicKey) return fail(C.GRANT_PROOF_UNKNOWN_KID, `unknown grant proof key id ${proof.kid}`);
    if (currentNow() >= proof.expiresAtMs) return fail(C.GRANT_PROOF_EXPIRED, 'grant proof has expired');

    // Defensive: the stored constraint manifest must match the grant content
    // (the evaluator also enforces this in validateCapabilityGrant).
    if (trim(grant.constraintManifestHash) !== computeCapabilityConstraintHash(grant)) {
      return fail(C.GRANT_PROOF_INVALID, 'grant constraint manifest hash does not match the grant');
    }

    const payload = Buffer.from(canonicalSemanticJson(grantSignable(grant, proof)), 'utf8');
    try {
      return edVerify(null, payload, publicKey, Buffer.from(proof.sig, 'base64url'))
        ? true
        : fail(C.GRANT_PROOF_INVALID, 'grant proof signature is invalid');
    } catch {
      return fail(C.GRANT_PROOF_INVALID, 'grant proof signature is invalid');
    }
  }

  return { verifyFactsProof, verifyGrantProof };
}

/**
 * Server-side signing helper: attach a trusted facts proof to a facts envelope.
 * The produced envelope still passes `validatePermissionFacts` for the same
 * operation and verifies under `verifyFactsProof`.
 */
export function createPermissionFactsProof({
  operation,
  facts,
  privateKey,
  kid,
  now = Date.now(),
  ttlMs = 15 * 60 * 1000,
} = {}) {
  const kidText = trim(kid);
  const current = Number(now);
  const boundedTtl = Number(ttlMs);
  if (!kidText || !privateKey) throw new Error('permission facts proof signing requires a kid and private key');
  if (!isPlainObject(facts)) throw new Error('permission facts proof requires a facts envelope');
  if (!Number.isFinite(current) || !Number.isFinite(boundedTtl)) throw new Error('permission facts proof requires a numeric now and ttlMs');
  const declaredOperationHash = trim(facts.operationManifestHash);
  const computedOperationHash = computeSemanticManifestHash(operation);
  if (declaredOperationHash && declaredOperationHash !== computedOperationHash) {
    throw new Error('permission facts proof operation manifest hash does not match the operation');
  }
  const declaredFactsHash = trim(facts.factsManifestHash);
  const computedFactsHash = computePermissionFactsManifestHash(facts);
  if (declaredFactsHash && declaredFactsHash !== computedFactsHash) {
    throw new Error('permission facts proof facts manifest hash does not match the facts envelope');
  }
  const proof = { kid: kidText, expiresAt: new Date(current + boundedTtl).toISOString(), sig: '' };
  const payload = Buffer.from(canonicalSemanticJson(factsSignable(operation, facts, proof)), 'utf8');
  const sig = edSign(null, payload, privateKey).toString('base64url');
  const signedFacts = { ...clone(facts), proof: { kid: kidText, expiresAt: proof.expiresAt, sig } };
  const validation = validatePermissionFacts(operation, signedFacts);
  if (!validation.ok) throw new Error(`signed permission facts failed validation: ${validation.error}`);
  return signedFacts;
}

/**
 * Server-side signing helper: attach a trusted grant proof to a capability
 * grant. The stored `constraintManifestHash` is recomputed after embedding the
 * real signature so `validateCapabilityGrant` remains consistent, and the
 * signature verifies under `verifyGrantProof`.
 */
export function createCapabilityGrantProof({
  grant,
  privateKey,
  kid,
  now = Date.now(),
  ttlMs = 15 * 60 * 1000,
} = {}) {
  const kidText = trim(kid);
  const current = Number(now);
  const boundedTtl = Number(ttlMs);
  if (!kidText || !privateKey) throw new Error('capability grant proof signing requires a kid and private key');
  if (!isPlainObject(grant)) throw new Error('capability grant proof requires a grant');
  if (!Number.isFinite(current) || !Number.isFinite(boundedTtl)) throw new Error('capability grant proof requires a numeric now and ttlMs');
  const validation = validateCapabilityGrant(grant, { now: current });
  if (!validation.ok) throw new Error(`cannot sign an invalid capability grant: ${validation.error}`);
  const proof = { kid: kidText, expiresAt: new Date(current + boundedTtl).toISOString(), sig: '' };
  const payload = Buffer.from(canonicalSemanticJson(grantSignable(grant, proof)), 'utf8');
  const sig = edSign(null, payload, privateKey).toString('base64url');
  const signedGrant = { ...clone(grant), grantProof: { kid: kidText, expiresAt: proof.expiresAt, sig } };
  signedGrant.constraintManifestHash = computeCapabilityConstraintHash(signedGrant);
  const signedValidation = validateCapabilityGrant(signedGrant, { now: current });
  if (!signedValidation.ok) throw new Error(`signed capability grant failed validation: ${signedValidation.error}`);
  return signedGrant;
}
