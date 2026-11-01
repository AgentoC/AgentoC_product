import { createKeyedTaskQueue } from './fs-utils.mjs';
import { temporaryHash, temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { issueTemporaryAccessCredential, temporaryAccessGrantHint, verifyTemporaryAccessCredential,
  verifyTemporaryDpopProof } from '../lib/temporary-device-access.mjs';
import { verifyTemporaryConnectionRequest } from '../lib/temporary-connection-delivery.mjs';
import { temporaryCanonicalJson } from '../lib/temporary-pairing-broker-protocol.mjs';
import { TemporaryResourcePolicy } from './temporary-resource-policy.mjs';
import { parseTemporaryOperationAuthority } from '../lib/temporary-operation-authority.mjs';

const networkQueue = createKeyedTaskQueue();
const creationQueue = createKeyedTaskQueue();
const stopped = (r) => ['REVOKED', 'EXPIRED'].includes(r.status);
const lockKey = (registry) => process.platform === 'win32' ? registry.filePath.toLowerCase() : registry.filePath;
const retryTime = (now, delay) => Math.min(Number.MAX_SAFE_INTEGER, now + delay);

/** One host process owns the registry. Revoke never waits for this object's network queue. */
export class TemporaryPairingHost {
  #authenticated = new WeakMap();

  constructor({ registry, client, binding, clock = Date.now }) {
    this.registry = registry; this.client = client; this.binding = binding; this.clock = clock;
    this.resourcePolicy = new TemporaryResourcePolicy(this);
  }

  async context() {
    const b = await this.binding();
    if (!b?.accountId || !b.boundAt) return null;
    return { brokerUrl: this.client.baseUrl, bindingStamp: temporaryHash(JSON.stringify([
      this.registry.publicIdentity.instanceId, this.registry.publicIdentity.keyFingerprint, this.client.baseUrl, b.accountId, b.boundAt,
    ])) };
  }

  async create(options = {}) {
    return creationQueue(lockKey(this.registry), async () => {
      const context = await this.context();
      if (!context) throw temporaryPairingError('temporary_host_not_bound', 409);
      const pending = await this.registry.deliverySnapshot(context.bindingStamp);
      if (pending.records.filter((r) => !stopped(r) && !r.delivery.completionConfirmed).length >= 4) {
        throw temporaryPairingError('temporary_host_pending_capacity', 429);
      }
      const ticket = await this.registry.create({ capabilities: options.capabilities, claimTtlMs: options.claimTtlMs,
        accessTtlMs: options.accessTtlMs, delivery: context });
      if ((await this.context())?.bindingStamp !== context.bindingStamp) {
        await this.registry.revoke(ticket.envelope.invitation.invitationId);
        throw temporaryPairingError('temporary_host_binding_changed', 409);
      }
      return { ...ticket, brokerRegistered: false, businessAccessReady: false };
    });
  }

  async list() {
    await this.registry.deliverySnapshot((await this.context())?.bindingStamp || '');
    return this.registry.list();
  }

  async revoke(invitationId) {
    try { return await this.registry.revoke(invitationId); }
    finally { this.connectionService?.stop(invitationId); }
  }

  async prepareConnection(invitationId) {
    if (!this.connectionService) throw temporaryPairingError('temporary_connection_unavailable', 503);
    return this.connectionService.prepare(invitationId);
  }

  close() { this.connectionService?.close(); }

  /** Authentication only. A route adapter must separately enforce temporary capabilities and resource ownership. */
  async authenticateRequest({ credential, proof, method, targetUri }) {
    const context = await this.context();
    await this.registry.deliverySnapshot(context?.bindingStamp || '');
    if (!context) throw temporaryPairingError('temporary_host_not_bound', 401);
    const grantId = temporaryAccessGrantHint(credential?.access_token);
    const accepted = await this.registry.consumeAccessProof({ grantId, bindingStamp: context.bindingStamp, verifyProof: (r, now) => {
      verifyTemporaryAccessCredential(credential, { envelope: r.envelope, grant: r.grant,
        expectedInstance: this.registry.publicIdentity, now });
      return verifyTemporaryDpopProof(proof, { accessToken: credential.access_token,
        devicePublicKey: r.grant.devicePublicKey, method, targetUri, now });
    } });
    // Binding may change during durable proof IO. Do not return a principal under the previous binding.
    const current = await this.current(accepted.invitationId, context.bindingStamp);
    if (current.status !== 'CLAIMED' || this.clock() >= credential.expires_at) {
      throw temporaryPairingError('temporary_pairing_inactive', 410);
    }
    const principal = Object.freeze({ role: 'temporary', principalKind: 'temporary_device', principalId: grantId,
      grantId, deviceId: accepted.grant.deviceId, instanceId: accepted.instanceId,
      invitationId: accepted.invitationId, deviceKeyFingerprint: accepted.grant.deviceKeyFingerprint,
      capabilities: Object.freeze([...accepted.capabilities]), sessionScope: accepted.sessionScope, expiry: credential.expires_at,
      authMethod: 'temporary_device_dpop' });
    this.#authenticated.set(principal, context.bindingStamp);
    await this.revalidatePrincipal(principal);
    return principal;
  }

  /** Request-local identity, not a serializable bearer credential. Recheck after asynchronous work. */
  async revalidatePrincipal(principal) {
    const stamp = principal && this.#authenticated.get(principal);
    if (!stamp) throw temporaryPairingError('temporary_principal_invalid', 401);
    const context = await this.context();
    const snapshot = await this.registry.deliverySnapshot(context?.bindingStamp || '');
    const r = snapshot.records.find((entry) => entry.grant?.grantId === principal.grantId);
    const i = r?.envelope.invitation;
    if (!context || context.bindingStamp !== stamp || r?.delivery.bindingStamp !== stamp
      || r?.status !== 'CLAIMED' || !r.delivery.completionConfirmed
      || i.invitationId !== principal.invitationId || i.instanceId !== principal.instanceId
      || r.grant.deviceId !== principal.deviceId || r.grant.deviceKeyFingerprint !== principal.deviceKeyFingerprint
      || i.sessionScope !== principal.sessionScope || JSON.stringify(i.capabilities) !== JSON.stringify(principal.capabilities)
      || principal.expiry !== Math.floor(i.accessExpiresAt / 1000) * 1000
      || snapshot.now >= principal.expiry) {
      throw temporaryPairingError('temporary_pairing_inactive', 410);
    }
    if ((await this.context())?.bindingStamp !== stamp) {
      await this.registry.deliverySnapshot((await this.context())?.bindingStamp || '');
      throw temporaryPairingError('temporary_host_binding_changed', 409);
    }
    if (Math.max(snapshot.now, this.clock()) >= principal.expiry) {
      throw temporaryPairingError('temporary_pairing_inactive', 410);
    }
    return principal;
  }

  /** Private durable Run provenance, never a credential accepted by an HTTP adapter. */
  async operationAuthority(principal) {
    await this.revalidatePrincipal(principal);
    return parseTemporaryOperationAuthority({ version: 1, instanceId: principal.instanceId,
      grantId: principal.grantId, deviceId: principal.deviceId, invitationId: principal.invitationId,
      deviceKeyFingerprint: principal.deviceKeyFingerprint, bindingStamp: this.#authenticated.get(principal), expiresAt: principal.expiry });
  }

  /** Only accepted immutable message manifests call this. No principal is returned to a caller. */
  async authorizeStoredMessage(input, session) {
    const a = parseTemporaryOperationAuthority(input);
    const r = await this.current(a.invitationId, a.bindingStamp);
    if (r.status !== 'CLAIMED' || r.grant?.grantId !== a.grantId || r.grant.deviceId !== a.deviceId
      || r.grant.deviceKeyFingerprint !== a.deviceKeyFingerprint || r.envelope.invitation.instanceId !== a.instanceId)
      throw temporaryPairingError('temporary_pairing_inactive', 410);
    const principal = Object.freeze({ role: 'temporary', principalKind: 'temporary_device', principalId: a.grantId,
      grantId: a.grantId, deviceId: a.deviceId, instanceId: a.instanceId, invitationId: a.invitationId,
      deviceKeyFingerprint: a.deviceKeyFingerprint, capabilities: Object.freeze([...r.envelope.invitation.capabilities]),
      sessionScope: r.envelope.invitation.sessionScope, expiry: a.expiresAt, authMethod: 'temporary_stored_message' });
    this.#authenticated.set(principal, a.bindingStamp);
    return this.resourcePolicy.authorize(principal, 'message.commit', { session });
  }

  async current(invitationId, stamp, allowStopped = false) {
    const current = await this.context();
    const snapshot = await this.registry.deliverySnapshot(current?.bindingStamp || '');
    const r = snapshot.records.find((entry) => entry.envelope.invitation.invitationId === invitationId);
    if (allowStopped && r && stopped(r) && r.delivery.brokerUrl === this.client.baseUrl) return r;
    if (!r || current?.bindingStamp !== stamp || r.delivery.bindingStamp !== stamp) {
      throw temporaryPairingError('temporary_host_binding_changed', 409);
    }
    return r;
  }

  async tick({ signal } = {}) {
    return networkQueue(lockKey(this.registry), async () => {
      const context = await this.context();
      const snapshot = await this.registry.deliverySnapshot(context?.bindingStamp || '');
      if (signal?.aborted || snapshot.brokerRetryAt > snapshot.now) return { handled: false };
      const stamp = context?.bindingStamp || '';
      const r = snapshot.records.filter((entry) => (stopped(entry) || (context && entry.delivery.bindingStamp === stamp))
        && entry.delivery.brokerUrl === this.client.baseUrl && entry.delivery.nextAttemptAt <= snapshot.now
        && !(stopped(entry) && (entry.delivery.revocationConfirmed || entry.envelope.invitation.accessExpiresAt <= snapshot.now)))
        .sort((a, b) => a.delivery.lastAttemptAt - b.delivery.lastAttemptAt
          || a.envelope.invitation.createdAt - b.envelope.invitation.createdAt)[0];
      if (!r) return { handled: false };
      const invitationId = r.envelope.invitation.invitationId;
      try {
        await this.current(invitationId, stamp, stopped(r));
        const request = async (action, payload = {}) => {
          const current = await this.current(invitationId, stamp, action === 'revoke');
          if (action !== 'revoke' && stopped(current)) throw temporaryPairingError('temporary_pairing_inactive', 410);
          const response = await this.client.request(action, invitationId, payload, { signal });
          if (response.accessExpiresAt !== r.envelope.invitation.accessExpiresAt) throw temporaryPairingError('temporary_host_response_invalid', 502);
          return response;
        };
        if (stopped(r)) {
          const response = await request('revoke', { envelope: r.envelope });
          if (!['REVOKED', 'EXPIRED'].includes(response.status)) throw temporaryPairingError('temporary_host_response_invalid', 502);
          await this.registry.recordDelivery(invitationId, { revoked: true });
        } else if (r.delivery.registration !== 'REGISTERED') {
          const response = await request('register', { envelope: r.envelope });
          if (['REVOKED', 'EXPIRED'].includes(response.status)) throw temporaryPairingError('temporary_broker_inactive', 410);
          await this.registry.recordDelivery(invitationId, { registered: true });
        } else if (r.grant && !r.delivery.completionConfirmed) {
          const result = { grantId: r.grant.grantId, deviceId: r.grant.deviceId, deviceKeyFingerprint: r.grant.deviceKeyFingerprint,
            requestId: r.grant.requestId, grantedAt: r.grant.grantedAt, accessExpiresAt: r.envelope.invitation.accessExpiresAt };
          const accessCredential = issueTemporaryAccessCredential({ identity: this.registry.identity, envelope: r.envelope, grant: r.grant });
          const response = await request('complete', { result, accessCredential });
          if (response.status !== 'COMPLETED') throw temporaryPairingError('temporary_host_response_invalid', 502);
          await this.registry.recordDelivery(invitationId, { completedGrantId: r.grant.grantId,
            nextAttemptAt: snapshot.now + (this.connectionService ? 4_000 : 30_000) });
        } else {
          const response = await request('inbox');
          if (['REVOKED', 'EXPIRED'].includes(response.status)) throw temporaryPairingError('temporary_broker_inactive', 410);
          if (response.claim) {
            const current = await this.current(invitationId, stamp);
            if (stopped(current)) throw temporaryPairingError('temporary_pairing_inactive', 410);
            // The registry verifies both the token and device signature before a local grant can exist.
            if (response.claim.invitationId !== invitationId) throw temporaryPairingError('temporary_host_response_invalid', 502);
            await this.registry.claim(response.claim);
            await this.current(invitationId, stamp);
          }
          if (response.connectionRequest && this.connectionService) {
            const current = await this.current(invitationId, stamp);
            if (stopped(current) || !current.grant) throw temporaryPairingError('temporary_pairing_inactive', 410);
            const connectionRequestId = verifyTemporaryConnectionRequest(response.connectionRequest.request, {
              envelope: current.envelope, grant: current.grant, now: this.clock() });
            const ready = await this.connectionService.activate(invitationId);
            const payload = { connectionRequestId, bootstrap: ready.bootstrap, p2p: ready.p2p,
              carrierReady: ready.carrierReady, businessAccessReady: ready.businessAccessReady };
            const payloadDigest = temporaryHash(temporaryCanonicalJson(payload));
            if (!response.connectionRequest.published || response.connectionRequest.payloadDigest !== payloadDigest) {
              const published = await request('connection-publish', payload);
              if (published.connectionStatus !== 'READY' || published.connectionRequestId !== connectionRequestId) {
                throw temporaryPairingError('temporary_host_response_invalid', 502);
              }
            }
          }
          await this.registry.recordDelivery(invitationId, {
            nextAttemptAt: snapshot.now + (r.delivery.completionConfirmed && !this.connectionService ? 30_000 : 4_000) });
        }
        return { handled: true, invitationId };
      } catch (error) {
        if (error?.code === 'temporary_pairing_not_found') return { handled: false, invitationId, code: error.code };
        const code = /^temporary_[a-z0-9_]{1,65}$/.test(error?.code || '') ? error.code : 'temporary_host_unavailable';
        const remoteInactive = ['temporary_broker_inactive', 'temporary_broker_instance_unavailable'].includes(code);
        const terminal = remoteInactive || ['temporary_broker_result_conflict', 'temporary_broker_invitation_conflict',
          'temporary_host_binding_changed', 'temporary_pairing_inactive'].includes(code);
        if (terminal) await this.revoke(invitationId);
        const delay = Math.max(Math.min(60_000, 2_000 * 2 ** Math.min(r.delivery.attempts, 5)), error.retryAfterMs || 0);
        await this.registry.recordDelivery(invitationId, { errorCode: code, revoked: remoteInactive,
          nextAttemptAt: retryTime(Math.max(snapshot.now, this.clock()), delay),
          ...(code === 'temporary_host_rate_limited' ? { brokerRetryAt: retryTime(Math.max(snapshot.now, this.clock()), delay) } : {}) });
        return { handled: false, invitationId, code };
      }
    });
  }
}
