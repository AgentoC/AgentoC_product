#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function unitValue(unitText, key) {
  const match = unitText.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

function assertNoRequires(unitText, unitName, forbiddenUnit) {
  for (const line of unitText.split(/\r?\n/)) {
    if (!line.startsWith('Requires=')) continue;
    assert.equal(
      line.includes(forbiddenUnit),
      false,
      `${unitName} must not hard-require ${forbiddenUnit}; basic chat must start without privileged executor paths`,
    );
  }
}

const chatServer = read('chat-server.mjs');
const agentocUnit = read('packaging/deb/agentoc.service');
const runnerSupervisorService = read('packaging/deb/agentoc-runner-supervisor.service');
const privilegedUnit = read('packaging/deb/agentoc-privileged-executor.service');

for (const forbidden of [
  'agentoc-maintenance-broker.service',
  'agentoc-maintenance-control.service',
  'agentoc-privileged-executor.service',
]) {
  assertNoRequires(agentocUnit, 'agentoc.service', forbidden);
}

assert.match(agentocUnit, /^Requires=agentoc-runner-supervisor\.service$/m);
assert.match(agentocUnit, /^Restart=always$/m);
assert.doesNotMatch(agentocUnit, /^ConditionPathExists=.*privileged/m);
assert.equal(unitValue(privilegedUnit, 'Restart'), 'on-failure');
assert.doesNotMatch(agentocUnit, /agentoc-maintenance|maintenance-control/);
assert.doesNotMatch(runnerSupervisorService, /agentoc-maintenance|maintenance-control/);

assert.match(chatServer, /req\.method === 'GET' && req\.url === '\/healthz'/);
assert.match(chatServer, /writeHealthz\(res\);\s*return;/);
assert.match(chatServer, /requestLog\.run\(\(\) => handleRequest\(req, res\)\)\.catch/);
assert.doesNotMatch(chatServer, /maintenance-control-service\.mjs/);
assert.doesNotMatch(chatServer, /maintenance-broker\.mjs/);
assert.doesNotMatch(chatServer, /privileged-executor\.mjs/);

console.log('test-basic-ops-sla-decoupling: ok');
