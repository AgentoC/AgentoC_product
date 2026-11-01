import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';

const fail = (suffix, status = 502) => { throw temporaryPairingError(`temporary_control_${suffix}`, status); };

// Synchronizes the local, authoritative grant registry with the encrypted
// Accounts rendezvous.  The broker can deliver a claim but cannot activate a
// grant: activation and credential issuance stay on the owning desktop.
export class TemporaryControlService {
  constructor({ registry, host, client, connectionService = null }) {
    if (!registry?.create || !registry?.claim || !registry?.confirm || !registry?.revoke || !registry?.list
      || !host?.credentialForGrant || !client?.request) throw new TypeError('Temporary control service dependencies are required');
    this.registry = registry; this.host = host; this.client = client; this.connectionService = connectionService;
  }

  async create() {
    const ticket = await this.registry.create(); const invitationId = ticket.envelope.invitation.invitationId;
    try {
      const response = await this.client.request('register', invitationId, { envelope: ticket.envelope });
      if (response.status !== 'REGISTERED') fail('broker_response_invalid');
      return ticket;
    } catch (error) {
      await this.registry.revoke(invitationId).catch(() => {});
      throw error;
    }
  }

  async sync(invitationId) {
    let response;
    try { response = await this.client.request('inbox', invitationId); }
    catch (error) {
      if (error?.statusCode === 410 || error?.code === 'temporary_control_broker_binding_mismatch') {
        const revoked = await this.registry.revoke(invitationId);
        if (revoked.grant?.grantId) this.connectionService?.stop(revoked.grant.grantId);
      }
      throw error;
    }
    if (response.status === 'CLAIMED' && response.claim) await this.registry.claim(response.claim);
    if (response.status === 'EXPIRED' || response.status === 'REVOKED') await this.registry.revoke(invitationId).catch(() => {});
    const current = await this.find(invitationId);
    // A lost complete response leaves the local grant active and the broker
    // claimed. Re-publish the same grant without restarting its ten minutes.
    if (response.status === 'CLAIMED' && current.status === 'ACTIVE') return this.confirm(invitationId);
    if (response.status === 'ACTIVE' && current.status === 'ACTIVE' && response.connectionRequestId) {
      if (!this.connectionService) fail('connection_unavailable', 503);
      await this.connectionService.activate(current.grant.grantId, response.connectionRequestId);
    }
    return current;
  }

  async confirm(invitationId) {
    const current = await this.find(invitationId);
    const active = current.status === 'ACTIVE' ? current : await (async () => {
      await this.sync(invitationId);
      return this.registry.confirm(invitationId);
    })();
    const credential = await this.host.credentialForGrant(active.grant.grantId);
    const response = await this.client.request('complete', invitationId, { grant: active.grant, accessCredential: credential });
    if (response.status !== 'ACTIVE' || response.accessExpiresAt !== active.accessExpiresAt) fail('broker_response_invalid');
    return active;
  }

  async revoke(invitationId) {
    const revoked = await this.registry.revoke(invitationId);
    if (revoked.grant?.grantId) this.connectionService?.stop(revoked.grant.grantId);
    try {
      const response = await this.client.request('revoke', invitationId);
      if (response.status !== 'REVOKED' && response.status !== 'EXPIRED') fail('broker_response_invalid');
    } catch (error) {
      // Local revocation is authoritative for the carrier and is committed
      // before network I/O. Surface the broker failure so the UI retries it.
      error.localRevocation = revoked;
      throw error;
    }
    return revoked;
  }

  async list() {
    const local = await this.registry.list();
    for (const item of local) {
      if (item.status === 'PENDING' || item.status === 'CLAIMED' || item.status === 'ACTIVE') {
        try { await this.sync(item.invitationId); } catch (error) {
          if (error?.statusCode !== 410) throw error;
        }
      }
    }
    return this.registry.list();
  }

  close() { this.connectionService?.close(); }

  async find(invitationId) {
    const all = await this.registry.list(); const result = all.find((item) => item.invitationId === invitationId);
    if (!result) fail('not_found', 404);
    return result;
  }
}
