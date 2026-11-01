#!/usr/bin/env node
import assert from 'assert/strict';

import { extractBearerToken, matchesWebhookToken, normalizeIp } from '../lib/agent-mail-http-bridge.mjs';

function testNormalizesIp() {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp(''), '');
}

function testExtractsBearerToken() {
  assert.equal(extractBearerToken('Bearer secret-token'), 'secret-token');
  assert.equal(extractBearerToken('plain-token'), 'plain-token');
  assert.equal(extractBearerToken(''), '');
}

function testMatchesWebhookToken() {
  assert.equal(matchesWebhookToken('Bearer mailbox-secret', 'mailbox-secret'), true);
  assert.equal(matchesWebhookToken('mailbox-secret', 'mailbox-secret'), true);
  assert.equal(matchesWebhookToken('Bearer wrong-token', 'mailbox-secret'), false);
  assert.equal(matchesWebhookToken('Bearer mailbox-secret', ''), false);
}

testNormalizesIp();
testExtractsBearerToken();
testMatchesWebhookToken();
console.log('agent mail http bridge tests passed');
