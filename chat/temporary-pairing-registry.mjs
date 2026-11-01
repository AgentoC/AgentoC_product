// PC authorization facts and delivery journal. This module issues no business bearer or account authority.
// Like trusted-devices.json, this store must have one host process as its sole writer.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKeyedTaskQueue, writeJsonAtomic } from './fs-utils.mjs';
import { publicInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { issueTemporaryAccessCredential } from '../lib/temporary-device-access.mjs';
import { verifyTemporaryConnectionContract, verifyTemporaryP2PAccess } from '../lib/temporary-connection-contract.mjs';
import {
  TEMPORARY_PAIRING_CAPABILITIES, TEMPORARY_ACCESS_MAX_MS, TEMPORARY_CLAIM_MAX_MS,
  checkedTemporaryId, temporaryHash, temporaryPairingError, temporaryPublicKey,
  normalizeTemporaryInvitation, buildTemporaryInvitationMessage, temporaryInvitationDigest,
  verifyTemporaryInvitation, verifyTemporaryClaim,
} from '../lib/temporary-pairing-protocol.mjs';

const run = createKeyedTaskQueue();
const MAX_RECORDS = 256;
const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const copy = (value) => structuredClone(value);
function validateDelivery(d) {
  if (!d || typeof d.brokerUrl !== 'string' || !/^[a-f0-9]{64}$/.test(d.bindingStamp)
    || !['PENDING', 'REGISTERED'].includes(d.registration)
    || typeof d.completionConfirmed !== 'boolean' || typeof d.revocationConfirmed !== 'boolean'
    || !['attempts', 'lastAttemptAt', 'nextAttemptAt'].every((k) => Number.isSafeInteger(d[k]) && d[k] >= 0)
    || !/^[a-z0-9_]{0,80}$/.test(d.lastErrorCode)) throw temporaryPairingError('temporary_pairing_store_invalid', 503);
  const url = new URL(d.brokerUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw temporaryPairingError('temporary_pairing_store_invalid', 503);
  }
}

export class TemporaryPairingRegistry {
  constructor({ filePath, identity, clock = Date.now }) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('Explicit private registry path required');
    this.filePath = resolve(filePath);
    this.identity = copy(identity);
    this.publicIdentity = publicInstanceIdentity(identity);
    this.clock = clock;
  }

  async transact(action) {
    // All objects in this process coordinate by the resolved path, including cold reopen tests.
    const lockKey = process.platform === 'win32' ? this.filePath.toLowerCase() : this.filePath;
    return run(lockKey, async () => {
      let state;
      try { state = JSON.parse(await readFile(this.filePath, 'utf8')); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw temporaryPairingError('temporary_pairing_store_invalid', 503);
        state = { version: 1, instanceId: this.publicIdentity.instanceId, lastObservedAt: 0, records: [] };
      }
      this.validateState(state);
      const observed = this.clock();
      if (!Number.isSafeInteger(observed) || observed < 0) throw temporaryPairingError('temporary_pairing_invalid_time');
      const now = Math.max(observed, state.lastObservedAt);
      state.lastObservedAt = now;
      for (const record of state.records) {
        const deadline = record.grant ? record.envelope.invitation.accessExpiresAt : record.envelope.invitation.claimExpiresAt;
        if ((record.status === 'PENDING' || record.status === 'CLAIMED') && now >= deadline) record.status = 'EXPIRED';
        if (record.accessProofs) record.accessProofs = record.accessProofs.filter((p) => p.expiresAt > now);
      }
      // Expiry must survive a denied call. Throwing inside a storage transaction must not roll it back.
      let result; let failure;
      try { result = action(state, now); } catch (error) { failure = error; }
      this.validateState(state);
      await writeJsonAtomic(this.filePath, state, { mode: 0o600, durable: true });
      if (failure) throw failure;
      return copy(result);
    });
  }

  validateState(state) {
    const fail = () => { throw temporaryPairingError('temporary_pairing_store_invalid', 503); };
    if (state?.version !== 1 || state.instanceId !== this.publicIdentity.instanceId
      || !Number.isSafeInteger(state.lastObservedAt) || state.lastObservedAt < 0
      || (state.brokerRetryAt !== undefined && (!Number.isSafeInteger(state.brokerRetryAt) || state.brokerRetryAt < 0))
      || !Array.isArray(state.records) || state.records.length > MAX_RECORDS) fail();
    const invitations = new Set(); const grants = new Set(); const devices = new Set();
    let proofCount = 0;
    try {
      for (const record of state.records) {
        const i = verifyTemporaryInvitation(record.envelope, this.publicIdentity);
        if (invitations.has(i.invitationId) || !['PENDING', 'CLAIMED', 'REVOKED', 'EXPIRED'].includes(record.status)) fail();
        invitations.add(i.invitationId);
        if (record.delivery !== undefined) validateDelivery(record.delivery);
        if (record.accessProofs !== undefined) {
          if (!Array.isArray(record.accessProofs) || record.accessProofs.length > 512
            || record.accessProofs.some((p) => !p || !/^[A-Za-z0-9_-]{43}$/.test(p.proofHash)
              || !Number.isSafeInteger(p.expiresAt) || p.expiresAt < 0)) fail();
          proofCount += record.accessProofs.length;
          if (proofCount > 4096) fail();
        }
        if (record.status === 'CLAIMED' && !record.grant) fail();
        if (!record.grant) { if (record.connection !== undefined) fail(); continue; }
        const g = record.grant;
        checkedTemporaryId(g.grantId, 'rtg'); checkedTemporaryId(g.deviceId, 'rdev'); checkedTemporaryId(g.requestId, 'rtr');
        if (record.status === 'PENDING' || grants.has(g.grantId) || devices.has(g.deviceId)
          || temporaryPublicKey(g.devicePublicKey).fingerprint !== g.deviceKeyFingerprint
          || !Number.isSafeInteger(g.grantedAt) || g.grantedAt < i.createdAt || g.grantedAt >= i.claimExpiresAt
          || g.grantedAt > state.lastObservedAt) fail();
        grants.add(g.grantId); devices.add(g.deviceId);
        if (record.connection !== undefined) {
          const c = record.connection;
          if (!c || Object.keys(c).some((k) => !['p2p', 'bootstrap'].includes(k))
            || !c.p2p || Object.keys(c.p2p).sort().join(',') !== 'roomId,secret'
            || !/^[a-f0-9]{64}$/.test(c.p2p.secret) || c.p2p.roomId !== createP2PRoomId(c.p2p.secret)) fail();
          if (c.bootstrap) {
            const issued = Date.parse(c.bootstrap.issuedAt);
            if (issued > state.lastObservedAt) fail();
            verifyTemporaryConnectionContract(c.bootstrap, { envelope: record.envelope, grant: g,
              credential: issueTemporaryAccessCredential({ identity: this.identity, envelope: record.envelope, grant: g }),
              expectedInstance: this.publicIdentity, now: issued });
            verifyTemporaryP2PAccess(c.bootstrap, { ...c.p2p,
              signalingEndpoint: c.bootstrap.candidates.find((v) => v.kind === 'webrtc').endpoint });
          }
        }
      }
    } catch { fail(); }
  }

  /** Production callers use the owner-only host adapter. */
  async create({ capabilities = TEMPORARY_PAIRING_CAPABILITIES,
    claimTtlMs = TEMPORARY_CLAIM_MAX_MS, accessTtlMs = TEMPORARY_ACCESS_MAX_MS, delivery } = {}) {
    return this.transact((state, now) => {
      // Forget only terminal records after their absolute access deadline. Old tickets then fail lookup.
      state.records = state.records.filter((r) => !(['REVOKED', 'EXPIRED'].includes(r.status)
        && r.envelope.invitation.accessExpiresAt <= now));
      if (state.records.length >= MAX_RECORDS) throw temporaryPairingError('temporary_pairing_capacity', 429);
      const token = id('rtt');
      const invitation = normalizeTemporaryInvitation({
        version: 1, invitationId: id('rti'), instanceId: this.publicIdentity.instanceId,
        instanceKeyFingerprint: this.publicIdentity.keyFingerprint, secretHash: temporaryHash(token),
        createdAt: now, claimExpiresAt: now + claimTtlMs, accessExpiresAt: now + accessTtlMs,
        capabilities, sessionScope: 'created-sessions',
      });
      const envelope = { invitation, publicKey: this.publicIdentity.publicKey,
        signature: signWithInstanceIdentity(this.identity, buildTemporaryInvitationMessage(invitation)) };
      const outgoing = delivery ? { brokerUrl: delivery.brokerUrl, bindingStamp: delivery.bindingStamp,
        registration: 'PENDING', completionConfirmed: false, revocationConfirmed: false,
        attempts: 0, lastAttemptAt: 0, nextAttemptAt: 0, lastErrorCode: '' } : undefined;
      if (outgoing) validateDelivery(outgoing);
      state.records.push({ envelope, status: 'PENDING', grant: null, ...(outgoing ? { delivery: outgoing } : {}) });
      // The one-time secret is returned once and never written to the registry.
      return { envelope, token };
    });
  }

  async claim(claim) {
    checkedTemporaryId(claim?.token, 'rtt');
    const device = verifyTemporaryClaim(claim);
    return this.transact((state, now) => {
      const record = state.records.find((r) => r.envelope.invitation.invitationId === claim.invitationId);
      const invitation = record?.envelope.invitation;
      if (!invitation || invitation.instanceId !== claim.instanceId
        || temporaryInvitationDigest(invitation) !== claim.invitationDigest
        || !timingSafeEqual(Buffer.from(invitation.secretHash, 'hex'), Buffer.from(temporaryHash(claim.token), 'hex'))) {
        throw temporaryPairingError('temporary_pairing_ticket_invalid', 401);
      }
      if (record.status === 'REVOKED' || record.status === 'EXPIRED') {
        throw temporaryPairingError('temporary_pairing_inactive', 410);
      }
      if (record.grant) {
        if (record.grant.deviceKeyFingerprint !== device.fingerprint || record.grant.requestId !== claim.requestId) {
          throw temporaryPairingError('temporary_pairing_already_claimed', 409);
        }
        return this.project(record); // Response-loss recovery never renews the deadline or creates a second grant.
      }
      record.grant = { grantId: id('rtg'), deviceId: id('rdev'), requestId: claim.requestId,
        devicePublicKey: device.publicKey, deviceKeyFingerprint: device.fingerprint, grantedAt: now };
      record.status = 'CLAIMED';
      return this.project(record);
    });
  }

  /** Validity evidence only; adapters must additionally enforce session ownership and each route's capability. */
  async activeGrant(grantId, deviceKeyFingerprint) {
    checkedTemporaryId(grantId, 'rtg');
    return this.transact((state) => {
      const record = state.records.find((r) => r.grant?.grantId === grantId);
      if (!record || record.status !== 'CLAIMED' || record.grant.deviceKeyFingerprint !== deviceKeyFingerprint) {
        throw temporaryPairingError('temporary_pairing_inactive', 410);
      }
      return this.project(record);
    });
  }

  async revoke(invitationId) {
    checkedTemporaryId(invitationId, 'rti');
    return this.transact((state) => {
      const record = state.records.find((r) => r.envelope.invitation.invitationId === invitationId);
      if (!record) throw temporaryPairingError('temporary_pairing_not_found', 404);
      if (record.status === 'PENDING' || record.status === 'CLAIMED') record.status = 'REVOKED';
      return this.project(record);
    });
  }

  async list() { return this.transact((state) => state.records.map((r) => this.project(r))); }

  /** Private connection material is never included in list/owner projections. */
  async connectionState(invitationId, bindingStamp, bootstrap) {
    checkedTemporaryId(invitationId, 'rti');
    return this.transact((state, now) => {
      const r = state.records.find((entry) => entry.envelope.invitation.invitationId === invitationId);
      if (!r || r.status !== 'CLAIMED' || r.delivery?.bindingStamp !== bindingStamp || !r.delivery.completionConfirmed
        || now >= Math.floor(r.envelope.invitation.accessExpiresAt / 1000) * 1000) {
        throw temporaryPairingError('temporary_connection_inactive', 410);
      }
      if (!r.connection) {
        const secret = randomBytes(32).toString('hex');
        r.connection = { p2p: { secret, roomId: createP2PRoomId(secret) } };
      }
      if (bootstrap !== undefined) {
        const credential = issueTemporaryAccessCredential({ identity: this.identity, envelope: r.envelope, grant: r.grant });
        verifyTemporaryConnectionContract(bootstrap, { envelope: r.envelope, grant: r.grant, credential,
          expectedInstance: this.publicIdentity, now });
        verifyTemporaryP2PAccess(bootstrap, { ...r.connection.p2p,
          signalingEndpoint: bootstrap.candidates.find((v) => v.kind === 'webrtc').endpoint });
        r.connection.bootstrap = copy(bootstrap);
      }
      return { record: r, now };
    });
  }

  /** Device proof consumption and current grant check share one durable transaction. */
  async consumeAccessProof({ grantId, bindingStamp, verifyProof }) {
    checkedTemporaryId(grantId, 'rtg');
    return this.transact((state, now) => {
      const r = state.records.find((entry) => entry.grant?.grantId === grantId);
      if (r?.delivery && r.delivery.bindingStamp !== bindingStamp && ['PENDING', 'CLAIMED'].includes(r.status)) r.status = 'REVOKED';
      if (!r || r.status !== 'CLAIMED' || !r.delivery || r.delivery.bindingStamp !== bindingStamp) {
        throw temporaryPairingError('temporary_pairing_inactive', 410);
      }
      const proof = verifyProof(copy(r), now);
      if (!proof || !/^[A-Za-z0-9_-]{43}$/.test(proof.proofHash) || !Number.isSafeInteger(proof.expiresAt)
        || proof.expiresAt <= now || proof.expiresAt > now + 60_000) throw temporaryPairingError('temporary_access_proof_invalid', 401);
      if (state.records.some((entry) => entry.accessProofs?.some((p) => p.proofHash === proof.proofHash))) {
        throw temporaryPairingError('temporary_access_proof_replayed', 401);
      }
      r.accessProofs ||= [];
      if (r.accessProofs.length >= 512 || state.records.reduce((sum, entry) => sum + (entry.accessProofs?.length || 0), 0) >= 4096) {
        throw temporaryPairingError('temporary_access_proof_capacity', 429);
      }
      r.accessProofs.push({ proofHash: proof.proofHash, expiresAt: proof.expiresAt });
      return this.project(r);
    });
  }

  /** Internal outbox snapshot; never returns the invitation secret or instance private key. */
  async deliverySnapshot(bindingStamp) {
    return this.transact((state) => {
      for (const r of state.records) {
        if (r.delivery && r.delivery.bindingStamp !== bindingStamp && ['PENDING', 'CLAIMED'].includes(r.status)) r.status = 'REVOKED';
      }
      return { now: state.lastObservedAt, brokerRetryAt: state.brokerRetryAt || 0,
        records: state.records.filter((r) => r.delivery).map((r) => ({ ...r,
          grant: r.grant ? { ...r.grant } : null })) };
    });
  }

  /** Transport observations never change the authorization status; a late ack cannot undo revoke. */
  async recordDelivery(invitationId, update) {
    return this.transact((state, now) => {
      const r = state.records.find((entry) => entry.envelope.invitation.invitationId === invitationId);
      if (!r?.delivery) throw temporaryPairingError('temporary_pairing_not_found', 404);
      const d = r.delivery;
      if (update.registered) d.registration = 'REGISTERED';
      if (update.completedGrantId && r.status === 'CLAIMED' && r.grant?.grantId === update.completedGrantId) d.completionConfirmed = true;
      if (update.revoked && ['REVOKED', 'EXPIRED'].includes(r.status)) d.revocationConfirmed = true;
      d.lastAttemptAt = now;
      d.nextAttemptAt = update.nextAttemptAt ?? now;
      d.attempts = update.errorCode ? Math.min(d.attempts + 1, 32) : 0;
      d.lastErrorCode = update.errorCode || '';
      if (update.brokerRetryAt !== undefined) state.brokerRetryAt = Math.max(state.brokerRetryAt || 0, update.brokerRetryAt);
      validateDelivery(d);
      return this.project(r);
    });
  }

  project(record) {
    const i = record.envelope.invitation;
    return {
      invitationId: i.invitationId, instanceId: i.instanceId, status: record.status,
      claimExpiresAt: i.claimExpiresAt, accessExpiresAt: i.accessExpiresAt,
      capabilities: [...i.capabilities], sessionScope: i.sessionScope,
      grant: record.grant ? { grantId: record.grant.grantId, deviceId: record.grant.deviceId,
        deviceKeyFingerprint: record.grant.deviceKeyFingerprint, grantedAt: record.grant.grantedAt } : null,
      ...(record.delivery ? { delivery: { registration: record.delivery.registration,
        completionConfirmed: record.delivery.completionConfirmed, revocationConfirmed: record.delivery.revocationConfirmed,
        lastErrorCode: record.delivery.lastErrorCode, nextAttemptAt: record.delivery.nextAttemptAt } } : {}),
    };
  }
}
