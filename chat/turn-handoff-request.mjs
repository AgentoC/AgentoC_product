import { verifyConnectionBootstrapContract } from '../lib/connection-bootstrap-contract.mjs';
import { createTurnConnectionId } from '../lib/turn-authorization.mjs';
import { matchesTurnLeasePair } from '../lib/turn-lease-identity.mjs';

/** Verify the exact previous plan before trusting its lease or deadline. */
export function validateTurnHandoffRequest({ contract, identity, accountId, deviceId, now = Date.now() } = {}) {
  const denied = () => { throw Object.assign(new Error('Invalid previous connection plan'), { code: 'turn_handoff_plan_invalid', statusCode: 400 }); };
  if (!identity?.instanceId || !identity.publicKey || !identity.keyFingerprint || !accountId || !deviceId
    || contract?.instanceId !== identity.instanceId || contract?.deviceId !== deviceId
    || contract?.signature?.keyId !== identity.keyFingerprint
    || !verifyConnectionBootstrapContract(contract, identity.publicKey, { nowMs: now }).valid) denied();
  const connectionId = contract.turn?.connectionId;
  const logicalId = createTurnConnectionId({ accountId, instanceId: identity.instanceId, deviceId });
  if (!matchesTurnLeasePair(connectionId, logicalId)
    || contract.turnAuthorization?.connectionId !== connectionId
    || contract.turn.authorization?.connectionId !== connectionId) denied();
  const carrier = contract.candidates.find(candidate => candidate.id === contract.initialCarrier?.candidateId);
  const bounds = [contract.expiresAt, contract.turn.expiresAt, carrier?.expiresAt].map(value => Date.parse(value || ''));
  if (bounds.some(value => !Number.isFinite(value) || value <= now)) denied();
  return { from: connectionId, signedExpiry: Math.min(...bounds) };
}
