// Candidate Run-only protocol. The transport MUST authenticate OS peers before
// calling accept; this module cannot turn caller-declared facts into authority.
import { randomBytes, timingSafeEqual } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const fields = ['leaseId', 'runId', 'requestId', 'grantId', 'authorityHash'];
const maxBytes = 96 * 1024;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const text = (value, max) => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);

export function createRestrictedRunIpcGrant({ instanceId, lease, clock = Date.now }) {
  return protocol({ instanceId, lease, clock, capability: randomBytes(32).toString('base64url') });
}

// Only an authenticated private parent may provision this policy. It is not
// accepted from a Run payload or HTTP request and does not mint product authority.
export function createRestrictedRunIpcReceiver(policy, { clock = Date.now } = {}) {
  if (!policy || Object.keys(policy).some(key => !['version', 'instanceId', ...fields, 'expiresAtUnixMs', 'capability', 'text'].includes(key))
      || policy.version !== 1) fail('RESTRICTED_IPC_BINDING_INVALID');
  const lease = { version: 1, ...Object.fromEntries([...fields, 'expiresAtUnixMs'].map(key => [key, policy[key]])) };
  const state = protocol({ instanceId: policy.instanceId, lease, clock, capability: policy.capability });
  state.frame(policy.text); // Freeze original text before any remote frame arrives.
  return Object.freeze({ binding: state.binding, accept: state.accept });
}

function protocol({ instanceId, lease, clock, capability }) {
  if (!text(instanceId, 128) || lease?.version !== 1
      || !/^[a-f0-9-]{36}$/.test(lease.leaseId || '')
      || !/^run_[A-Za-z0-9_-]{8,128}$/.test(lease.runId || '')
      || !text(lease.requestId, 200) || !/^rtg_[A-Za-z0-9_-]{8,128}$/.test(lease.grantId || '')
      || !/^[a-f0-9]{64}$/.test(lease.authorityHash || '')
      || !Number.isSafeInteger(lease.expiresAtUnixMs)
      || lease.expiresAtUnixMs <= clock() || lease.expiresAtUnixMs > clock() + 120000)
    fail('RESTRICTED_IPC_BINDING_INVALID');
  const binding = Object.freeze(Object.fromEntries(fields.map(key => [key, lease[key]])));
  const expiresAtUnixMs = lease.expiresAtUnixMs;
  if (typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(capability)) fail('RESTRICTED_IPC_CAPABILITY_INVALID');
  let used = false, preparedText;
  function validate(frame) {
    if (clock() >= expiresAtUnixMs) fail('RESTRICTED_IPC_EXPIRED');
    if (!frame || bytes(frame) > maxBytes || frame.version !== 1
        || frame.operation !== 'run.execute' || frame.instanceId !== instanceId
        || fields.some(key => frame[key] !== binding[key])) fail('RESTRICTED_IPC_SCOPE_INVALID');
    const actual = Buffer.from(typeof frame.capability === 'string' ? frame.capability : '');
    const expected = Buffer.from(capability);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('RESTRICTED_IPC_CAPABILITY_INVALID');
    if (Object.keys(frame).some(key => !['version', 'operation', 'instanceId', ...fields, 'capability', 'payload'].includes(key)))
      fail('RESTRICTED_IPC_SCOPE_INVALID');
    // Only text is supported by this candidate; never an executable, cwd, env,
    // credential path, Owner operation or another Run chosen by the peer.
    if (!frame.payload || Object.keys(frame.payload).join(',') !== 'text'
        || typeof frame.payload.text !== 'string' || !frame.payload.text.trim()
        || Buffer.byteLength(frame.payload.text) > 65536
        || (preparedText !== undefined && frame.payload.text !== preparedText)) fail('RESTRICTED_IPC_PAYLOAD_INVALID');
  }
  return Object.freeze({
    binding: Object.freeze({ version: 1, instanceId, ...binding, expiresAtUnixMs }),
    receiverPolicy() {
      if (preparedText === undefined) fail('RESTRICTED_IPC_PAYLOAD_INVALID');
      return Object.freeze({ version: 1, instanceId, ...binding, expiresAtUnixMs, capability, text: preparedText });
    },
    frame(text) {
      const frame = { version: 1, operation: 'run.execute', instanceId, ...binding, capability, payload: { text } };
      validate(frame);
      // The trusted sender freezes the original message before transport. A
      // peer holding this capability still cannot substitute another prompt.
      preparedText = text; return frame;
    },
    async accept(frame, execute) {
      if (preparedText === undefined) fail('RESTRICTED_IPC_PAYLOAD_INVALID');
      validate(frame);
      if (used) fail('RESTRICTED_IPC_ALREADY_USED');
      // Consume before any asynchronous work, including a failing worker. A
      // transport loss cannot authorize a second model attempt on this grant.
      used = true;
      const outcome = await execute(Object.freeze({ ...binding }), frame.payload.text);
      if (clock() >= expiresAtUnixMs) fail('RESTRICTED_IPC_EXPIRED');
      if (!outcome || fields.some(key => outcome[key] !== binding[key])
          || outcome.stopped !== true || typeof outcome.completed !== 'boolean'
          || bytes(outcome) > maxBytes
          || Object.keys(outcome).some(key => ![...fields, 'stopped', 'completed', 'text'].includes(key))
          || (Object.hasOwn(outcome, 'text') && (typeof outcome.text !== 'string' || Buffer.byteLength(outcome.text) > 65536))
          || (outcome.completed && (typeof outcome.text !== 'string' || !outcome.text.trim()))) fail('RESTRICTED_IPC_OUTCOME_INVALID');
      return structuredClone(outcome);
    },
  });
}
