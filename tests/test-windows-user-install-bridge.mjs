import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { runWindowsUserInstallBridge } from '../chat/windows-user-install-bridge.mjs';

const keys = generateKeyPairSync('ed25519');
const pinnedIdentity = { kid: 'fixture-key', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const capability = { kid: 'fixture-key', windowsExecutionSid: 'S-1-5-21-1-2-3-4' };
const binding = { sessionId: 'session', runId: 'run', turnId: 'turn', requestKey: 'gate:test' };
const calls = [];
const request = async (payload) => {
  calls.push(payload);
  if (payload.autoInstallUserCheck) return { kind: 'automatic_user_install_check', ok: true };
  if (payload.autoInstallUserClaim) return { kind: 'automatic_user_install_claim', claimed: true };
  if (payload.autoInstallUserFinish) return { kind: 'automatic_user_install_finish', ok: true };
  throw new Error('unexpected request');
};
const result = await runWindowsUserInstallBridge({ capability, pinnedIdentity, binding, cwd: 'D:\\project', request }, {
  execute: async (options, deps) => {
    assert.equal(options.expectedOwnerSid, capability.windowsExecutionSid);
    assert.equal(options.publicKey.export({ type: 'spki', format: 'pem' }).toString(), pinnedIdentity.publicKey);
    await deps.assertActive();
    assert.equal((await deps.claim()).claimed, true);
    await deps.finish({ status: 'succeeded', code: '' });
    return { status: 'succeeded' };
  },
});
assert.equal(result.status, 'succeeded');
assert.equal(calls.length, 3);
assert.ok(calls.every((payload) => payload.userInstallCapability === capability));
assert.deepEqual(calls[2].userInstallResult, { status: 'succeeded', code: '' });
await assert.rejects(runWindowsUserInstallBridge({ capability, pinnedIdentity: { ...pinnedIdentity, kid: 'wrong' }, binding, cwd: 'D:\\project', request }), /identity/);
await assert.rejects(runWindowsUserInstallBridge({ capability, pinnedIdentity, binding, cwd: 'D:\\project', request: async () => ({ kind: 'wrong' }) }, {
  execute: async (_options, deps) => deps.assertActive(),
}), /control response/);
console.log('windows-user-install-bridge: signed identity and control calls passed');
