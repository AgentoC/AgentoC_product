#!/usr/bin/env node
/**
 * Unit contract for the Windows named-pipe peer facts resolver. These checks
 * mock execFile; the real-Windows behavior is covered by the live probe on a
 * Windows host (same PowerShell interop discipline as live-windows-facts-test).
 */

import assert from 'node:assert/strict';

import {
  WINDOWS_POWERSHELL_EXECUTABLE,
  WINDOWS_POWERSHELL_CWD,
  buildWindowsPipePeerInvocation,
  createWindowsNamedPipePeerFactsProvider,
} from '../chat/windows-named-pipe-peer-facts.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

const GOOD_FACTS = {
  platform: 'win32',
  transport: 'named-pipe',
  authenticated: true,
  sameUser: true,
  integrity: 'high',
  sid: 'S-1-5-21-111-222-333-1001',
};

// ── invocation boundary ────────────────────────────────────────────────────────

const inv = buildWindowsPipePeerInvocation();
eq('powershell executable is absolute system path', inv.file, WINDOWS_POWERSHELL_EXECUTABLE);
check('args are fixed prefix + one encoded command', inv.args.length === 5 && inv.args[4].length > 0);
check('env is allowlisted', inv.env.LANG === 'C' && Object.keys(inv.env).every((key) => ['SystemRoot', 'WINDIR', 'PATH', 'LANG'].includes(key)));
eq('cwd is the discovered System32', inv.cwd, WINDOWS_POWERSHELL_CWD);
check('script embeds the native interop', inv.args[4].length > 1000);

// ── resolveClientPeerFacts: happy path ─────────────────────────────────────────

const providerOk = createWindowsNamedPipePeerFactsProvider({
  execFile: async () => ({ stdout: `${JSON.stringify({ ok: true, facts: GOOD_FACTS, serverSid: GOOD_FACTS.sid, clientPid: 4242 })}\n`, stderr: '' }),
});
const facts = await providerOk.resolveClientPeerFacts();
eq('happy path returns resolved facts', facts, GOOD_FACTS);

// ── fail closed on exec failure ────────────────────────────────────────────────

const providerExecFail = createWindowsNamedPipePeerFactsProvider({
  execFile: async () => { const error = new Error('EPIPE'); error.code = 'EPIPE'; throw error; },
});
await assert.rejects(
  () => providerExecFail.resolveClientPeerFacts(),
  (error) => error?.code === 'WINDOWS_PIPE_PEER_FAILED' && /EPIPE/.test(error?.message),
  'exec failure must fail closed with WINDOWS_PIPE_PEER_FAILED',
);

// ── fail closed on malformed JSON ──────────────────────────────────────────────

const providerBadJson = createWindowsNamedPipePeerFactsProvider({
  execFile: async () => ({ stdout: 'not-json\n', stderr: '' }),
});
await assert.rejects(
  () => providerBadJson.resolveClientPeerFacts(),
  (error) => error?.code === 'WINDOWS_PIPE_PEER_UNPARSEABLE',
  'malformed JSON must fail closed',
);

// ── fail closed on empty output ────────────────────────────────────────────────

const providerEmpty = createWindowsNamedPipePeerFactsProvider({
  execFile: async () => ({ stdout: '', stderr: '' }),
});
await assert.rejects(
  () => providerEmpty.resolveClientPeerFacts(),
  (error) => error?.code === 'WINDOWS_PIPE_PEER_UNPARSEABLE',
  'empty output must fail closed',
);

// ── fail closed on probe ok:false payload ──────────────────────────────────────

const providerProbeFail = createWindowsNamedPipePeerFactsProvider({
  execFile: async () => ({ stdout: `${JSON.stringify({ ok: false, code: 'WINDOWS_PIPE_PEER_RESOLUTION_FAILED', error: 'token query failed' })}\n`, stderr: '' }),
});
await assert.rejects(
  () => providerProbeFail.resolveClientPeerFacts(),
  (error) => error?.code === 'WINDOWS_PIPE_PEER_RESOLUTION_FAILED' && /token query failed/.test(error?.message),
  'ok:false probe payload must propagate its code',
);

// ── fail closed on contract shape violation ────────────────────────────────────

const providerBadShape = createWindowsNamedPipePeerFactsProvider({
  execFile: async () => ({ stdout: `${JSON.stringify({ ok: true, facts: { ...GOOD_FACTS, sid: 'not-a-sid' } })}\n`, stderr: '' }),
});
await assert.rejects(
  () => providerBadShape.resolveClientPeerFacts(),
  (error) => error?.code === 'WINDOWS_PIPE_PEER_INVALID',
  'contract shape violation must fail closed',
);

// ── connection-bound server variant ──────────────────────────────────────────
// The executor dispatch path calls resolveClientPeerFactsForConnection(connection)
// so the gate sees facts resolved from the actual accepted connection. The
// resolver must fail closed both off win32 and on win32 without a bound
// accepted-connection resolver, but with platform-specific reason codes.

const providerConnection = createWindowsNamedPipePeerFactsProvider({
  execFile: async () => ({ stdout: `${JSON.stringify({ ok: true, facts: GOOD_FACTS })}\n`, stderr: '' }),
});
if (process.platform !== 'win32') {
  await assert.rejects(
    () => providerConnection.resolveClientPeerFactsForConnection({}),
    (error) => error?.code === 'WINDOWS_PEER_TRANSPORT_UNSUPPORTED'
      && /win32 transport/.test(error?.message),
    'connection-bound resolver must fail closed off win32',
  );
  await assert.rejects(
    () => providerConnection.resolveClientPeerFactsForConnection(null),
    (error) => error?.code === 'WINDOWS_PEER_TRANSPORT_UNSUPPORTED',
    'connection-bound resolver must fail closed off win32 even without a connection',
  );
} else {
  await assert.rejects(
    () => providerConnection.resolveClientPeerFactsForConnection({}),
    (error) => error?.code === 'WINDOWS_PEER_CONNECTION_BINDING_UNAVAILABLE',
    'connection-bound resolver must require a bound resolver on win32',
  );
  await assert.rejects(
    () => providerConnection.resolveClientPeerFactsForConnection(null),
    (error) => error?.code === 'WINDOWS_PEER_CONNECTION_REQUIRED',
    'connection-bound resolver must require an accepted connection on win32',
  );
}

console.log(`windows-named-pipe-peer-facts: ${passed} checks passed`);
