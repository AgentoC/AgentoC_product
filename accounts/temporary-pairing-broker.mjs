import { timingSafeEqual } from 'node:crypto';
import { checkedTemporaryId, temporaryHash, temporaryPairingError, temporaryPublicKey,
  temporaryInvitationDigest, verifyTemporaryInvitation, verifyTemporaryClaim } from '../lib/temporary-pairing-protocol.mjs';
import { temporaryCanonicalJson, verifyTemporaryBrokerProof } from '../lib/temporary-pairing-broker-protocol.mjs';
import { verifyTemporaryAccessCredential } from '../lib/temporary-device-access.mjs';
import { createTurnConnectionId, evaluateTurnConnectionAuthorization, publicTurnAuthorization } from '../lib/turn-authorization.mjs';
import { issueTurnBrokerCapability } from '../lib/turn-broker-capability.mjs';
import { getTurnConnectionLeases, resolveAccountEntitlement, activeTurnConnectionState } from './turn-lease-policy.mjs';
import { createTemporaryConnectionExchange } from './temporary-connection-exchange.mjs';

const fail = (code, status = 400) => { throw temporaryPairingError(`temporary_broker_${code}`, status); };
const terminal = (r) => r.status === 'REVOKED' || r.status === 'EXPIRED';
const context = (r) => JSON.stringify([r.instanceId, r.invitationId, r.claim.requestId]);
const bindingStamp = (binding) => JSON.stringify([binding.accountId, binding.boundAt, binding.instanceKeyFingerprint]);
const projection = (r) => ({ invitationId: r.invitationId, instanceId: r.instanceId, status: r.status, accessExpiresAt: r.accessExpiresAt });

/** Uses the existing Accounts transactional store. No Google phone credential is accepted or required. */
export function createTemporaryPairingBroker({ store, cipher, clock = Date.now, issuer, signTurnBrokerCapability, resolveEntitlement = resolveAccountEntitlement }) {
  if (!store?.mutate || !cipher?.seal || !cipher?.open) throw new Error('Temporary pairing requires storage and claim encryption');
  const connections = createTemporaryConnectionExchange(cipher);

  async function transaction(action) {
    const outcome = await store.mutate(async (draft) => {
      if (draft.temporaryPairingExchanges === undefined) draft.temporaryPairingExchanges = [];
      if (!Array.isArray(draft.temporaryPairingExchanges)) fail('store_invalid', 503);
      const observed = clock(); const previous = draft.temporaryPairingClock ?? 0;
      if (!Number.isSafeInteger(observed) || observed < 0 || !Number.isSafeInteger(previous) || previous < 0) fail('clock_invalid', 503);
      const now = Math.max(observed, previous); draft.temporaryPairingClock = now;
      for (const r of draft.temporaryPairingExchanges) {
        if (r.version !== 1 || !['REGISTERED', 'CLAIMED', 'COMPLETED', 'REVOKED', 'EXPIRED'].includes(r.status)
          || !Array.isArray(r.nonces)) fail('store_invalid', 503);
        let i;
        try { i = verifyTemporaryInvitation(r.envelope, { instanceId: r.instanceId,
          keyFingerprint: r.envelope?.invitation?.instanceKeyFingerprint }); }
        catch { fail('store_invalid', 503); }
        if (r.invitationId !== i.invitationId || r.claimExpiresAt !== i.claimExpiresAt || r.accessExpiresAt !== i.accessExpiresAt
          || (['CLAIMED', 'COMPLETED'].includes(r.status) && !r.claim)
          || (r.status === 'COMPLETED' && !r.completion)) fail('store_invalid', 503);
        const binding = draft.instanceBindings?.find((b) => b.instanceId === r.instanceId && !b.revokedAt);
        if (!terminal(r) && (!binding || bindingStamp(binding) !== r.bindingStamp)) r.status = 'REVOKED';
        const accessDeadline = Math.min(r.accessExpiresAt, r.completion?.payload?.accessCredential?.expires_at ?? r.accessExpiresAt);
        if (!terminal(r) && now >= (r.status === 'REGISTERED' ? r.claimExpiresAt : accessDeadline)) r.status = 'EXPIRED';
        if (r.turn) {
          if (r.turn.connectionId !== createTurnConnectionId({ accountId: r.accountId, instanceId: r.instanceId, deviceId: r.turn.deviceId })
            || !/^rtg_[A-Za-z0-9_-]{24,64}$/.test(r.turn.grantId || '')
            || !/^rdev_[A-Za-z0-9_-]{24,64}$/.test(r.turn.deviceId || '')
            || (!terminal(r) && (r.status !== 'COMPLETED'
              || r.turn.grantId !== r.completion.payload?.result?.grantId
              || r.turn.deviceId !== r.completion.payload?.result?.deviceId))) fail('store_invalid', 503);
        }
        if (terminal(r)) { r.sealedToken = null; r.completion = null; r.connection = null; releaseLease(draft, r, now, 'temporary-inactive'); }
        else connections.validate(r, now);
        r.nonces = r.nonces.filter((n) => n.expiresAt > now);
      }
      // Returning the failure commits expiry/revocation instead of rolling back the transaction.
      try { return { value: await action(draft, now) }; }
      catch (error) { return { failure: { code: error.code || 'temporary_broker_invalid', status: error.statusCode || 400 } }; }
    });
    if (outcome.failure) throw temporaryPairingError(outcome.failure.code, outcome.failure.status);
    return structuredClone(outcome.value);
  }

  function boundInstance(draft, instanceId) {
    checkedTemporaryId(instanceId, 'inst');
    const binding = draft.instanceBindings?.find((b) => b.instanceId === instanceId && !b.revokedAt);
    if (!binding?.instancePublicKey || !binding.accountId || !binding.boundAt
      || temporaryPublicKey(binding.instancePublicKey, true).fingerprint !== binding.instanceKeyFingerprint) fail('instance_unavailable', 403);
    return binding;
  }

  function record(draft, input) {
    checkedTemporaryId(input.invitationId, 'rti');
    const r = draft.temporaryPairingExchanges.find((x) => x.invitationId === input.invitationId && x.instanceId === input.instanceId);
    if (!r) fail('not_found', 404);
    return r;
  }

  function proof(action, input, r, key, now) {
    const nonce = verifyTemporaryBrokerProof(action, input, key, now);
    if (r.nonces.some((n) => n.nonceHash === nonce.nonceHash)) fail('proof_replayed', 409);
    if (r.nonces.length >= 128) fail('proof_capacity', 429);
    r.nonces.push(nonce);
  }

  function instanceProof(action, input, draft, r, now) {
    const binding = boundInstance(draft, input.instanceId);
    proof(action, input, r, binding.instancePublicKey, now);
  }

  function releaseLease(draft, r, now, reason) {
    if (!r.turn) return false;
    const lease = getTurnConnectionLeases(draft).find((entry) => entry.connectionId === r.turn.connectionId
      && entry.accountId === r.accountId && entry.instanceId === r.instanceId && entry.deviceId === r.turn.deviceId);
    if (!lease || lease.status === 'released') return false;
    Object.assign(lease, { status: 'released', updatedAt: new Date(now).toISOString(),
      releasedAt: new Date(now).toISOString(), releaseReason: reason });
    return true;
  }

  return {
    register(input) {
      return transaction((draft, now) => {
        const binding = boundInstance(draft, input.instanceId);
        const envelope = input.payload?.envelope;
        const i = verifyTemporaryInvitation(envelope, { instanceId: input.instanceId, keyFingerprint: binding.instanceKeyFingerprint });
        if (input.invitationId !== i.invitationId || now < i.createdAt || now >= i.claimExpiresAt) fail('invitation_expired', 410);
        let r = draft.temporaryPairingExchanges.find((x) => x.invitationId === i.invitationId);
        if (r) {
          if (r.instanceId !== i.instanceId || temporaryInvitationDigest(r.envelope.invitation) !== temporaryInvitationDigest(i)) fail('invitation_conflict', 409);
          instanceProof('register', input, draft, r, now);
          if (terminal(r)) fail('inactive', 410);
          return projection(r);
        }
        const nonce = verifyTemporaryBrokerProof('register', input, binding.instancePublicKey, now);
        draft.temporaryPairingExchanges = draft.temporaryPairingExchanges.filter((x) => !(terminal(x) && now >= x.accessExpiresAt + 600_000));
        if (draft.temporaryPairingExchanges.length >= 10_000
          || draft.temporaryPairingExchanges.filter((x) => x.instanceId === i.instanceId).length >= 256) fail('capacity', 429);
        r = { version: 1, invitationId: i.invitationId, instanceId: i.instanceId, accountId: binding.accountId,
          bindingStamp: bindingStamp(binding), envelope: { invitation: i,
            publicKey: temporaryPublicKey(envelope.publicKey, true).publicKey, signature: envelope.signature },
          claimExpiresAt: i.claimExpiresAt, accessExpiresAt: i.accessExpiresAt, status: 'REGISTERED',
          claim: null, sealedToken: null, completion: null, nonces: [nonce] };
        draft.temporaryPairingExchanges.push(r);
        return projection(r);
      });
    },

    claim(input) {
      const device = verifyTemporaryClaim(input);
      checkedTemporaryId(input.token, 'rtt');
      return transaction((draft, now) => {
        const r = record(draft, input);
        const i = r.envelope.invitation;
        if (temporaryInvitationDigest(i) !== input.invitationDigest
          || !timingSafeEqual(Buffer.from(i.secretHash, 'hex'), Buffer.from(temporaryHash(input.token), 'hex'))) fail('ticket_invalid', 401);
        if (terminal(r)) fail('inactive', 410);
        const claim = { instanceId: input.instanceId, invitationId: input.invitationId,
          invitationDigest: input.invitationDigest, requestId: input.requestId,
          devicePublicKey: device.publicKey, signature: input.signature };
        if (r.claim && (r.claim.requestId !== claim.requestId
          || temporaryPublicKey(r.claim.devicePublicKey).fingerprint !== device.fingerprint)) fail('already_claimed', 409);
        if (r.status === 'REGISTERED' && now >= r.claimExpiresAt) fail('invitation_expired', 410);
        // A valid exact-device retry can repair an encrypted token after broker key rotation.
        // Compute ciphertext before publishing any claim state (seal failure must not consume the invitation).
        const sealed = r.status === 'COMPLETED' ? null : cipher.seal(input.token, JSON.stringify([r.instanceId, r.invitationId, claim.requestId]));
        r.claim = claim; r.sealedToken = sealed;
        if (r.status === 'REGISTERED') r.status = 'CLAIMED';
        return projection(r);
      });
    },

    inbox(input) {
      return transaction((draft, now) => {
        const r = record(draft, input); instanceProof('inbox', input, draft, r, now);
        if (terminal(r)) fail('inactive', 410);
        return { ...projection(r), claim: r.status === 'CLAIMED'
          ? { ...r.claim, token: cipher.open(r.sealedToken, context(r)) } : null,
          connectionRequest: connections.inbox(r) };
      });
    },

    complete(input) {
      return transaction((draft, now) => {
        const r = record(draft, input); instanceProof('complete', input, draft, r, now);
        if (terminal(r)) fail('inactive', 410);
        if (!r.claim) fail('not_claimed', 409);
        const result = input.payload?.result;
        const keys = ['grantId', 'deviceId', 'deviceKeyFingerprint', 'requestId', 'grantedAt', 'accessExpiresAt'];
        if (!result || Object.keys(input.payload).some((k) => !['result', 'accessCredential'].includes(k))
          || Object.keys(result).length !== keys.length || Object.keys(result).some((k) => !keys.includes(k))
          || result.requestId !== r.claim.requestId || result.accessExpiresAt !== r.accessExpiresAt
          || result.deviceKeyFingerprint !== temporaryPublicKey(r.claim.devicePublicKey).fingerprint
          || !Number.isSafeInteger(result.grantedAt) || result.grantedAt < r.envelope.invitation.createdAt
          || result.grantedAt >= r.claimExpiresAt || result.grantedAt > now) fail('result_invalid');
        checkedTemporaryId(result.grantId, 'rtg'); checkedTemporaryId(result.deviceId, 'rdev');
        if (Object.hasOwn(input.payload, 'accessCredential')) {
          verifyTemporaryAccessCredential(input.payload.accessCredential, { envelope: r.envelope,
            grant: { ...result, devicePublicKey: r.claim.devicePublicKey }, expectedInstance: {
              instanceId: r.instanceId, keyFingerprint: r.envelope.invitation.instanceKeyFingerprint }, now });
        }
        if (r.completion && temporaryCanonicalJson(r.completion.payload) !== temporaryCanonicalJson(input.payload)) fail('result_conflict', 409);
        if (!r.completion) r.completion = structuredClone({ instanceId: input.instanceId, invitationId: input.invitationId,
          requestId: input.requestId, issuedAt: input.issuedAt, nonce: input.nonce, signature: input.signature, payload: input.payload });
        r.status = 'COMPLETED'; r.sealedToken = null;
        return projection(r);
      });
    },

    result(input) {
      return transaction((draft, now) => {
        const r = record(draft, input);
        if (!r.claim || input.requestId !== r.claim.requestId) fail('not_found', 404);
        proof('result', input, r, r.claim.devicePublicKey, now);
        if (terminal(r)) fail('inactive', 410);
        return { ...projection(r), completion: r.completion };
      });
    },

    connect(input) {
      return transaction((draft, now) => {
        const r = record(draft, input);
        if (!r.claim || input.requestId !== r.claim.requestId) fail('not_found', 404);
        proof('connect', input, r, r.claim.devicePublicKey, now);
        if (terminal(r)) fail('inactive', 410);
        return { ...projection(r), ...connections.request(r, input, now) };
      });
    },

    'connection-publish'(input) {
      return transaction((draft, now) => {
        const r = record(draft, input); instanceProof('connection-publish', input, draft, r, now);
        if (terminal(r)) fail('inactive', 410);
        return { ...projection(r), ...connections.publish(r, input, now) };
      });
    },

    'connection-result'(input) {
      return transaction((draft, now) => {
        const r = record(draft, input);
        if (!r.claim || input.requestId !== r.claim.requestId) fail('not_found', 404);
        proof('connection-result', input, r, r.claim.devicePublicKey, now);
        if (terminal(r)) fail('inactive', 410);
        return { ...projection(r), ...connections.result(r, input, now) };
      });
    },

    'turn-reserve'(input) {
      return transaction(async (draft, now) => {
        const r = record(draft, input); instanceProof('turn-reserve', input, draft, r, now);
        if (terminal(r)) fail('inactive', 410);
        if (r.status !== 'COMPLETED' || !r.completion?.payload?.accessCredential) fail('not_completed', 409);
        if (!input.payload || Object.keys(input.payload).length !== 0) fail('turn_request_invalid');
        const result = r.completion.payload.result; const credential = r.completion.payload.accessCredential;
        verifyTemporaryAccessCredential(credential, { envelope: r.envelope, grant: { ...result, devicePublicKey: r.claim.devicePublicKey },
          expectedInstance: { instanceId: r.instanceId, keyFingerprint: r.envelope.invitation.instanceKeyFingerprint }, now });
        const connectionId = createTurnConnectionId({ accountId: r.accountId, instanceId: r.instanceId, deviceId: result.deviceId });
        const leases = getTurnConnectionLeases(draft);
        const existing = leases.find((entry) => entry.connectionId === connectionId);
        if (existing && (existing.accountId !== r.accountId || existing.instanceId !== r.instanceId
          || existing.deviceId !== result.deviceId || existing.deviceKind !== 'phone')) fail('turn_identity_conflict', 409);
        const active = activeTurnConnectionState(draft, r.accountId, now, { excludeConnectionId: connectionId });
        const entitlement = resolveEntitlement(draft, r.accountId, now);
        const quotaDeviceId = `temporary_${result.deviceKeyFingerprint}`;
        const decision = evaluateTurnConnectionAuthorization({ accountId: r.accountId, instanceId: r.instanceId,
          deviceId: quotaDeviceId, deviceKind: 'phone', accountPlan: entitlement.plan, limits: entitlement.limits,
          activeDeviceIds: active.activePhoneDeviceIds, activeInstanceIds: active.activeInstanceIds,
          activePhones: active.activePhoneDeviceIds.length, activeComputers: active.activeInstanceIds.length, nowMs: now });
        if (!decision.authorized) fail('turn_quota_exceeded', 429);
        // Sign before changing lease state. A failed signer must not leak quota or release a concurrent lease.
        const brokerCredential = await issueTurnBrokerCapability({ signCapability: signTurnBrokerCapability, issuer,
          accountId: r.accountId, instanceId: r.instanceId, deviceId: result.deviceId, connectionId, nowMs: now,
          temporaryGrant: { grantId: result.grantId, invitationId: r.invitationId, accessExpiresAt: credential.expires_at } });
        const latest = Math.max(now, clock());
        if (latest >= credential.expires_at) {
          r.status = 'EXPIRED'; r.completion = null; r.sealedToken = null; r.connection = null;
          releaseLease(draft, r, latest, 'temporary-expired'); fail('inactive', 410);
        }
        const timestamp = new Date(now).toISOString();
        const lease = existing || { connectionId, accountId: r.accountId, instanceId: r.instanceId,
          deviceId: result.deviceId, deviceKind: 'phone', createdAt: timestamp };
        Object.assign(lease, { quotaDeviceId, plan: entitlement.plan, status: 'reserved', updatedAt: timestamp,
          expiresAt: new Date(credential.expires_at).toISOString(), releasedAt: '', releaseReason: '' });
        if (!existing) leases.push(lease);
        r.turn = { connectionId, deviceId: result.deviceId, grantId: result.grantId };
        return { ...projection(r), authorization: publicTurnAuthorization({ ...decision, connectionId }),
          lease: structuredClone(lease), brokerCredential };
      });
    },

    'turn-release'(input) {
      return transaction((draft, now) => {
        const r = record(draft, input); instanceProof('turn-release', input, draft, r, now);
        if (!input.payload || Object.keys(input.payload).length !== 0) fail('turn_request_invalid');
        return { ...projection(r), released: releaseLease(draft, r, now, 'temporary-client-release') };
      });
    },

    revoke(input) {
      return transaction((draft, now) => {
        let r = draft.temporaryPairingExchanges.find((entry) => entry.invitationId === input.invitationId);
        if (!r) {
          // Persist an owner-signed stop even when an earlier registration is still in flight.
          // Otherwise a late register could recreate an exchange after a 404 revoke response.
          const binding = boundInstance(draft, input.instanceId);
          const envelope = input.payload?.envelope;
          const i = verifyTemporaryInvitation(envelope, { instanceId: input.instanceId, keyFingerprint: binding.instanceKeyFingerprint });
          if (i.invitationId !== input.invitationId) fail('invitation_conflict', 409);
          const nonce = verifyTemporaryBrokerProof('revoke', input, binding.instancePublicKey, now);
          draft.temporaryPairingExchanges = draft.temporaryPairingExchanges.filter((x) => !(terminal(x) && now >= x.accessExpiresAt + 600_000));
          if (draft.temporaryPairingExchanges.length >= 10_000
            || draft.temporaryPairingExchanges.filter((x) => x.instanceId === i.instanceId).length >= 256) fail('capacity', 429);
          r = { version: 1, invitationId: i.invitationId, instanceId: i.instanceId, accountId: binding.accountId,
            bindingStamp: bindingStamp(binding), envelope: { invitation: i,
              publicKey: temporaryPublicKey(envelope.publicKey, true).publicKey, signature: envelope.signature },
            claimExpiresAt: i.claimExpiresAt, accessExpiresAt: i.accessExpiresAt, status: 'REVOKED',
            claim: null, sealedToken: null, completion: null, nonces: [nonce] };
          draft.temporaryPairingExchanges.push(r);
          return projection(r);
        }
        if (r.instanceId !== input.instanceId) fail('not_found', 404);
        instanceProof('revoke', input, draft, r, now);
        if (!terminal(r)) r.status = 'REVOKED';
        r.sealedToken = null; r.completion = null; r.connection = null;
        releaseLease(draft, r, now, 'temporary-revoked');
        return projection(r);
      });
    },
  };
}
