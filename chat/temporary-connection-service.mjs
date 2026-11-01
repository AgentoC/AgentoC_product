// Internal PC connection preparation and carrier lifecycle. Neither grants business API authority.
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { issueTemporaryAccessCredential } from '../lib/temporary-device-access.mjs';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { requestTurnCredentials } from '../lib/turn-credential-broker-client.mjs';
import { createTurnConnectionId } from '../lib/turn-authorization.mjs';
import { buildTemporaryConnectionContract, temporarySignalingEndpoint,
  verifyTemporaryConnectionContract, verifyTemporaryP2PAccess } from '../lib/temporary-connection-contract.mjs';
import { handleTemporaryCarrierRequest } from './temporary-carrier-ingress.mjs';

const queue = createKeyedTaskQueue();
const fail = (suffix, status = 503) => { throw temporaryPairingError(`temporary_connection_${suffix}`, status); };

export class TemporaryConnectionService {
  constructor({ host, brokerUrl, signalingEndpoint, clock = Date.now, mint = requestTurnCredentials, startCarrier = null }) {
    this.host = host; this.brokerUrl = brokerUrl; this.signalingEndpoint = temporarySignalingEndpoint(signalingEndpoint);
    this.clock = clock; this.mint = mint; this.closed = false; this.startCarrier = startCarrier;
    this.carriers = new Map(); this.starting = new Map();
  }

  close() { this.closed = true; for (const id of this.carriers.keys()) this.stop(id); }

  stop(invitationId) {
    const entry = this.carriers.get(invitationId);
    if (!entry) return;
    entry.stopped = true; clearTimeout(entry.expiryTimer); clearTimeout(entry.pollTimer); clearTimeout(entry.startTimer);
    try { entry.agent?.stop(); } catch {}
    finally { entry.cancel?.(); this.carriers.delete(invitationId); }
  }

  async current(invitationId, stamp) {
    if (this.closed) fail('stopped');
    const record = await this.host.current(invitationId, stamp);
    if (record.status !== 'CLAIMED' || !record.delivery.completionConfirmed) fail('inactive', 410);
    const state = await this.host.registry.connectionState(invitationId, stamp);
    if (this.closed) fail('stopped');
    if ((await this.host.context())?.bindingStamp !== stamp) fail('inactive', 410);
    return { ...state, now: Math.max(state.now, this.clock()) };
  }

  /** Call only after authenticated enrollment. Public adapters still need a fresh device proof and resource policy. */
  async prepare(invitationId) {
    const path = this.host.registry.filePath;
    const key = `${process.platform === 'win32' ? path.toLowerCase() : path}:${invitationId}`;
    return queue(key, async () => {
      const context = await this.host.context();
      if (!context) fail('inactive', 410);
      const stamp = context.bindingStamp;
      let { record: r, now } = await this.current(invitationId, stamp);
      const credential = issueTemporaryAccessCredential({ identity: this.host.registry.identity, envelope: r.envelope, grant: r.grant });
      let bootstrap = r.connection.bootstrap;
      const validate = (candidate, when) => verifyTemporaryConnectionContract(candidate, {
        envelope: r.envelope, grant: r.grant, credential, expectedInstance: this.host.registry.publicIdentity, now: when });
      // Response-loss recovery uses the persisted original room and contract without another quota/mint request.
      if (!bootstrap || Date.parse(bootstrap.expiresAt) <= now) {
        const reservation = await this.host.client.request('turn-reserve', invitationId);
        ({ record: r, now } = await this.current(invitationId, stamp));
        const binding = await this.host.binding();
        const connectionId = createTurnConnectionId({ accountId: binding?.accountId,
          instanceId: r.envelope.invitation.instanceId, deviceId: r.grant.deviceId });
        if (reservation.status !== 'COMPLETED' || reservation.accessExpiresAt !== r.envelope.invitation.accessExpiresAt
          || reservation.lease?.accountId !== binding?.accountId || reservation.lease?.instanceId !== r.envelope.invitation.instanceId
          || reservation.lease?.deviceId !== r.grant.deviceId || reservation.lease?.deviceKind !== 'phone'
          || reservation.lease?.connectionId !== connectionId || reservation.lease?.status !== 'reserved'
          || Date.parse(reservation.lease?.expiresAt) !== credential.expires_at
          || reservation.authorization?.authorized !== true || reservation.authorization?.connectionId !== connectionId
          || reservation.brokerCredential?.scope !== 'turn:mint:temporary'
          || reservation.brokerCredential?.connectionId !== connectionId
          || Date.parse(reservation.brokerCredential?.credentialExpiresAt) !== credential.expires_at
          || Date.parse(reservation.brokerCredential?.expiresAt) <= now) fail('reservation_invalid');
        const turn = await this.mint({ brokerUrl: this.brokerUrl, authMode: 'accounts-capability',
          capabilityToken: reservation.brokerCredential.token, accountId: binding.accountId,
          instanceId: r.envelope.invitation.instanceId, deviceId: r.grant.deviceId, connectionId,
          idempotencyKey: reservation.brokerCredential.idempotencyKey, clock: this.clock, nowMs: now,
          temporaryGrant: { grantId: r.grant.grantId, invitationId, accessExpiresAt: credential.expires_at } });
        ({ record: r, now } = await this.current(invitationId, stamp));
        bootstrap = buildTemporaryConnectionContract({ identity: this.host.registry.identity, envelope: r.envelope,
          grant: r.grant, credential, turn, authorization: reservation.authorization, issuedAtMs: now,
          p2p: { ...r.connection.p2p, signalingEndpoint: this.signalingEndpoint } });
        await this.host.registry.connectionState(invitationId, stamp, bootstrap);
      }
      ({ record: r, now } = await this.current(invitationId, stamp));
      validate(bootstrap, now);
      const p2p = verifyTemporaryP2PAccess(bootstrap, { ...r.connection.p2p, signalingEndpoint: this.signalingEndpoint });
      if (this.closed) fail('stopped');
      // Reserved quota expires with the grant even if IO fails. Do not release an ambiguously delivered
      // reservation here: a late release could cancel a newer reservation for the same connection.
      return { bootstrap, p2p, businessAccessReady: false, carrierReady: false };
    });
  }

  /** Internal lifecycle only; the carrier ingress authenticates and scopes each permitted temporary business request. */
  async activate(invitationId) {
    if (this.starting.has(invitationId)) return this.starting.get(invitationId);
    const work = this.activateOnce(invitationId);
    this.starting.set(invitationId, work);
    try { return await work; } finally { if (this.starting.get(invitationId) === work) this.starting.delete(invitationId); }
  }

  async activateOnce(invitationId) {
    if (typeof this.startCarrier !== 'function') fail('carrier_unavailable');
    const context = await this.host.context();
    if (!context) fail('inactive', 410);
    await this.current(invitationId, context.bindingStamp);
    const existing = this.carriers.get(invitationId);
    if (existing && !existing.stopped) {
      if (Date.parse(existing.result.bootstrap.expiresAt) <= this.clock()) { this.stop(invitationId); fail('inactive', 410); }
      return structuredClone(existing.result);
    }
    if (this.carriers.size >= 3) fail('carrier_capacity', 429);
    const entry = { stopped: false, agent: null };
    this.carriers.set(invitationId, entry);
    try {
      const prepared = await this.prepare(invitationId);
      if (entry.stopped || this.closed) fail('stopped');
      entry.result = { ...prepared, carrierReady: true };
      const temporaryDevice = { instanceId: prepared.bootstrap.instanceId,
        grantId: prepared.bootstrap.temporaryAccess.grantId,
        deviceId: prepared.bootstrap.deviceId,
        accessExpiresAt: Date.parse(prepared.bootstrap.temporaryAccess.expiresAt) };
      entry.agent = await this.startCarrier({ signalingUrl: prepared.p2p.signalingEndpoint,
        roomId: prepared.p2p.roomId, secret: prepared.p2p.secret, expiresAt: prepared.bootstrap.expiresAt,
        iceServers: prepared.bootstrap.turn.iceServers, relayOnly: true,
        temporaryDevice,
        temporaryIngress: (req, res) => handleTemporaryCarrierRequest(req, res, { host: this.host, temporaryDevice }) });
      if (!entry.agent || typeof entry.agent.stop !== 'function' || !entry.agent.ready?.then || !entry.agent.done?.then) fail('carrier_invalid');
      if (entry.stopped || this.closed) fail('stopped');
      const ended = () => { if (this.carriers.get(invitationId) === entry) this.stop(invitationId); };
      entry.agent.done.then(ended, ended);
      const aborted = new Promise((_, reject) => { entry.cancel = () => reject(temporaryPairingError('temporary_connection_stopped', 503)); });
      const startup = new Promise((_, reject) => {
        entry.startTimer = setTimeout(() => reject(temporaryPairingError('temporary_connection_start_timeout', 503)), 15_000);
        entry.startTimer.unref?.();
      });
      await Promise.race([entry.agent.ready, aborted, startup]); clearTimeout(entry.startTimer); entry.cancel = null;
      const current = await this.current(invitationId, context.bindingStamp);
      if (entry.stopped || this.closed || Date.parse(prepared.bootstrap.expiresAt) <= current.now) fail('inactive', 410);
      entry.result.businessAccessReady = entry.agent.temporaryBusinessReady === true;
      entry.expiryTimer = setTimeout(() => this.stop(invitationId), Date.parse(prepared.bootstrap.expiresAt) - current.now);
      entry.expiryTimer.unref?.();
      const check = async () => {
        try {
          const state = await this.current(invitationId, context.bindingStamp);
          if (state.now >= Date.parse(prepared.bootstrap.expiresAt)) fail('inactive', 410);
        } catch { if (this.carriers.get(invitationId) === entry) this.stop(invitationId); }
        if (!entry.stopped) { entry.pollTimer = setTimeout(check, 1_000); entry.pollTimer.unref?.(); }
      };
      entry.pollTimer = setTimeout(check, 1_000); entry.pollTimer.unref?.();
      return structuredClone(entry.result);
    } catch (error) {
      // A handle returned after revoke/shutdown must be stopped even after its Map entry was removed.
      try { entry.agent?.stop(); } catch {}
      if (this.carriers.get(invitationId) === entry) this.stop(invitationId);
      throw error;
    }
  }
}
