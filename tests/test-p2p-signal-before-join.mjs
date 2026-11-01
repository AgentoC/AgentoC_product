#!/usr/bin/env node
// 回归测试：移动端 App（当前 pairing-p2p 构建）会在收到服务器的 joined 确认前
// 就先发送 offer signal。修复前信令服务器把"第一条消息不是 join"的客户端直接
// 1008 关闭（App 日志：ws closed (1008 invalid join)），配对永远走不通。
// 修复后：join 前到达的合法 signal 先缓冲，join 到位后按序转给 host，offer 仍能
// 收到 answer。
import assert from 'assert/strict';
import http from 'http';
import { arch } from 'process';

import WebSocket from 'ws';

import { runP2PHostAgent } from '../lib/p2p-host-agent.mjs';
import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';
import { createP2PRoomId, signP2PSignal } from '../lib/p2p-signal-protocol.mjs';
import { createP2PSignaling } from '../p2p/signaling-server.mjs';

if (!['arm64', 'x64'].includes(arch)) {
  console.log(`P2P signal-before-join test skipped on ${arch}; no supported sidecar`);
  process.exit(0);
}

const binaryPath = resolveP2PHostBinary();
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OFFER = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:p', 'a=ice-pwd:pppppppppppppppppppp',
  'a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
].join('\r\n');

const resources = [];
try {
  const chatLike = http.createServer((request, response) => { response.writeHead(404); response.end(); });
  const p2pSignaling = createP2PSignaling();
  chatLike.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/signal') { p2pSignaling.handleUpgrade(req, socket, head); return; }
    socket.destroy();
  });
  resources.push(async () => { p2pSignaling.close(); await close(chatLike); });
  const chatAddress = await listen(chatLike);
  const signalingUrl = `http://127.0.0.1:${chatAddress.port}`;

  const secret = 'rpi_signal_before_join_test';
  const roomId = createP2PRoomId(secret);
  const host = await runP2PHostAgent({
    signalingUrl,
    roomId,
    secret,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    binaryPath,
    localBaseUrl: `http://127.0.0.1:${chatAddress.port}`,
    // Match the TURN broker contract. runP2PHostAgent must normalize this
    // scalar URL before passing the configuration to the Go sidecar.
    iceServers: [{
      urls: 'turn:127.0.0.1:3478?transport=udp',
      username: 'test-user',
      password: 'test-password',
    }],
  });
  resources.push(async () => { host.stop(); await host.done; });
  await host.ready;

  // 模拟 App 的真实时序：WS open 后不等待 joined，先发 offer signal，再发 join。
  const result = await new Promise((resolve) => {
    let seq = 1;
    const sign = (payload) => signP2PSignal({ roomId, secret, seq: seq++, payload });
    const ws = new WebSocket(`ws://127.0.0.1:${chatAddress.port}/signal`);
    let joined = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve('TIMEOUT'); }, 8000);
    ws.on('open', () => {
      // 与 App 一致：offer 帧先于 join 帧入队。
      ws.send(JSON.stringify({ type: 'signal', roomId, envelope: sign({ type: 'offer', sdp: OFFER }) }));
      ws.send(JSON.stringify({ type: 'join', roomId, role: 'mobile' }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'joined') joined = true;
      if (m.type === 'signal' && m.envelope?.payload?.type === 'answer') {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(joined ? 'ANSWER_AFTER_JOIN' : 'ANSWER_BEFORE_JOIN_ACK');
      }
    });
    ws.on('close', (code, reason) => {
      if (code !== 1000) { clearTimeout(timer); resolve(`CLOSED ${code} ${reason}`); }
    });
    ws.on('error', (e) => { clearTimeout(timer); resolve(`WS_ERR ${e.message}`); });
  });

  assert.equal(result, 'ANSWER_AFTER_JOIN', `offer sent before join must still get answer, got ${result}`);
  console.log('P2P signal-before-join test passed (pre-join offer buffered and relayed after join)');
} finally {
  for (const cleanup of resources.reverse()) {
    try { await cleanup(); } catch {}
  }
}
