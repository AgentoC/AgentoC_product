#!/usr/bin/env node
import assert from 'assert/strict';
import { buildAgentCapabilityCatalog } from '../chat/agent-capability-catalog.mjs';

const catalog = await buildAgentCapabilityCatalog({
  apps: [
    { id: 'builtin-chat', name: 'Chat', builtin: true },
    { id: 'agent-good', name: 'Good Agent', tool: '' },
    { id: 'agent-bad', name: 'Broken Agent', tool: 'broken-tool' },
  ],
  getTool: async (toolId) => {
    if (toolId === 'broken-tool') {
      const error = new Error('provider definition unavailable');
      error.code = 'TOOL_DEFINITION_UNAVAILABLE';
      throw error;
    }
    return null;
  },
});

assert.equal(catalog.state, 'degraded', 'one broken Agent produces a degraded Catalog');
assert.deepEqual(catalog.agents.map((agent) => agent.agentId), ['agent-good'], 'a broken Agent does not hide healthy Agents');
assert.equal(catalog.agents[0].selectable, true, 'healthy Agent is selectable');
assert.equal(catalog.errors.length, 1, 'Catalog exposes one safe diagnostic');
assert.equal(catalog.errors[0].agentId, 'agent-bad', 'diagnostic identifies the broken Agent');
assert.equal(catalog.errors[0].code, 'TOOL_DEFINITION_UNAVAILABLE', 'diagnostic preserves the stable error code');
assert.equal(Object.hasOwn(catalog.errors[0], 'stack'), false, 'diagnostic does not expose a stack');
assert.match(catalog.revision, /^sha256:/, 'Catalog has a stable revision digest');

const empty = await buildAgentCapabilityCatalog({
  apps: [{ id: 'chat', builtin: true }],
});
assert.equal(empty.state, 'empty', 'built-in product surfaces do not make a Catalog selectable');
assert.deepEqual(empty.agents, [], 'empty Catalog contains no Agent profiles');
assert.deepEqual(empty.errors, [], 'empty Catalog is not reported as degraded');

console.log('test-agent-capability-catalog: ok');
