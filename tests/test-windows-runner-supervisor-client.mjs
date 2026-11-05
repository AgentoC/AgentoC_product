import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { exchangeWindowsSupervisorRequest } from '../chat/run-launcher.mjs';

function fixture(reply, exitCode = 0) {
  let command, args, received = '';
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new Writable({
    write(chunk, encoding, done) { received += chunk.toString(); done(); },
    final(done) { done(); queueMicrotask(() => { child.stdout.end(reply); child.emit('close', exitCode); }); },
  });
  child.kill = () => {};
  return { spawn(executable, argv) { command = executable; args = argv; return child; },
    snapshot: () => ({ command, args, received }) };
}
const request = { type: 'launch', runId: 'run_fixture', oauthLockToken: 'fixture-private-token' };
const ok = fixture('{"ok":true,"pid":42}\n');
assert.deepEqual(await exchangeWindowsSupervisorRequest(request, { spawnImpl: ok.spawn, executable: 'fixed-host.exe' }), { ok: true, pid: 42 });
assert.deepEqual(ok.snapshot().args, ['--runner-supervisor-pipe']);
assert.equal(ok.snapshot().command, 'fixed-host.exe');
assert.deepEqual(JSON.parse(ok.snapshot().received), request);
assert.ok(!JSON.stringify(ok.snapshot().args).includes(request.oauthLockToken), 'run-bound token must stay off command line');
const rejected = fixture('{"ok":false,"code":"POLICY_DENIED","error":"not permitted"}\n');
await assert.rejects(exchangeWindowsSupervisorRequest(request, { spawnImpl: rejected.spawn }), { code: 'POLICY_DENIED' });
const badPeer = fixture('', 1);
await assert.rejects(exchangeWindowsSupervisorRequest(request, { spawnImpl: badPeer.spawn }), /native client rejected/);
await assert.rejects(exchangeWindowsSupervisorRequest({ payload: 'x'.repeat(16384) }, { spawnImpl: ok.spawn }), /too large/);
console.log('windows-runner-supervisor-client: request framing and failures passed');
