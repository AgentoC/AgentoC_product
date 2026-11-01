/**
 * Server-side semantic approval orchestration.
 *
 * This is deliberately an internal service module, not a provider or UI
 * contract. It computes every semantic fact from the raw command plus trusted
 * run context, then binds an owner proof to the exact ASK subset. It does not
 * execute anything and it never accepts a caller-declared resource scope.
 */

import { compileSemanticOperations } from './semantic-compiler.mjs';
import { resolveSemanticContext } from './semantic-resolver.mjs';
import { projectSemanticPolicy } from './semantic-policy.mjs';
import {
  buildSemanticCapabilitySelection,
  createSemanticCapability,
} from './semantic-capability.mjs';

export const SEMANTIC_APPROVAL_PROOF_PURPOSE = 'semantic-capability-approval';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function bindingFromRequest(request = {}) {
  return {
    sessionId: trimString(request.sessionId),
    runId: trimString(request.runId),
    turnId: trimString(request.turnId),
    requestKey: trimString(request.requestKey),
  };
}

function assertBinding(value) {
  for (const [field, actual] of Object.entries(value)) {
    if (!actual) fail('SEMANTIC_APPROVAL_BINDING_REQUIRED', `${field} is required`);
  }
  return value;
}

/**
 * Compute a reproducible policy projection. `trustedContext` and
 * `resolverOptions` are server-owned run/environment inputs; caller context is
 * recorded only as resolver evidence. The projection cannot issue a grant.
 */
export async function prepareSemanticApproval({
  request = {},
  trustedContext = {},
  callerEvidence = {},
  resolverOptions = {},
} = {}) {
  const binding = assertBinding(bindingFromRequest(request));
  const compiled = compileSemanticOperations({ request, trustedContext });
  const items = await Promise.all(compiled.operations.map(async (operation) => ({
    operation,
    resolution: await resolveSemanticContext({
      operation,
      caller: callerEvidence,
      options: { ...resolverOptions, trustedContext },
    }),
  })));
  const projection = projectSemanticPolicy(items);
  return {
    binding,
    compiler: compiled,
    projection,
    capabilityEligible: false,
  };
}

/**
 * Select a subset of server-produced ASK decisions. IDs are the only user/UI
 * input accepted here; replacing an operation, target, or command is rejected
 * by construction because this returns the persisted projection entries.
 */
export function selectSemanticApproval(projection, selectedOperationIds = []) {
  const ids = new Set((Array.isArray(selectedOperationIds) ? selectedOperationIds : [])
    .map(trimString)
    .filter(Boolean));
  if (ids.size === 0) fail('SEMANTIC_APPROVAL_SELECTION_REQUIRED', 'at least one selected operation is required');
  const all = Array.isArray(projection?.decisions) ? projection.decisions : [];
  const selected = all.filter((entry) => ids.has(trimString(entry?.operationId)));
  if (selected.length !== ids.size) fail('SEMANTIC_APPROVAL_SELECTION_INVALID', 'selection contains an unknown operation');
  if (selected.some((entry) => entry?.decision !== 'ASK')) {
    fail('SEMANTIC_APPROVAL_SELECTION_DENIED', 'only ASK policy decisions may be owner-selected');
  }
  const selection = buildSemanticCapabilitySelection(selected);
  return { selected, ...selection };
}

/**
 * Consume the one-shot owner proof over the selection hash and construct an
 * unsigned capability. Signing/delivery stays in privileged-signing-keys so
 * this service cannot silently execute or use a generic command path.
 */
export async function authorizeSemanticApproval({
  prepared,
  selectedOperationIds = [],
  proofToken = '',
  credentialId = '',
  kid = '',
  adapter = '',
  consumeOwnerProof,
  now,
} = {}) {
  const binding = assertBinding(prepared?.binding || {});
  if (typeof consumeOwnerProof !== 'function') {
    fail('SEMANTIC_APPROVAL_PROOF_REQUIRED', 'owner proof verifier is required');
  }
  const selection = selectSemanticApproval(prepared?.projection, selectedOperationIds);
  const proofOk = await consumeOwnerProof({
    token: trimString(proofToken),
    purpose: SEMANTIC_APPROVAL_PROOF_PURPOSE,
    sessionId: binding.sessionId,
    requestId: binding.requestKey,
    manifestHash: selection.selectionManifestHash,
  });
  if (!proofOk) fail('SEMANTIC_APPROVAL_PROOF_REQUIRED', 'a fresh owner proof for this selection is required');
  return createSemanticCapability({
    selectedDecisions: selection.selected,
    adapter,
    sessionId: binding.sessionId,
    runId: binding.runId,
    turnId: binding.turnId,
    credentialId: trimString(credentialId),
    kid: trimString(kid),
    now,
  });
}
