#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  bareProviderModel,
  classifyProviderFailure,
  hasProviderSideEffects,
  rankProviderFailoverCandidates,
  resolveProviderFailoverModel,
  shouldFailoverProvider,
} from '../lib/provider-runtime/failover.mjs';

assert.equal(classifyProviderFailure('401 invalid api key').kind, 'auth');
assert.equal(classifyProviderFailure('refresh token was already used').kind, 'auth');
assert.equal(classifyProviderFailure('model gpt-x is not supported').kind, 'configuration');
assert.equal(classifyProviderFailure('502 upstream error').kind, 'transient');
assert.equal(classifyProviderFailure('prompt rejected by policy').kind, 'unknown');

assert.equal(shouldFailoverProvider({ failureReason: '502 upstream error' }), true);
assert.equal(shouldFailoverProvider({ failureReason: 'invalid api key' }), false);
assert.equal(shouldFailoverProvider({ failureReason: '502 upstream error', attempt: 1 }), false);

assert.equal(hasProviderSideEffects([{ type: 'status' }]), false);
assert.equal(hasProviderSideEffects([{ type: 'tool_call', name: 'exec' }]), true);
assert.equal(hasProviderSideEffects([{ method: 'approval_request' }]), true);

assert.equal(bareProviderModel('gpt-5@work-codex'), 'gpt-5');
assert.equal(bareProviderModel('claude@not-a-provider/id'), 'claude@not-a-provider/id');
assert.deepEqual(
  resolveProviderFailoverModel({ modelPolicy: { sonnet: 'claude-sonnet-4-6' } }, 'sonnet@backup', 'claude'),
  { model: 'sonnet', exactModel: true },
);
assert.deepEqual(
  resolveProviderFailoverModel({ modelPolicy: {} }, 'opus@backup', 'claude'),
  { model: 'opus', exactModel: true },
);
assert.equal(
  resolveProviderFailoverModel({ modelPolicy: { models: [{ id: 'other' }] } }, 'sonnet', 'claude'),
  null,
);

const ranked = rankProviderFailoverCandidates([
  { id: 'chat', displayName: 'Chat gateway', exactModel: true, protocol: 'openai-chat' },
  { id: 'responses', displayName: 'Responses gateway', exactModel: true, protocol: 'openai-responses' },
  { id: 'other', displayName: 'Other', exactModel: false, protocol: 'openai-responses' },
], { currentProtocol: 'openai-responses' });
assert.deepEqual(ranked.map((candidate) => candidate.id), ['responses', 'chat', 'other']);

console.log('test-provider-failover: classification, side-effect gate, and candidate ranking OK');
