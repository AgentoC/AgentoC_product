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
  SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO,
  SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
  SEMANTIC_ADAPTER_MSI_INSTALL_V1,
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

/** Issue a narrowly scoped policy-auto capability using only server projection.
 * The caller must obtain riskMode from the admitted run, never from a tool
 * request. The executor still verifies the signature, binding and current
 * package facts, and consumes the capability only once.
 */
function authorizeWindowsInstallForScopes({ prepared, riskMode = '', kid = '', now }, allowedScopes) {
  if (!['recommended', 'full-auto'].includes(trimString(riskMode))) {
    fail('SEMANTIC_AUTO_PROFILE_DENIED', 'this profile does not permit automatic Windows installation');
  }
  const binding = assertBinding(prepared?.binding || {});
  const decisions = Array.isArray(prepared?.projection?.decisions) ? prepared.projection.decisions : [];
  if (decisions.length !== 1) fail('SEMANTIC_AUTO_SELECTION_DENIED', 'automatic installation requires exactly one operation');
  const entry = decisions[0];
  const op = entry?.operation;
  if (entry?.decision !== 'ASK' || entry?.unknowns?.length || op?.primaryAction !== 'package.install'
      || op?.target?.platform !== 'win32' || op?.executionClass !== 'host'
      || op?.target?.kind !== 'package' || op?.target?.manager !== 'winget'
      || op?.target?.source !== 'winget' || op?.target?.exact !== true
      || !allowedScopes.includes(op?.target?.requestedInstallScope)
      || op?.target?.resourceSnapshot?.sourceTrust !== 'configured') {
    fail('SEMANTIC_AUTO_SELECTION_DENIED', 'operation is not an eligible verified Windows package installation');
  }
  return createSemanticCapability({
    selectedDecisions: decisions,
    adapter: SEMANTIC_ADAPTER_WINGET_INSTALL_V1,
    sessionId: binding.sessionId, runId: binding.runId, turnId: binding.turnId,
    authMode: SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO, kid: trimString(kid), now,
  });
}

// The system broker has a machine-wide token and must never receive an
// unspecified/user-scoped operation. User/default execution must use an
// ordinary-user transport and retains the original scope in the signed input.
export function authorizeWindowsAutomaticInstall(options = {}) {
  return authorizeWindowsInstallForScopes(options, ['machine']);
}

export function authorizeWindowsUserInstall(options = {}) {
  return authorizeWindowsInstallForScopes(options, ['', 'user']);
}

// The package identity is resolved from the server-side filesystem. Trust in
// its signature state is checked independently by the broker before signing.
export function authorizeWindowsMSIAutomaticInstall({ prepared, riskMode = '', kid = '', now } = {}) {
  if (!['recommended', 'full-auto'].includes(trimString(riskMode))) fail('SEMANTIC_AUTO_PROFILE_DENIED', 'automatic Windows installation is unavailable');
  const binding = assertBinding(prepared?.binding || {});
  const decisions = Array.isArray(prepared?.projection?.decisions) ? prepared.projection.decisions : [];
  const entry = decisions[0], op = entry?.operation, snap = op?.target?.resourceSnapshot;
  if (decisions.length !== 1 || entry?.decision !== 'ASK' || entry?.unknowns?.length || op?.primaryAction !== 'package.install' ||
      op?.target?.platform !== 'win32' || op?.executionClass !== 'host' || op?.target?.kind !== 'package_artifact' ||
      op?.target?.manager !== 'msiexec' || op?.target?.source !== 'local_artifact' || !snap?.artifactIdentity ||
      !/^[a-f0-9]{64}$/.test(snap?.artifactDigest || '') || op.target.digest !== snap.artifactDigest || op.target.root !== snap.artifactPath) {
    fail('SEMANTIC_AUTO_SELECTION_DENIED', 'operation is not an eligible Windows MSI installation');
  }
  return createSemanticCapability({ selectedDecisions: decisions, adapter: SEMANTIC_ADAPTER_MSI_INSTALL_V1,
    sessionId: binding.sessionId, runId: binding.runId, turnId: binding.turnId,
    authMode: SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO, kid: trimString(kid), now });
}
