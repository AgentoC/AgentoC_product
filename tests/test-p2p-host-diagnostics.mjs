import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startP2PHostForDevice, stopAllP2PHosts } from '../lib/p2p-host-registry.mjs';

const id = 'diagnostic-device-id';
const tag = createHash('sha256').update(id).digest('hex').slice(0, 12);
const originalLog = console.log;
const originalStderrWrite = process.stderr.write;
const logs = [];
let resolveDone;
try {
  console.log = line => logs.push(line);
  process.stderr.write = line => { logs.push(String(line)); return true; };
  const result = await startP2PHostForDevice(id, {
    signalingUrl: 'https://signal.example.test',
    p2pAccess: { roomId: 'a'.repeat(40), secret: 'private-room-secret' },
    runHostAgent: async options => {
      options.onSidecarLog('turn permission refresh failed');
      return { ready: Promise.resolve(), done: new Promise(resolve => { resolveDone = resolve; }),
        stop: () => resolveDone() };
    },
  });
  assert.equal(result.started, true);
  assert.ok(logs.some(line => line.includes(`device_tag=${tag}`) && line.includes('host-ready')));
  assert.ok(logs.some(line => line.includes(`device_tag=${tag}`) && line.includes('turn permission refresh failed')));
  assert.ok(logs.every(line => !line.includes(id) && !line.includes('private-room-secret')));
} finally {
  await stopAllP2PHosts();
  console.log = originalLog;
  process.stderr.write = originalStderrWrite;
}
console.log('P2P host lifecycle and sidecar errors share a pseudonymous device tag');
