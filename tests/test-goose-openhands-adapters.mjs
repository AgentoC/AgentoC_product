#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildGooseArgs, createGooseAdapter } from '../chat/adapters/goose.mjs';
import { buildOpenHandsArgs, createOpenHandsAdapter } from '../chat/adapters/openhands.mjs';

assert.deepEqual(buildGooseArgs('检查代码'), [
  'run', '--text', '检查代码', '--output-format', 'stream-json', '--quiet', '--no-session',
]);
assert.throws(() => buildOpenHandsArgs('修复 bug'), /no detached prompt CLI/);
const goose = createGooseAdapter();
assert.equal(goose.parseLine('done').length, 0, 'non-JSON diagnostics are not assistant content');
assert.equal(goose.parseLine(JSON.stringify({
  type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
}))[0].type, 'text_delta');
assert.equal(goose.parseLine(JSON.stringify({ type: 'complete' }))[0].content, 'done');
assert.equal(createOpenHandsAdapter().parseLine('done')[0].content, 'done');
console.log('Goose/OpenHands adapter tests passed');
