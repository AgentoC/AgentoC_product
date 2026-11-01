#!/usr/bin/env node
import assert from 'assert/strict';
import { closeWebSocketServer } from '../chat/ws-shutdown.mjs';

const clients = new Set();
const closedClients = [];

function makeClient(name) {
  const client = {
    readyState: 1,
    close(code, reason) {
      closedClients.push({ name, code, reason });
      this.readyState = 3;
      clients.delete(this);
    },
    terminate() {
      this.readyState = 3;
      clients.delete(this);
    },
  };
  clients.add(client);
  return client;
}

makeClient('browser-1');
makeClient('browser-2');
let wssCloseCalls = 0;
const wss = {
  clients,
  close(callback) {
    wssCloseCalls += 1;
    callback();
  },
};

const result = await closeWebSocketServer(wss, { timeoutMs: 50 });
assert.equal(result.clients, 2, 'shutdown should report the tracked client count');
assert.equal(result.terminated, 0, 'graceful clients should not require termination');
assert.equal(closedClients.length, 2, 'shutdown should close every tracked WebSocket client');
assert.deepEqual(closedClients.map((entry) => entry.code), [1001, 1001]);
assert.deepEqual(closedClients.map((entry) => entry.reason), ['Service restarting', 'Service restarting']);
assert.equal(wssCloseCalls, 1, 'shutdown should close the WebSocket server exactly once');
assert.equal(clients.size, 0, 'all tracked clients should leave before HTTP drain');

const stubbornClients = new Set();
const stubbornClient = {
  readyState: 1,
  close() {},
  terminate() {
    this.readyState = 3;
    stubbornClients.delete(this);
  },
};
stubbornClients.add(stubbornClient);
const stubbornWss = {
  clients: stubbornClients,
  close() {},
};
const forcedResult = await closeWebSocketServer(stubbornWss, { timeoutMs: 5 });
assert.equal(forcedResult.clients, 1, 'forced shutdown should report the stuck client');
assert.equal(forcedResult.terminated, 1, 'stuck clients should be terminated at the bounded deadline');
assert.equal(stubbornClients.size, 0, 'forced shutdown should remove stuck clients');

console.log('test-chat-ws-shutdown: ok');
