// Durable signed connection requests/deliveries. Fresh HTTP proofs are checked separately at ingress.
import { checkedTemporaryId, temporaryPairingError } from './temporary-pairing-protocol.mjs';
import { temporaryCanonicalJson, verifyTemporaryBrokerProof } from './temporary-pairing-broker-protocol.mjs';
import { verifyTemporaryConnectionContract, verifyTemporaryP2PAccess } from './temporary-connection-contract.mjs';

const fail = () => { throw temporaryPairingError('temporary_broker_connection_invalid', 401); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

export function temporaryConnectionRequestId(payload) {
  if (!exact(payload, ['connectionRequestId'])) fail();
  return checkedTemporaryId(payload.connectionRequestId, 'rtr');
}

export function verifyTemporaryConnectionRequest(request, { envelope, grant, now }) {
  const i = envelope.invitation;
  if (!exact(request, ['instanceId', 'invitationId', 'requestId', 'issuedAt', 'nonce', 'payload', 'signature'])
    || request.instanceId !== i.instanceId || request.invitationId !== i.invitationId
    || request.requestId !== grant.requestId || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < grant.grantedAt || request.issuedAt > now
    || now >= Math.floor(i.accessExpiresAt / 1000) * 1000) fail();
  const id = temporaryConnectionRequestId(request.payload);
  verifyTemporaryBrokerProof('connect', request, grant.devicePublicKey, request.issuedAt);
  return id;
}

export function verifyTemporaryConnectionDelivery(delivery, { envelope, grant, credential, expectedInstance, connectionRequestId, now }) {
  const i = envelope.invitation;
  checkedTemporaryId(connectionRequestId, 'rtr');
  if (!exact(delivery, ['instanceId', 'invitationId', 'requestId', 'issuedAt', 'nonce', 'payload', 'signature'])
    || delivery.instanceId !== i.instanceId || delivery.invitationId !== i.invitationId
    || !exact(delivery.payload, ['connectionRequestId', 'bootstrap', 'p2p', 'carrierReady', 'businessAccessReady'])
    || delivery.payload.connectionRequestId !== connectionRequestId || delivery.payload.carrierReady !== true
    || typeof delivery.payload.businessAccessReady !== 'boolean' || !Number.isSafeInteger(delivery.issuedAt)
    || delivery.issuedAt > now || delivery.issuedAt < Date.parse(delivery.payload.bootstrap?.issuedAt)
    || delivery.issuedAt >= credential.expires_at
    || Buffer.byteLength(temporaryCanonicalJson(delivery.payload)) > 12 * 1024) fail();
  verifyTemporaryBrokerProof('connection-publish', delivery, envelope.publicKey, delivery.issuedAt);
  const bootstrap = verifyTemporaryConnectionContract(delivery.payload.bootstrap, { envelope, grant, credential, expectedInstance, now });
  const p2p = verifyTemporaryP2PAccess(bootstrap, delivery.payload.p2p);
  return { connectionRequestId, bootstrap, p2p, carrierReady: true,
    businessAccessReady: delivery.payload.businessAccessReady };
}
