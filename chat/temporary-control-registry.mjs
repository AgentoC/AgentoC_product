// Durable state for a confirmed, ten-minute temporary workbench-control grant.
// This registry deliberately does not share the v1 temporary-sharing file:
// a parser or migration mistake cannot turn an old share record into control.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKeyedTaskQueue, writeJsonAtomic } from './fs-utils.mjs';
import { publicInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { TEMPORARY_CONTROL_ACCESS_MS, buildTemporaryControlInvitationMessage,
  normalizeTemporaryControlInvitation, temporaryControlInvitationDigest,
  verifyTemporaryControlClaim, verifyTemporaryControlInvitation } from '../lib/temporary-control-protocol.mjs';
import { TEMPORARY_CONTROL_CAPABILITIES, TEMPORARY_CONTROL_SESSION_SCOPE } from '../lib/temporary-control-policy.mjs';
import { temporaryHash } from '../lib/temporary-pairing-protocol.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import { temporarySignalingEndpoint } from '../lib/temporary-connection-contract.mjs';

const queue = createKeyedTaskQueue();
const MAX_RECORDS = 64;
const states = new Set(['PENDING', 'CLAIMED', 'ACTIVE', 'REVOKED', 'EXPIRED']);
const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const copy = (value) => structuredClone(value);
const fail = (code = 'temporary_control_store_invalid', statusCode = 503) => {
  throw Object.assign(new Error(code), { code, statusCode });
};
const lockKey = (path) => process.platform === 'win32' ? path.toLowerCase() : path;

export class TemporaryControlRegistry {
  constructor({ filePath, identity, clock = Date.now }) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('Explicit control registry path required');
    this.filePath = resolve(filePath);
    this.identity = copy(identity);
    this.publicIdentity = publicInstanceIdentity(identity);
    this.clock = clock;
  }

  async transact(action) {
    return queue(lockKey(this.filePath), async () => {
      let state;
      try { state = JSON.parse(await readFile(this.filePath, 'utf8')); }
      catch (error) {
        if (error?.code !== 'ENOENT') fail();
        state = { version: 1, instanceId: this.publicIdentity.instanceId, lastObservedAt: 0, records: [] };
      }
      this.validate(state);
      const observed = this.clock();
      if (!Number.isSafeInteger(observed) || observed < 0) fail('temporary_control_invalid_time', 400);
      const now = Math.max(observed, state.lastObservedAt);
      state.lastObservedAt = now;
      for (const record of state.records) {
        const invitation = record.envelope.invitation;
        if (record.status === 'PENDING' && now >= invitation.claimExpiresAt) record.status = 'EXPIRED';
        if (record.status === 'CLAIMED' && now >= invitation.claimExpiresAt) record.status = 'EXPIRED';
        if (record.status === 'ACTIVE' && now >= record.accessExpiresAt) record.status = 'EXPIRED';
        if (record.status === 'EXPIRED' || record.status === 'REVOKED') record.connection = null;
      }
      let result; let error;
      try { result = action(state, now); } catch (caught) { error = caught; }
      this.validate(state);
      await writeJsonAtomic(this.filePath, state, { mode: 0o600, durable: true });
      if (error) throw error;
      return copy(result);
    });
  }

  validate(state) {
    try {
      if (state?.version !== 1 || state.instanceId !== this.publicIdentity.instanceId
        || !Number.isSafeInteger(state.lastObservedAt) || state.lastObservedAt < 0
        || !Array.isArray(state.records) || state.records.length > MAX_RECORDS) throw new Error();
      const invitations = new Set(); const grants = new Set(); const devices = new Set();
      for (const record of state.records) {
        if (!record || Object.keys(record).some((key) => !['envelope', 'status', 'claim', 'grant', 'accessExpiresAt', 'accessProofs', 'connection'].includes(key))
          || !states.has(record.status)) throw new Error();
        if (!Array.isArray(record.accessProofs) || record.accessProofs.length > 512
          || record.accessProofs.some((proof) => !proof || Object.keys(proof).sort().join(',') !== 'expiresAt,proofHash'
            || !/^[A-Za-z0-9_-]{43}$/.test(proof.proofHash)
            || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt < 0)) throw new Error();
        const invitation = verifyTemporaryControlInvitation(record.envelope, this.publicIdentity);
        if (invitations.has(invitation.invitationId)) throw new Error();
        invitations.add(invitation.invitationId);
        const terminal = record.status === 'REVOKED' || record.status === 'EXPIRED';
        if (record.claim === null) {
          if (record.grant !== null || record.accessExpiresAt !== null
            || (!terminal && record.status !== 'PENDING')) throw new Error();
          continue;
        }
        const claim = record.claim;
        if (!claim || Object.keys(claim).sort().join(',') !== 'deviceKeyFingerprint,devicePublicKey,instanceId,invitationDigest,invitationId,requestId,signature,token'
          || temporaryControlInvitationDigest(invitation) !== claim.invitationDigest
          || temporaryHash(claim.token) !== invitation.secretHash
          || verifyTemporaryControlClaim(claim).fingerprint !== claim.deviceKeyFingerprint) throw new Error();
        if (record.grant === null) {
          if (record.accessExpiresAt !== null || (!terminal && record.status !== 'CLAIMED')) throw new Error();
          continue;
        }
        const grant = record.grant;
        if (!grant || Object.keys(grant).sort().join(',') !== 'deviceId,grantId,grantedAt'
          || !/^rtg_[A-Za-z0-9_-]{24,64}$/.test(grant.grantId) || !/^rdev_[A-Za-z0-9_-]{24,64}$/.test(grant.deviceId)
          || grants.has(grant.grantId) || devices.has(grant.deviceId)
          || !Number.isSafeInteger(grant.grantedAt) || grant.grantedAt < invitation.createdAt
          || grant.grantedAt >= invitation.claimExpiresAt
          || !Number.isSafeInteger(record.accessExpiresAt)
          || record.accessExpiresAt !== grant.grantedAt + TEMPORARY_CONTROL_ACCESS_MS
          || (!terminal && record.status !== 'ACTIVE')) throw new Error();
        grants.add(grant.grantId); devices.add(grant.deviceId);
        if (record.connection != null) this.validateConnection(record.connection, record);
      }
    } catch { fail(); }
  }

  validateConnection(connection, record) {
    const keys = ['version', 'instanceId', 'invitationId', 'grantId', 'deviceId', 'connectionId', 'connectionRequestId',
      'issuedAt', 'expiresAt', 'signalingEndpoint', 'roomId', 'secret', 'iceServers'];
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)
      || Object.keys(connection).sort().join(',') !== keys.sort().join(',') || connection.version !== 1
      || connection.instanceId !== record.envelope.invitation.instanceId
      || connection.invitationId !== record.envelope.invitation.invitationId
      || connection.grantId !== record.grant?.grantId || connection.deviceId !== record.grant?.deviceId
      || !/^[A-Za-z0-9_-]{10,160}$/.test(connection.connectionId || '')
      || !/^rtr_[A-Za-z0-9_-]{24,64}$/.test(connection.connectionRequestId || '')
      || !Number.isSafeInteger(connection.issuedAt) || !Number.isSafeInteger(connection.expiresAt)
      || connection.issuedAt < record.grant.grantedAt || connection.expiresAt <= connection.issuedAt
      || connection.expiresAt > Math.floor(record.accessExpiresAt / 1000) * 1000
      || !/^[a-f0-9]{64}$/.test(connection.secret || '') || connection.roomId !== createP2PRoomId(connection.secret)
      || temporarySignalingEndpoint(connection.signalingEndpoint) !== connection.signalingEndpoint
      || !Array.isArray(connection.iceServers) || connection.iceServers.length < 1 || connection.iceServers.length > 8
      || connection.iceServers.some((server) => !server || Object.keys(server).sort().join(',') !== 'password,urls,username'
        || !/^turns?:[A-Za-z0-9.:[\]-]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/.test(server.urls || '')
        || typeof server.username !== 'string' || !server.username || server.username.length > 1024
        || typeof server.password !== 'string' || !server.password || server.password.length > 2048)) fail();
  }

  /** A response-loss retry must reuse the original room and TURN credentials. */
  async connectionState(grantId, candidate) {
    return this.transact((state, now) => {
      const record = state.records.find((entry) => entry.grant?.grantId === grantId);
      if (!record || record.status !== 'ACTIVE') fail('temporary_control_inactive', 410);
      if (candidate !== undefined) {
        this.validateConnection(candidate, record);
        if (record.connection && JSON.stringify(record.connection) !== JSON.stringify(candidate)) fail('temporary_control_connection_conflict', 409);
        if (!record.connection) record.connection = copy(candidate);
      }
      if (record.connection && now >= record.connection.expiresAt) fail('temporary_control_connection_expired', 410);
      return record.connection || null;
    });
  }

  async create() {
    return this.transact((state, now) => {
      state.records = state.records.filter((record) => !['REVOKED', 'EXPIRED'].includes(record.status));
      if (state.records.length >= MAX_RECORDS) fail('temporary_control_capacity', 429);
      const token = id('rtt');
      const invitation = normalizeTemporaryControlInvitation({ version: 1, invitationId: id('rti'),
        instanceId: this.publicIdentity.instanceId, instanceKeyFingerprint: this.publicIdentity.keyFingerprint,
        secretHash: temporaryHash(token), createdAt: now, claimExpiresAt: now + 120_000,
        accessDurationMs: TEMPORARY_CONTROL_ACCESS_MS,
        capabilities: TEMPORARY_CONTROL_CAPABILITIES, sessionScope: TEMPORARY_CONTROL_SESSION_SCOPE });
      const envelope = { invitation, publicKey: this.publicIdentity.publicKey,
        signature: signWithInstanceIdentity(this.identity, buildTemporaryControlInvitationMessage(invitation)) };
      state.records.push({ envelope, status: 'PENDING', claim: null, grant: null, accessExpiresAt: null, accessProofs: [] });
      return { envelope, token };
    });
  }

  async claim(input) {
    const device = verifyTemporaryControlClaim(input);
    if (typeof input?.token !== 'string' || !/^rtt_[A-Za-z0-9_-]{24,64}$/.test(input.token)) fail('temporary_control_invalid_id', 400);
    return this.transact((state) => {
      const record = state.records.find((item) => item.envelope.invitation.invitationId === input.invitationId);
      const invitation = record?.envelope.invitation;
      if (!record || input.instanceId !== invitation.instanceId
        || temporaryControlInvitationDigest(invitation) !== input.invitationDigest
        || !timingSafeEqual(Buffer.from(invitation.secretHash, 'hex'), Buffer.from(temporaryHash(input.token), 'hex'))) {
        fail('temporary_control_ticket_invalid', 401);
      }
      if (record.status === 'REVOKED' || record.status === 'EXPIRED') fail('temporary_control_inactive', 410);
      if (record.claim !== null) {
        if (record.claim.deviceKeyFingerprint !== device.fingerprint || record.claim.requestId !== input.requestId) {
          fail('temporary_control_already_claimed', 409);
        }
        return this.project(record);
      }
      record.claim = { instanceId: input.instanceId, invitationId: input.invitationId,
        invitationDigest: input.invitationDigest, requestId: input.requestId, devicePublicKey: device.publicKey,
        deviceKeyFingerprint: device.fingerprint, token: input.token, signature: input.signature };
      record.status = 'CLAIMED';
      return this.project(record);
    });
  }

  async confirm(invitationId) {
    if (typeof invitationId !== 'string' || !/^rti_[A-Za-z0-9_-]{24,64}$/.test(invitationId)) fail('temporary_control_invalid_id', 400);
    return this.transact((state, now) => {
      const record = state.records.find((item) => item.envelope.invitation.invitationId === invitationId);
      if (!record) fail('temporary_control_not_found', 404);
      if (record.status !== 'CLAIMED' || !record.claim) fail('temporary_control_not_claimed', 409);
      record.grant = { grantId: id('rtg'), deviceId: id('rdev'), grantedAt: now };
      record.accessExpiresAt = now + TEMPORARY_CONTROL_ACCESS_MS;
      record.status = 'ACTIVE';
      return this.project(record);
    });
  }

  async revoke(invitationId) {
    if (typeof invitationId !== 'string' || !/^rti_[A-Za-z0-9_-]{24,64}$/.test(invitationId)) fail('temporary_control_invalid_id', 400);
    return this.transact((state) => {
      const record = state.records.find((item) => item.envelope.invitation.invitationId === invitationId);
      if (!record) fail('temporary_control_not_found', 404);
      if (!['REVOKED', 'EXPIRED'].includes(record.status)) record.status = 'REVOKED';
      record.connection = null;
      return this.project(record);
    });
  }

  async activeGrant(grantId, deviceKeyFingerprint) {
    if (typeof grantId !== 'string' || !/^rtg_[A-Za-z0-9_-]{24,64}$/.test(grantId)) fail('temporary_control_invalid_id', 400);
    return this.transact((state) => {
      const record = state.records.find((item) => item.grant?.grantId === grantId);
      if (!record || record.status !== 'ACTIVE' || record.claim?.deviceKeyFingerprint !== deviceKeyFingerprint) {
        fail('temporary_control_inactive', 410);
      }
      return this.project(record);
    });
  }

  /** Internal host material. It is never serialized to a device or HTTP caller. */
  async accessMaterial(grantId) {
    if (typeof grantId !== 'string' || !/^rtg_[A-Za-z0-9_-]{24,64}$/.test(grantId)) fail('temporary_control_invalid_id', 400);
    return this.transact((state) => {
      const record = state.records.find((item) => item.grant?.grantId === grantId);
      if (!record || record.status !== 'ACTIVE' || !record.claim || !record.grant) fail('temporary_control_inactive', 410);
      return { envelope: copy(record.envelope), claim: copy(record.claim), grant: copy(record.grant),
        accessExpiresAt: record.accessExpiresAt };
    });
  }

  /** Persist a one-use DPoP proof; a replay remains rejected across restarts. */
  async consumeAccessProof({ grantId, verifyProof }) {
    if (typeof verifyProof !== 'function') throw new TypeError('verifyProof is required');
    if (typeof grantId !== 'string' || !/^rtg_[A-Za-z0-9_-]{24,64}$/.test(grantId)) fail('temporary_control_invalid_id', 400);
    return this.transact((state, now) => {
      const record = state.records.find((item) => item.grant?.grantId === grantId);
      if (!record || record.status !== 'ACTIVE' || !record.claim || !record.grant) fail('temporary_control_inactive', 410);
      record.accessProofs = record.accessProofs.filter((proof) => proof.expiresAt > now);
      const proof = verifyProof(copy(record), now);
      if (!proof || !/^[A-Za-z0-9_-]{43}$/.test(proof.proofHash)
        || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= now || proof.expiresAt > now + 60_000) {
        fail('temporary_control_proof_invalid', 401);
      }
      if (state.records.some((item) => item.accessProofs.some((entry) => entry.proofHash === proof.proofHash))) {
        fail('temporary_control_proof_replayed', 409);
      }
      record.accessProofs.push({ proofHash: proof.proofHash, expiresAt: proof.expiresAt });
      return this.project(record);
    });
  }

  async list() { return this.transact((state) => state.records.map((record) => this.project(record))); }

  project(record) {
    const invitation = record.envelope.invitation;
    return { invitationId: invitation.invitationId, instanceId: invitation.instanceId, status: record.status,
      claimExpiresAt: invitation.claimExpiresAt, accessDurationMs: invitation.accessDurationMs,
      accessExpiresAt: record.accessExpiresAt, capabilities: [...invitation.capabilities],
      sessionScope: invitation.sessionScope,
      claimedDevice: record.claim ? { deviceKeyFingerprint: record.claim.deviceKeyFingerprint } : null,
      grant: record.grant ? { grantId: record.grant.grantId, deviceId: record.grant.deviceId,
        grantedAt: record.grant.grantedAt } : null };
  }
}
