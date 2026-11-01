import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TunnelClient } from '../tunnel/tunnel-client.mjs';

function client() {
  return new TunnelClient({
    url: 'https://example.test/tunnel',
    target: { host: '127.0.0.1', port: 7690 },
    token: 'test-token',
  });
}

{
  const tunnel = client();
  tunnel.activeConnectionId = 7;
  tunnel.connected = true;
  tunnel.scheduleReconnect('late close from old connection', 6);
  assert.equal(tunnel.activeConnectionId, 7, 'a stale event must not tear down the active control connection');
  assert.equal(tunnel.pendingReconnect, false, 'a stale event must not schedule another connection');
}

{
  const tunnel = client();
  tunnel.retryDelay = 1;
  tunnel.activeConnectionId = 7;
  tunnel.connected = true;
  let connectCalls = 0;
  tunnel.connect = async () => { connectCalls += 1; };
  tunnel.scheduleReconnect('control connection closed', 7);

  // Simulate a new control connection becoming active before an old retry
  // callback gets its turn on the event loop.
  tunnel.activeConnectionId = 8;
  tunnel.connected = true;
  await delay(20);

  assert.equal(connectCalls, 0, 'an old retry callback must not create a second control connection');
  assert.equal(tunnel.activeConnectionId, 8, 'an old retry callback must leave the replacement connection intact');
  assert.equal(tunnel.pendingReconnect, false, 'a skipped retry must clear its pending state');
}

console.log('test-tunnel-client-reconnect: ok');
