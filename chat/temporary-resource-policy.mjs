import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';

// Named application operations, not permission inferred from a URL prefix or HTTP verb.
const OPERATIONS = Object.freeze({
  'runtime.list': ['task.create', null],
  'session.create': ['task.create', null],
  'session.read': ['task.read', 'session'],
  'message.prepare': ['task.submit', 'session'],
  'message.commit': ['task.submit', 'session'],
  'message.receipt': ['task.submit', 'session'],
  'run.read': ['task.read', 'run'],
  'run.cancel': ['task.cancel', 'run'],
  'upload.create': ['file.upload', 'session'],
  'upload.write': ['file.upload', 'asset'],
  'upload.finalize': ['file.upload', 'asset'],
  'upload.receipt': ['file.upload', 'session'],
  'upload.checkpoint': ['file.upload', 'asset'],
  'upload.cancel': ['file.upload', 'asset'],
  'result.read': ['task.read', 'session'],
  'result.download': ['file.download', 'asset'],
  'result.export': ['file.download', 'run'],
  'result.chunk': ['file.download', 'run'],
});
const deny = () => { throw temporaryPairingError('temporary_resource_denied', 403); };
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v);
const scope = (p) => JSON.stringify(['temporary_device', p.instanceId, p.grantId, p.deviceId]);

/** Internal server policy. Resource arguments must be authoritative stored records, never request bodies.
 * Authorization is a checkpoint, not a lock or reusable effect permit. Mutation adapters must call it
 * again under their resource transaction immediately before committing, and before publishing reads.
 * This module does not expose HTTP routes, run tasks, create Sessions or grant filesystem access.
 */
export class TemporaryResourcePolicy {
  constructor(host) { this.host = host; }

  async authorize(principal, operation, resources = {}) {
    const rule = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : null;
    if (!rule || !resources || typeof resources !== 'object' || Array.isArray(resources)
      || Object.keys(resources).some((key) => !['session', 'run', 'asset'].includes(key))) deny();
    await this.host.revalidatePrincipal(principal);
    const [capability, required] = rule;
    if (!principal.capabilities.includes(capability) || principal.sessionScope !== 'created-sessions') deny();
    const { session, run, asset } = resources;
    if (!required) {
      if (Object.keys(resources).length) deny();
    } else {
      // Grant identity alone is insufficient: require server-authored idempotent creation provenance.
      if (!validId(session?.id) || session.createdByPrincipalKind !== 'temporary_device'
        || session.createdByPrincipalId !== principal.grantId
        || session.creationRequest?.principalScope !== scope(principal)
        || typeof session.creationRequest.key !== 'string' || !session.creationRequest.key.trim()
        || session.creationRequest.key.length > 200
        || !/^[a-f0-9]{64}$/.test(session.creationRequest.fingerprint || '')) deny();
      if (required === 'run' && !run) deny();
      if (required === 'asset' && !asset) deny();
      for (const record of [run, asset]) {
        if (record != null && (!validId(record.id) || record.sessionId !== session.id)) deny();
      }
    }
    // Return projection only; this is deliberately not accepted as authentication on the next call.
    return Object.freeze({ operation, capability, grantId: principal.grantId,
      sessionId: session?.id || null, runId: run?.id || null, assetId: asset?.id || null,
      expiresAt: principal.expiry });
  }

  /** Pass to the existing idempotent Session creation service, never merge phone-provided provenance. */
  async creationIdentity(principal) {
    await this.authorize(principal, 'session.create');
    return Object.freeze({ createdByPrincipalKind: 'temporary_device', createdByPrincipalId: principal.grantId,
      principalScope: scope(principal) });
  }
}
