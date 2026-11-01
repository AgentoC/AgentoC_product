/**
 * Server-owned Windows named-pipe executor peer channel.
 *
 * Verifies the identity of a Windows controlled executor that connects over a
 * named pipe, then gates every exec request behind the signed semantic
 * capability (operation/resource/selection/run/turn/version/TTL + one-time
 * nonce) and revalidates the approved resource facts immediately before
 * dispatch.
 *
 * This module is pure decision logic. It never executes a command and never
 * trusts caller-declared scope or a caller-supplied SID as the only basis.
 * Peer facts must come from a trusted Windows adapter (named-pipe peer
 * attributes resolved by the platform); the expected SID is server-owned
 * configuration, never a request claim. Any missing, unknown, or mismatched
 * fact fails closed.
 */

import { validateWindowsPeerIdentity } from './semantic-windows-boundary.mjs';
import { verifySemanticCapability } from './semantic-capability.mjs';

export const WINDOWS_EXECUTOR_PEER_CHANNEL_VERSION = 'windows-executor-peer/v1';

export const WINDOWS_PEER_CHANNEL_ERROR = Object.freeze({
  CAPABILITY_REQUIRED: 'WINDOWS_PEER_CAPABILITY_REQUIRED',
  CAPABILITY_TTL_EXPIRED: 'WINDOWS_CAPABILITY_TTL_EXPIRED',
  FACTS_REVALIDATION_FAILED: 'WINDOWS_FACTS_REVALIDATION_FAILED',
  NONCE_REUSED: 'WINDOWS_PEER_NONCE_REUSED',
  NONCE_STATE_REQUIRED: 'WINDOWS_PEER_NONCE_STATE_REQUIRED',
  PEER_BINDING_REQUIRED: 'WINDOWS_PEER_BINDING_REQUIRED',
  PEER_IDENTITY_MISMATCH: 'WINDOWS_PEER_IDENTITY_MISMATCH',
  PEER_IDENTITY_UNVERIFIED: 'WINDOWS_PEER_IDENTITY_UNVERIFIED',
  PEER_TRANSPORT_UNSUPPORTED: 'WINDOWS_PEER_TRANSPORT_UNSUPPORTED',
  REVALIDATION_REQUIRED: 'WINDOWS_PEER_REVALIDATION_REQUIRED',
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code, error) {
  return { ok: false, code, error };
}

/**
 * Connect-time peer identity verification. This is the single wiring point for
 * `validateWindowsPeerIdentity` on the named-pipe executor channel. Only a
 * win32, named-pipe, authenticated, same-user, high-integrity peer whose SID
 * matches the server-owned expected SID is admitted. Everything else DENY.
 */
export function validateWindowsExecutorPeerConnect(facts = {}, expected = {}) {
  const identity = validateWindowsPeerIdentity(facts, expected);
  if (!identity.ok) return identity;
  if (!trimString(identity.sid)) {
    return fail(WINDOWS_PEER_CHANNEL_ERROR.PEER_IDENTITY_MISMATCH, 'Windows peer SID is empty after identity validation');
  }
  return {
    ok: true,
    code: '',
    peer: {
      platform: 'win32',
      transport: 'named-pipe',
      sid: identity.sid,
      channelVersion: WINDOWS_EXECUTOR_PEER_CHANNEL_VERSION,
    },
  };
}

/**
 * Executor-time capability gate on an already-verified peer channel.
 *
 * Order of checks (fail-closed; any failure DENY):
 *   1. Re-verify peer identity on every request so a peer swap mid-channel
 *      cannot reuse a previously admitted connection.
 *   2. Verify the signed capability: signature, version, operation binding,
 *      adapter set, and TTL (a signed capability can never outlive its TTL).
 *   3. Enforce the one-time nonce (replay).
 *   4. Revalidate the approved resource facts immediately before dispatch
 *      (target swap, definition/descriptor change, or facts disappearance).
 *
 * `revalidate` is an async ({ capability, peer }) => { ok, code?, error? }
 * bound to the adapter's trusted fact source. Without it the gate refuses,
 * because an executor must re-check the target before it builds an argv.
 */
export async function validateWindowsExecutorPeerCapability({
  capability = {},
  facts = {},
  expected = {},
  publicKey = null,
  now = Date.now(),
  nonceState = null,
  revalidate = null,
} = {}) {
  const identity = validateWindowsPeerIdentity(facts, expected);
  if (!identity.ok) return identity;

  if (!capability || typeof capability !== 'object' || Array.isArray(capability)
    || !trimString(capability.capabilityId) || !Array.isArray(capability.operations)
    || capability.operations.length === 0) {
    return fail(WINDOWS_PEER_CHANNEL_ERROR.CAPABILITY_REQUIRED, 'Windows executor request requires a signed semantic capability');
  }

  // Signed capability verification covers signature, version, operation/resource
  // binding, selection (run/turn), adapter set, and TTL expiry. The public key is
  // server-owned; a gate without it fails closed.
  if (!publicKey) {
    return fail('SEMANTIC_CAPABILITY_SIGNATURE_INVALID', 'Windows executor requires the server-owned capability signing key');
  }
  const verified = verifySemanticCapability(capability, { publicKey, now });
  if (!verified.ok) {
    if (verified.code === 'SEMANTIC_CAPABILITY_EXPIRED') {
      return fail(WINDOWS_PEER_CHANNEL_ERROR.CAPABILITY_TTL_EXPIRED, 'Windows capability TTL has expired');
    }
    return verified;
  }

  const nonce = trimString(capability.nonce);
  if (!nonce) return fail(WINDOWS_PEER_CHANNEL_ERROR.PEER_BINDING_REQUIRED, 'Windows capability nonce is required');
  if (!nonceState || typeof nonceState.consume !== 'function') {
    return fail(WINDOWS_PEER_CHANNEL_ERROR.NONCE_STATE_REQUIRED, 'Windows executor requires an atomic one-shot nonce store');
  }
  if (typeof nonceState.isUsed === 'function' && nonceState.isUsed(nonce)) {
    return fail(WINDOWS_PEER_CHANNEL_ERROR.NONCE_REUSED, 'Windows capability nonce was already consumed');
  }

  if (typeof revalidate !== 'function') {
    return fail(WINDOWS_PEER_CHANNEL_ERROR.REVALIDATION_REQUIRED, 'Windows executor requires target revalidation before dispatch');
  }
  const revalidation = await revalidate({ capability, peer: identity.sid });
  if (!revalidation?.ok) {
    return fail(
      revalidation?.code || WINDOWS_PEER_CHANNEL_ERROR.FACTS_REVALIDATION_FAILED,
      revalidation?.error || 'Windows executor target revalidation failed',
    );
  }

  let consumed = false;
  try {
    consumed = await nonceState.consume(nonce) === true;
  } catch (error) {
    return fail(WINDOWS_PEER_CHANNEL_ERROR.NONCE_STATE_REQUIRED, `unable to consume Windows capability nonce atomically: ${error?.message || String(error)}`);
  }
  if (!consumed) return fail(WINDOWS_PEER_CHANNEL_ERROR.NONCE_REUSED, 'Windows capability nonce was already consumed');
  return { ok: true, code: '', peer: identity.sid };
}

/**
 * One-shot nonce tracker for a peer channel. Seed from the durable audit on
 * startup so a replay across a channel restart is still rejected.
 */
export function createWindowsPeerNonceTracker({ seed = [] } = {}) {
  const seen = new Set((Array.isArray(seed) ? seed : []).map(trimString).filter(Boolean));
  return {
    isUsed(nonce) {
      return seen.has(trimString(nonce));
    },
    consume(nonce) {
      const value = trimString(nonce);
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    },
    snapshot() {
      return [...seen];
    },
  };
}
