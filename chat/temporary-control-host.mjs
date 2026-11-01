// Authenticator for the v2 control carrier. It turns a verified device-bound
// credential plus one-use DPoP proof into a request-local temporary principal.
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { issueTemporaryControlAccessCredential, temporaryControlGrantHint,
  verifyTemporaryControlAccessCredential, verifyTemporaryControlDpopProof } from '../lib/temporary-control-access.mjs';

const fail = (code, statusCode = 401) => { throw temporaryPairingError(code, statusCode); };

export class TemporaryControlHost {
  #authenticated = new WeakSet();

  constructor({ registry, clock = Date.now }) {
    if (!registry?.accessMaterial || !registry?.consumeAccessProof || !registry?.activeGrant) {
      throw new TypeError('TemporaryControlRegistry is required');
    }
    this.registry = registry;
    this.clock = clock;
  }

  async credentialForGrant(grantId) {
    const material = await this.registry.accessMaterial(grantId);
    return issueTemporaryControlAccessCredential({ identity: this.registry.identity,
      envelope: material.envelope, material });
  }

  async authenticateRequest({ credential, proof, method, targetUri }) {
    const grantId = temporaryControlGrantHint(credential?.access_token);
    const material = await this.registry.accessMaterial(grantId);
    const now = this.clock();
    verifyTemporaryControlAccessCredential(credential, { envelope: material.envelope, material,
      expectedInstance: this.registry.publicIdentity, now });
    await this.registry.consumeAccessProof({ grantId, verifyProof: (record, observedNow) => {
      // Freshly read record prevents a credential from surviving revoke or
      // expiry while a request waits for the registry transaction.
      const live = { envelope: record.envelope, claim: record.claim, grant: record.grant,
        accessExpiresAt: record.accessExpiresAt };
      verifyTemporaryControlAccessCredential(credential, { envelope: live.envelope, material: live,
        expectedInstance: this.registry.publicIdentity, now: observedNow });
      return verifyTemporaryControlDpopProof(proof, { credential, material: live, method, targetUri, now: observedNow });
    } });
    const principal = Object.freeze({ role: 'temporary', principalKind: 'temporary_device', principalId: grantId,
      grantId, deviceId: material.grant.deviceId, instanceId: material.envelope.invitation.instanceId,
      invitationId: material.envelope.invitation.invitationId,
      deviceKeyFingerprint: material.claim.deviceKeyFingerprint,
      capabilities: Object.freeze([...material.envelope.invitation.capabilities]),
      sessionScope: material.envelope.invitation.sessionScope, expiry: material.accessExpiresAt,
      authMethod: 'temporary_control_dpop' });
    this.#authenticated.add(principal);
    return principal;
  }

  async revalidatePrincipal(principal) {
    if (!this.#authenticated.has(principal)) fail('temporary_control_principal_invalid');
    const material = await this.registry.accessMaterial(principal.grantId);
    if (this.clock() >= material.accessExpiresAt || principal.deviceId !== material.grant.deviceId
      || principal.instanceId !== material.envelope.invitation.instanceId
      || principal.invitationId !== material.envelope.invitation.invitationId
      || principal.deviceKeyFingerprint !== material.claim.deviceKeyFingerprint
      || principal.expiry !== material.accessExpiresAt) fail('temporary_control_inactive', 410);
    return principal;
  }
}
