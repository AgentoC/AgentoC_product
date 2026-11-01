#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import {
  createProviderNativeDelegationMapper,
  mapClaudeProviderDelegationEvent,
  mapCodexProviderDelegationEvent,
  replayProviderNativeDelegations,
} from '../chat/provider-native-delegation-mapper.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function fixture(name) {
  return readFileSync(join(root, 'tests', 'fixtures', 'provider-events', name), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
}

function replay(provider, events) {
  return replayProviderNativeDelegations(events, {
    provider,
    runId: `run-${provider}`,
    parentSessionId: `session-${provider}`,
  });
}

const claudeLines = fixture('claude/native-delegations.jsonl');
const claude = replay('claude', claudeLines);
assert.equal(claude.ok, true, claude.errors.join('; '));
assert.equal(claude.events.length, 6);
assert.equal(claude.events.filter((event) => event.kind === 'spawned').length, 3);
assert.equal(claude.events.filter((event) => event.kind === 'completed').length, 2);
assert.equal(claude.events.filter((event) => event.kind === 'failed').length, 1);
assert.equal(claude.projection.ok, true);
assert.deepEqual([...claude.activeChildSessionIds], []);
assert.equal(claude.events.some((event) => event.parentDelegationId), true, 'nested parent identity must survive mapping');
assert.equal(mapClaudeProviderDelegationEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'not a delegation' }] } }, { runId: 'r', parentSessionId: 'p' }).events.length, 0);

const codexLines = fixture('codex/native-delegations.jsonl');
const codex = replay('codex', codexLines);
assert.equal(codex.ok, true, codex.errors.join('; '));
assert.equal(codex.controls.filter((control) => control.control === 'send').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'recovered').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'failed').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'cancelled').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'interrupted').length, 1);
assert.equal(codex.events.filter((event) => event.kind === 'lost').length, 1);
assert.equal(codex.events.some((event) => event.parentDelegationId), true, 'nested Codex delegation must be represented');
assert.deepEqual([...codex.activeChildSessionIds], []);
assert.equal(mapCodexProviderDelegationEvent({ method: 'item/started', params: { item: { type: 'message', text: 'ordinary' } } }, { runId: 'r', parentSessionId: 'p' }).events.length, 0);

for (const [provider, lines] of [['claude', claudeLines], ['codex', codexLines]]) {
  const first = replay(provider, lines);
  for (let index = 0; index < 10; index += 1) {
    const next = replay(provider, lines);
    assert.deepEqual(next.events, first.events, `${provider} canonical events must be replay-deterministic`);
    assert.deepEqual(next.controls, first.controls, `${provider} controls must be replay-deterministic`);
    assert.deepEqual(next.activeChildSessionIds, first.activeChildSessionIds);
    assert.equal(next.projection.ok, first.projection.ok);
  }
}

const mapper = createProviderNativeDelegationMapper({ provider: 'claude', runId: 'run-message', parentSessionId: 'parent' });
const messageResult = mapper.map({ type: 'user', message: { content: [{ type: 'text', text: 'child message must not leak' }] } });
assert.deepEqual(messageResult.events, []);
assert.deepEqual(messageResult.controls, []);

// Ordinary (non-delegation) tool roundtrips must not produce delegation
// events.  Regression for delegation_replay_invalid: a tool_result for a
// non-Task tool (Bash/Read/...) used to be mapped as an orphan terminal
// delegation event, which the canonical projector rejects because its first
// event can never be 'spawned' — failing the whole Run at finalization even
// though the provider completed successfully.
const ordinaryLines = fixture('claude/ordinary-tool-roundtrip.jsonl');
const ordinary = replay('claude', ordinaryLines);
assert.equal(ordinary.ok, true, ordinary.errors.join('; '));
assert.equal(ordinary.events.length, 0, 'ordinary tool roundtrips must map to zero delegation events');
assert.equal(ordinary.projection.ok, true);

const mixedLines = fixture('claude/ordinary-plus-delegation.jsonl');
const mixed = replay('claude', mixedLines);
assert.equal(mixed.ok, true, mixed.errors.join('; '));
assert.equal(mixed.events.length, 2, 'only the real Task delegation maps to events');
assert.equal(mixed.events.filter((event) => event.kind === 'spawned').length, 1);
assert.equal(mixed.events.filter((event) => event.kind === 'completed').length, 1);
assert.equal(mixed.projection.ok, true);
for (let index = 0; index < 10; index += 1) {
  assert.deepEqual(replay('claude', mixedLines).events, mixed.events, 'ordinary+delegation mapping must be replay-deterministic');
}

console.log('test-provider-native-delegation-mapper: ok');
