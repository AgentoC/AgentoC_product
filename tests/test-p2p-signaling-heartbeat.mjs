import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createP2PSignaling } from '../p2p/signaling-server.mjs';

const realNow = Date.now;
const realSetInterval = globalThis.setInterval;
let now = realNow();
let sweep;
Date.now = () => now;
globalThis.setInterval = (callback, delay, ...args) => {
  if (delay === 60_000) sweep = callback;
  return realSetInterval(callback, delay, ...args);
};
const signaling = createP2PSignaling();
globalThis.setInterval = realSetInterval;
const server = http.createServer();
server.on('upgrade', (req, socket, head) => signaling.handleUpgrade(req, socket, head));
const sockets = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/signal`;
  const join = async role => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'join', roomId: 'a'.repeat(40), role }));
    await new Promise(resolve => ws.once('message', resolve));
    return ws;
  };
  const host = await join('host');
  const mobile = await join('mobile');
  now += 14 * 60_000;
  const pong = new Promise(resolve => host.once('pong', resolve));
  host.ping();
  await pong;
  now += 2 * 60_000;
  sweep();
  assert.equal(host.readyState, WebSocket.OPEN);
  assert.equal(mobile.readyState, WebSocket.OPEN);
  const closed = Promise.all([host, mobile].map(ws => new Promise(resolve => ws.once('close', (code, reason) => resolve([code, String(reason)])))));
  now += 14 * 60_000;
  sweep();
  assert.deepEqual(await closed, [[1001, 'expired'], [1001, 'expired']]);
  console.log('P2P signaling heartbeats preserve active rooms and stale rooms expire');
} finally {
  Date.now = realNow;
  globalThis.setInterval = realSetInterval;
  for (const ws of sockets) ws.terminate();
  signaling.close();
  await new Promise(resolve => server.close(resolve));
}
