#!/usr/bin/env node
import assert from 'node:assert/strict';

import { normalizeP2PHostIceServers } from '../lib/p2p-host-agent.mjs';

assert.deepEqual(
  normalizeP2PHostIceServers([{
    urls: ' turn:turn.example.test:3478?transport=udp ',
    username: ' user ',
    password: ' password ',
  }]),
  [{
    urls: ['turn:turn.example.test:3478?transport=udp'],
    username: 'user',
    credential: 'password',
  }],
  'TURN broker scalar urls must become the Go sidecar list shape',
);

assert.deepEqual(
  normalizeP2PHostIceServers([{
    urls: ['stun:stun.example.test:3478', ' turn:turn.example.test:3478 '],
    username: 'user',
    credential: 'credential',
  }]),
  [{
    urls: ['stun:stun.example.test:3478', 'turn:turn.example.test:3478'],
    username: 'user',
    credential: 'credential',
  }],
  'already-list-shaped ICE servers must remain compatible',
);

assert.throws(
  () => normalizeP2PHostIceServers([{ urls: '' }]),
  /has no URLs/,
  'invalid ICE servers must fail closed before sidecar startup',
);

console.log('test-p2p-host-ice-config: 3 assertions passed');
