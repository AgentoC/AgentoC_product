/**
 * Server-owned semantic policy projection.
 *
 * Phase 2 is intentionally shadow-only: this module turns a compiler operation
 * plus facts produced by semantic-resolver into reproducible ALLOW / ASK / DENY
 * decisions. It neither grants a capability nor invokes a runner or executor.
 * A caller's declared scope, impact, or risk data never participates here.
 */

import {
  SEMANTIC_OPERATION_REASON_CODES as RC,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
  STRICTNESS,
  aggregateDecisions,
  computeSemanticManifestHash,
  defaultDecision,
  isRefusal,
  reasonMessage,
  validateSemanticOperation,
} from './semantic-operation.mjs';

export { SEMANTIC_POLICY_VERSION };

const DENY_SCOPE_KINDS = new Set([
  'filesystem_root',
  'home_credential',
  'mount_boundary',
  'outside_project',
  'sensitive',
  'symlink_escape',
  'uncontained',
  'unresolvable',
  'unknown',
]);

const DENY_ACTIONS = new Set([
  'credential.read',
  'credential.use',
  'credential.write',
  'network.firewall.modify',
  'package.remove',
  'package.source.modify',
  'privilege.elevate',
  'remote_code.execute',
  'service.modify',
  'unknown.host_effect',
]);

const RESOLUTION_INCOMPLETE_UNKNOWN_PREFIXES = Object.freeze([
  'env:',
  'interpreter:',
  'parser:',
  'revalidation:',
  'scope:trusted-project-root-unavailable',
  'scope:tree-unreadable',
  'scope:symlink-escape',
  'scope:mount-boundary',
  'scope:path-unresolvable',
  'shell:',
  'target:',
  'tree:',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function dedupe(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => trimString(value))
    .filter(Boolean))];
}

function reason(code) {
  return { code, message: reasonMessage(code) };
}

function reasonCodes(reasons) {
  return new Set((Array.isArray(reasons) ? reasons : [])
    .map((entry) => trimString(entry?.code || entry))
    .filter(Boolean));
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function resolutionHasSnapshot(resolution) {
  const snapshot = resolution?.resourceSnapshot;
  if (!snapshot || snapshot.resolverVersion !== SEMANTIC_RESOLVER_VERSION || !trimString(snapshot.identity)) return false;
  if (Array.isArray(snapshot.paths)) return true;
  // A package resource is not a filesystem path. Its resolver snapshot must
  // carry both the manager and the complete package descriptor list instead.
  if (trimString(snapshot.manager) && Array.isArray(snapshot.packages) && snapshot.packages.length > 0) {
    return snapshot.packages.every((entry) => trimString(entry?.name));
  }
  // Service resources do not have filesystem paths or package descriptors.
  // Their identity is the exact service name plus the provider-observed
  // definition hash, which is the fact the executor must revalidate.
  if ((trimString(snapshot.unit) || trimString(snapshot.serviceName))
    && trimString(snapshot.definitionHash)) {
    return true;
  }
  if (trimString(snapshot.artifactPath)
    && trimString(snapshot.artifactIdentity)
    && /^[0-9a-f]{64}$/i.test(trimString(snapshot.artifactDigest))) {
    return true;
  }
  return false;
}

function resolutionIsUsable(resolution) {
  return Boolean(resolution
    && typeof resolution === 'object'
    && resolution.scope
    && typeof resolution.scope.computed === 'boolean'
    && resolution.impact
    && typeof resolution.impact === 'object'
    && resolutionHasSnapshot(resolution));
}

function incompleteUnknowns(operation, resolution) {
  const values = [
    ...(operation?.analysis?.unknowns || []),
    ...(resolution?.unknowns || []),
  ].map(trimString).filter(Boolean);
  return values.filter((value) => RESOLUTION_INCOMPLETE_UNKNOWN_PREFIXES
    .some((prefix) => value.startsWith(prefix)));
}

function operationActions(operation) {
  return [operation?.primaryAction, ...(operation?.effects || [])]
    .map(trimString)
    .filter(Boolean);
}

function isOrdinaryFilesystemOperation(operation) {
  const actions = operationActions(operation);
  return actions.length > 0 && actions.every((action) => (
    action === 'fs.read' || action === 'fs.write' || action === 'fs.metadata'
  ));
}

function isOrdinaryFilesystemWrite(operation) {
  const actions = operationActions(operation);
  return actions.length > 0
    && actions.includes('fs.write')
    && actions.every((action) => action === 'fs.read' || action === 'fs.write' || action === 'fs.metadata');
}

/**
 * Apply only server-computed resolver facts. The compiler's target and source
 * evidence stay immutable; this replaces unresolved scope/impact and attaches
 * the complete resource snapshot needed by later revalidation.
 */
export function bindServerResolution(operation, resolution) {
  const base = clone(operation) || {};
  const valid = validateSemanticOperation(base);
  if (!valid.ok || !resolutionIsUsable(resolution)) return null;
  const bound = {
    ...base,
    target: {
      ...(base.target || {}),
      resourceSnapshot: clone(resolution.resourceSnapshot),
    },
    scope: clone(resolution.scope),
    impact: clone(resolution.impact),
    analysis: {
      ...(base.analysis || {}),
      resolverVersion: SEMANTIC_RESOLVER_VERSION,
      unknowns: dedupe([
        ...(base.analysis?.unknowns || []),
        ...(resolution.unknowns || []),
      ]),
    },
  };
  return validateSemanticOperation(bound).ok ? bound : null;
}

function deny(reasonList, extra = {}) {
  return {
    decision: 'DENY',
    strictness: STRICTNESS.DENY,
    reasons: reasonList,
    ...extra,
  };
}

/**
 * Evaluate one operation against facts returned by the server resolver.
 * Missing, unknown, stale, or non-revalidatable facts always deny. This is a
 * policy projection, not an authorization result.
 */
export function evaluateSemanticOperation(operation, resolution) {
  const bound = bindServerResolution(operation, resolution);
  const operationId = trimString(operation?.operationId);
  if (!bound) {
    return {
      operationId,
      operation: null,
      ...deny([reason(RC.SCOPE_NOT_COMPUTED), reason(RC.UNKNOWN_HOST_EFFECT)], {
        unknowns: ['policy:server-resolution-required'],
      }),
    };
  }

  const scope = bound.scope || {};
  const impact = bound.impact || {};
  const actions = operationActions(bound);
  const inputReasonCodes = reasonCodes(bound.analysis?.reasons);
  const unknowns = incompleteUnknowns(bound, resolution);
  const policyReasons = [];

  if (isRefusal(bound) || actions.some((action) => DENY_ACTIONS.has(action))) {
    policyReasons.push(reason(RC.REFUSAL_NEVER_ALLOW));
  }
  if (scope.computed !== true) policyReasons.push(reason(RC.SCOPE_NOT_COMPUTED));
  if (scope.revalidationRequired === true || unknowns.some((value) => value.startsWith('revalidation:'))) {
    policyReasons.push(reason(RC.REVALIDATION_REQUIRED));
  }
  const ordinaryFilesystem = isOrdinaryFilesystemOperation(bound);
  const ordinaryFilesystemWrite = isOrdinaryFilesystemWrite(bound);
  if (ordinaryFilesystemWrite && bound.scope?.selfProtection?.computed !== true
    && operationActions(bound).includes('fs.write')) {
    policyReasons.push(reason(RC.SELF_PROTECTION_UNAVAILABLE));
  }
  // The workspace is a recommendation, not a hard sandbox. Ordinary concrete
  // writes may work outside it; reads, sensitive/system/self-protected targets
  // remain subject to their own ceilings below.
  if (DENY_SCOPE_KINDS.has(trimString(scope.kind))
    && !(ordinaryFilesystemWrite && trimString(scope.kind) === 'outside_project')) {
    policyReasons.push(reason(RC.SENSITIVE_TARGET));
  }
  // `system` is a resource-domain label, not necessarily an unsafe filesystem
  // path. A package/service descriptor can be structurally revalidated and
  // remains ASK under its taxonomy; raw filesystem mutations under /etc,/usr,
  // /var and similar paths do not get that exception.
  if (trimString(scope.kind) === 'system' && String(bound.target?.kind || '').startsWith('filesystem')) {
    policyReasons.push(reason(RC.SENSITIVE_TARGET));
  }
  if (impact.containsSensitiveMaterial === true || impact.containsGitMetadata === true) {
    policyReasons.push(reason(RC.SENSITIVE_TARGET));
  }
  if (bound.scope?.selfProtection?.matched === true
    && operationActions(bound).some((action) => ['fs.write', 'fs.delete'].includes(action))) {
    policyReasons.push(reason(RC.SELF_PROTECTION_BOUNDARY));
  }
  if (unknowns.length > 0) policyReasons.push(reason(RC.UNKNOWN_HOST_EFFECT));
  if (inputReasonCodes.has(RC.DYNAMIC_TARGET)) policyReasons.push(reason(RC.DYNAMIC_TARGET));
  if (inputReasonCodes.has(RC.ENV_INJECTION)) policyReasons.push(reason(RC.ENV_INJECTION));
  if (inputReasonCodes.has(RC.INTERPRETER_NESTED)) policyReasons.push(reason(RC.INTERPRETER_NESTED));

  const manifestHash = computeSemanticManifestHash(bound);
  const base = {
    operationId: bound.operationId,
    operation: bound,
    operationManifestHash: manifestHash,
    resolverSnapshotIdentity: bound.target.resourceSnapshot.identity,
    policyVersion: SEMANTIC_POLICY_VERSION,
    unknowns: dedupe([...(bound.analysis?.unknowns || []), ...unknowns]),
    advisories: ordinaryFilesystemWrite && trimString(scope.kind) === 'outside_project'
      ? [{ code: 'workspace_recommended', message: '在工作区内执行更容易复核；当前目标位于工作区外，仍允许继续' }]
      : [],
  };
  if (policyReasons.length > 0) {
    return { ...base, ...deny(policyReasons) };
  }

  const decision = defaultDecision(bound);
  if (decision === 'UNKNOWN') {
    return {
      ...base,
      ...deny([reason(RC.SCOPE_NOT_COMPUTED)]),
    };
  }
  return {
    ...base,
    decision,
    strictness: decision === 'ALLOW' ? STRICTNESS.ALLOW : STRICTNESS.ASK,
    reasons: decision === 'ALLOW'
      ? [reason(RC.ORDINARY_OPERATION)]
      : [reason(RC.EFFECT_STRICTNESS_RAISE)],
  };
}

/**
 * Evaluate a batch without trusting batch-level claims. Each tuple must carry
 * the compiler operation and its independently server-resolved facts. The
 * aggregate remains the most restrictive member: DENY > ASK > ALLOW.
 */
export function projectSemanticPolicy(items = []) {
  const decisions = (Array.isArray(items) ? items : []).map((item) => (
    evaluateSemanticOperation(item?.operation, item?.resolution)
  ));
  const decision = aggregateDecisions(decisions.map((entry) => entry.decision));
  return {
    schemaVersion: 'semantic-policy-projection/v1',
    policyVersion: SEMANTIC_POLICY_VERSION,
    decision,
    strictness: decision === 'ALLOW' ? STRICTNESS.ALLOW
      : decision === 'ASK' ? STRICTNESS.ASK : STRICTNESS.DENY,
    decisions,
    // A policy output is explicitly not a capability. Phase 3 binds an owner
    // selection, run/turn, version, TTL and one-shot nonce before any executor.
    capabilityEligible: false,
  };
}
