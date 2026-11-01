import { temporaryPairingError } from './temporary-pairing-protocol.mjs';

// This is a separate authorization profile from the v1 temporary-share grant.
// It deliberately describes named product actions rather than inheriting the
// Owner role or allowing a path-prefix wildcard.
export const TEMPORARY_CONTROL_SESSION_SCOPE = 'all-workbench';

export const TEMPORARY_CONTROL_CAPABILITIES = Object.freeze([
  'project.read', 'project.create', 'project.update', 'project.delete',
  'session.read', 'session.create', 'session.update', 'session.delete',
  'message.submit', 'run.read', 'run.cancel',
  // Approval reads and decisions are separate so every decision path can be
  // reviewed at the carrier boundary.  Privileged decisions intentionally get
  // their own capability; a normal approval grant can never authorize host
  // elevation merely by changing an endpoint path.
  'approval.read', 'approval.resolve', 'approval.privileged.resolve',
  'file.upload', 'file.download',
  'harness.read', 'harness.install', 'harness.upgrade', 'harness.uninstall',
  'provider.read', 'provider.create', 'provider.update', 'provider.delete',
  'provider.oauth', 'provider.quota.refresh', 'provider.rotation.update',
]);

// Route adapters must resolve every resource ID to an authoritative record
// before calling this policy.  A request body is never proof of ownership.
export const TEMPORARY_CONTROL_OPERATIONS = Object.freeze({
  'project.list': 'project.read',
  'project.read': 'project.read',
  'project.create': 'project.create',
  'project.update': 'project.update',
  'project.delete': 'project.delete',
  'project.browse': 'project.read',
  'project.mkdir': 'project.create',
  'session.list': 'session.read',
  'session.read': 'session.read',
  'session.create': 'session.create',
  'session.update': 'session.update',
  'session.delete': 'session.delete',
  'session.events': 'session.read',
  'session.receipt': 'session.read',
  'session.context': 'session.read',
  'session.mutation': 'session.update',
  'session.creation_contract': 'session.create',
  'session.mutation_contract': 'session.update',
  'session.action': 'session.update',
  'session.message_action': 'message.submit',
  'session.confirmation': 'approval.resolve',
  'runtime.summary': 'session.read',
  'message.submit': 'message.submit',
  'run.read': 'run.read',
  'run.cancel': 'run.cancel',
  'approval.list': 'approval.read',
  'approval.read': 'approval.read',
  'approval.resolve': 'approval.resolve',
  'approval.approved_action.resolve': 'approval.resolve',
  'approval.privileged.resolve': 'approval.privileged.resolve',
  'file.upload': 'file.upload',
  'file.download': 'file.download',
  'harness.list': 'harness.read',
  'harness.tools': 'harness.read',
  'harness.models': 'harness.read',
  'harness.install': 'harness.install',
  'harness.upgrade': 'harness.upgrade',
  'harness.uninstall': 'harness.uninstall',
  'provider.list': 'provider.read',
  'provider.quota.read': 'provider.read',
  'provider.rotation.read': 'provider.read',
  'provider.create': 'provider.create',
  'provider.update': 'provider.update',
  'provider.delete': 'provider.delete',
  'provider.oauth': 'provider.oauth',
  'provider.quota.refresh': 'provider.quota.refresh',
  'provider.rotation.update': 'provider.rotation.update',
});

const deny = () => { throw temporaryPairingError('temporary_control_denied', 403); };

/**
 * Returns the capability that authorizes one named temporary-control action.
 * This is intentionally not usable for v1 sharing principals.
 */
export function authorizeTemporaryControl(principal, operation) {
  const capability = TEMPORARY_CONTROL_OPERATIONS[operation];
  // The in-process carrier adapter presents an Owner-shaped `role` solely to
  // satisfy legacy route guards. It carries this private marker and remains a
  // temporary principal for every policy decision.
  const temporaryPrincipal = principal?.role === 'temporary'
    || (principal?.temporaryControlAdapter === true && principal?.temporaryControlOriginalRole === 'temporary');
  if (!capability || !temporaryPrincipal || principal.principalKind !== 'temporary_device'
    || principal.sessionScope !== TEMPORARY_CONTROL_SESSION_SCOPE
    || !Array.isArray(principal.capabilities)
    || !principal.capabilities.includes(capability)
    || !Number.isSafeInteger(principal.expiry) || principal.expiry <= Date.now()) deny();
  return Object.freeze({ operation, capability, instanceId: principal.instanceId,
    grantId: principal.grantId, expiresAt: principal.expiry });
}

// Session-manager functions are server-internal and do not receive the raw
// HTTP principal.  Keep the delegation object process-local so an untrusted
// request body cannot impersonate a confirmed temporary-control grant.
const temporaryControlApprovalActors = new WeakSet();

/**
 * Creates an internal, request-scoped approval actor after the carrier has
 * authenticated the device and checked the exact approval operation.  The
 * object's identity, rather than its fields, is the authority.
 */
export function createTemporaryControlApprovalActor(principal, operation) {
  const authorization = authorizeTemporaryControl(principal, operation);
  const actor = Object.freeze({
    kind: 'temporary_control',
    grantId: authorization.grantId,
    instanceId: authorization.instanceId,
    expiresAt: authorization.expiresAt,
    operation: authorization.operation,
  });
  temporaryControlApprovalActors.add(actor);
  return actor;
}

export function isTemporaryControlApprovalActor(actor, operation = '') {
  return !!actor
    && temporaryControlApprovalActors.has(actor)
    && actor.kind === 'temporary_control'
    && Number.isSafeInteger(actor.expiresAt) && actor.expiresAt > Date.now()
    && (!operation || actor.operation === operation);
}

/** Persistable audit metadata only; it is never accepted as authorization. */
export function temporaryControlApprovalAudit(actor) {
  if (!isTemporaryControlApprovalActor(actor)) return null;
  return Object.freeze({ source: 'temporary_control', grantId: actor.grantId,
    instanceId: actor.instanceId, expiresAt: actor.expiresAt });
}

/** A control grant must be exact: partial or unknown capability sets never become full control. */
export function isTemporaryControlCapabilitySet(capabilities) {
  return Array.isArray(capabilities)
    && capabilities.length === TEMPORARY_CONTROL_CAPABILITIES.length
    && new Set(capabilities).size === capabilities.length
    && TEMPORARY_CONTROL_CAPABILITIES.every((capability) => capabilities.includes(capability));
}
