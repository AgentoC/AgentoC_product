import { randomBytes } from 'node:crypto';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { temporarySignalingEndpoint } from '../lib/temporary-connection-contract.mjs';
import { createTurnConnectionId } from '../lib/turn-authorization.mjs';
import { requestTurnCredentials } from '../lib/turn-credential-broker-client.mjs';
import { temporaryControlRelayPrincipal } from '../lib/temporary-control-broker-protocol.mjs';

const queue = createKeyedTaskQueue();
const fail = (suffix, status = 503) => { throw temporaryPairingError(`temporary_control_connection_${suffix}`, status); };

/** One carrier per confirmed grant. Persist the room before it can be published. */
export class TemporaryControlConnectionService {
  constructor({ registry, host, client, binding, brokerUrl, signalingEndpoint, ingress, startCarrier,
    mint = requestTurnCredentials, clock = Date.now }) {
    Object.assign(this, { registry, host, client, binding, brokerUrl, ingress, startCarrier, mint, clock });
    this.signalingEndpoint = temporarySignalingEndpoint(signalingEndpoint);
    this.carriers = new Map(); this.closed = false;
  }

  stop(grantId) {
    const entry = this.carriers.get(grantId);
    if (!entry) return;
    this.carriers.delete(grantId); entry.stopped = true;
    clearTimeout(entry.timer); clearTimeout(entry.poll);
    try { entry.agent?.stop(); } catch {}
  }

  close() { this.closed = true; for (const id of this.carriers.keys()) this.stop(id); }

  async current(grantId) {
    if (this.closed) fail('stopped');
    const material = await this.registry.accessMaterial(grantId);
    const credential = await this.host.credentialForGrant(grantId);
    if (this.clock() >= credential.expires_at) fail('inactive', 410);
    return { material, credential };
  }

  async activate(grantId, connectionRequestId) {
    return queue(`${this.registry.filePath}:${grantId}`, () => this.activateOnce(grantId, connectionRequestId));
  }

  async activateOnce(grantId, connectionRequestId) {
    if (!/^rtr_[A-Za-z0-9_-]{24,64}$/.test(connectionRequestId || '')) fail('request_invalid', 400);
    const { material, credential } = await this.current(grantId);
    const { envelope, grant } = material; const invitationId = envelope.invitation.invitationId;
    let connection = await this.registry.connectionState(grantId);
    if (connection && connection.connectionRequestId !== connectionRequestId) fail('request_conflict', 409);
    if (!connection) {
      const bound = await this.binding();
      const relayPrincipal = bound?.accountId || temporaryControlRelayPrincipal(envelope.invitation.instanceId, envelope.invitation.instanceKeyFingerprint);
      const reservation = await this.client.request('turn-reserve', invitationId);
      await this.current(grantId);
      const connectionId = createTurnConnectionId({ accountId: relayPrincipal,
        instanceId: envelope.invitation.instanceId, deviceId: grant.deviceId });
      if (reservation.status !== 'ACTIVE' || reservation.accessExpiresAt !== material.accessExpiresAt
        || reservation.lease?.accountId !== relayPrincipal || reservation.lease?.instanceId !== envelope.invitation.instanceId
        || reservation.lease?.deviceId !== grant.deviceId || reservation.lease?.connectionId !== connectionId
        || reservation.lease?.deviceKind !== 'phone' || reservation.lease?.status !== 'reserved'
        || Date.parse(reservation.lease?.expiresAt) !== credential.expires_at
        || reservation.brokerCredential?.scope !== 'turn:mint:temporary'
        || reservation.brokerCredential?.connectionId !== connectionId
        || Date.parse(reservation.brokerCredential?.credentialExpiresAt) !== credential.expires_at
        || reservation.authorization?.authorized !== true || reservation.authorization?.connectionId !== connectionId) fail('reservation_invalid');
      const turn = await this.mint({ brokerUrl: this.brokerUrl, authMode: 'accounts-capability',
        capabilityToken: reservation.brokerCredential.token, accountId: relayPrincipal,
        instanceId: envelope.invitation.instanceId, deviceId: grant.deviceId, connectionId,
        idempotencyKey: reservation.brokerCredential.idempotencyKey, clock: this.clock,
        temporaryGrant: { grantId, invitationId, accessExpiresAt: credential.expires_at } });
      await this.current(grantId);
      const secret = randomBytes(32).toString('hex');
      connection = { version: 1, instanceId: envelope.invitation.instanceId, invitationId, grantId,
        deviceId: grant.deviceId, connectionId, connectionRequestId, issuedAt: this.clock(),
        expiresAt: Date.parse(turn.expiresAt), signalingEndpoint: this.signalingEndpoint,
        roomId: createP2PRoomId(secret), secret, iceServers: turn.iceServers };
      connection = await this.registry.connectionState(grantId, connection);
    }
    let entry = this.carriers.get(grantId);
    if (!entry) {
      if (this.carriers.size >= 3) fail('capacity', 429);
      entry = { stopped: false, agent: null }; this.carriers.set(grantId, entry);
      try {
        const device = { instanceId: connection.instanceId, grantId, deviceId: connection.deviceId,
          accessExpiresAt: material.accessExpiresAt };
        entry.agent = await this.startCarrier({ signalingUrl: connection.signalingEndpoint, roomId: connection.roomId,
          secret: connection.secret, expiresAt: new Date(connection.expiresAt).toISOString(),
          iceServers: connection.iceServers, relayOnly: true, temporaryControlDevice: device,
          temporaryControlIngress: await this.ingress(device) });
        if (!entry.agent?.ready?.then || !entry.agent?.done?.then || typeof entry.agent.stop !== 'function'
          || entry.agent.temporaryBusinessReady !== true) fail('carrier_invalid');
        const ended = () => { if (this.carriers.get(grantId) === entry) this.stop(grantId); };
        entry.agent.done.then(ended, ended);
        let timeout;
        try { await Promise.race([entry.agent.ready, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(temporaryPairingError('temporary_control_connection_start_timeout', 503)), 15_000);
          timeout.unref?.();
        })]); } finally { clearTimeout(timeout); }
        await this.current(grantId);
        if (entry.stopped || this.closed) fail('stopped');
        entry.timer = setTimeout(() => this.stop(grantId), Math.max(0, connection.expiresAt - this.clock()));
        entry.timer.unref?.();
        const check = async () => {
          try { await this.current(grantId); } catch { this.stop(grantId); }
          if (!entry.stopped) { entry.poll = setTimeout(check, 1000); entry.poll.unref?.(); }
        };
        entry.poll = setTimeout(check, 1000); entry.poll.unref?.();
      } catch (error) { try { entry.agent?.stop(); } catch {} this.stop(grantId); throw error; }
    }
    await this.current(grantId);
    const result = await this.client.request('connection-publish', invitationId, { connectionRequestId, connection });
    if (result.connectionStatus !== 'READY' || result.connectionRequestId !== connectionRequestId) fail('publish_invalid');
    await this.current(grantId);
    return connection;
  }
}
