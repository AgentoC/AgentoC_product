#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { createClaudeAdapter } from '../chat/adapters/claude.mjs';
import { createCodexAppServerAdapter } from '../chat/adapters/codex-app-server.mjs';
import { buildOperationProjection } from '../chat/operation-projection.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readJsonl(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function replay(lines, adapter) {
  let seq = 0;
  const events = [];
  for (const line of lines) {
    for (const event of adapter.parseLine(JSON.stringify(line))) {
      events.push({ ...event, seq: ++seq });
    }
  }
  return { events, projection: buildOperationProjection(events) };
}

const claude = replay(
  readJsonl('tests/fixtures/provider-events/claude/stream-json-edit.jsonl'),
  createClaudeAdapter(),
);
assert.equal(claude.events.filter((event) => event.type === 'tool_use').length, 1);
assert.equal(claude.projection.operations.length, 1);
assert.equal(claude.projection.operations[0].toolCall.kind, 'edit');
assert.equal(claude.projection.operations[0].toolCall.status, 'completed');
assert.equal(claude.projection.operations[0].presentation.subject, 'example.js');

const codex = replay(
  readJsonl('tests/fixtures/provider-events/codex/app-server-command.jsonl'),
  createCodexAppServerAdapter(),
);
assert.equal(codex.events.filter((event) => event.type === 'tool_use').length, 2);
assert.equal(codex.projection.operations.length, 1);
assert.equal(codex.projection.operations[0].toolCall.kind, 'execute');
assert.equal(codex.projection.operations[0].toolCall.status, 'completed');
assert.equal(codex.projection.operations[0].presentation.subject, 'npm test');

console.log('test-provider-event-replay: ok');
