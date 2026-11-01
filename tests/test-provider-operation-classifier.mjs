#!/usr/bin/env node
import assert from 'assert/strict';

import { classifyProviderOperation } from '../chat/provider-operation-classifier.mjs';

assert.deepEqual(
  classifyProviderOperation({
    type: 'tool_use',
    toolName: 'Bash',
    toolInput: JSON.stringify({ command: 'npm test -- --runInBand', cwd: '/tmp/work' }),
  }),
  {
    kind: 'command',
    title: 'Running command',
    detail: 'npm test -- --runInBand',
    toolName: 'Bash',
    input: { command: 'npm test -- --runInBand', cwd: '/tmp/work' },
    command: 'npm test -- --runInBand',
    cwd: '/tmp/work',
  },
);

assert.equal(classifyProviderOperation({ toolName: 'Read', toolInput: '{"file_path":"/tmp/a.js"}' }).kind, 'read');
assert.equal(classifyProviderOperation({ toolName: 'Grep', toolInput: '{"pattern":"needle"}' }).kind, 'search');
assert.equal(classifyProviderOperation({ toolName: 'Edit', toolInput: '{"file_path":"/tmp/a.js"}' }).kind, 'file_edit');
assert.equal(classifyProviderOperation({ toolName: 'WebFetch', toolInput: '{"url":"https://example.test"}' }).kind, 'web');
assert.equal(classifyProviderOperation({ toolName: 'Task', toolInput: '{"description":"Check tests"}' }).kind, 'subagent');
assert.equal(classifyProviderOperation({ toolName: 'filesystem/read_file', toolInput: '{}' }).kind, 'mcp');
assert.equal(
  classifyProviderOperation({
    toolName: 'Bash',
    toolInput: 'curl -H "Authorization: Bearer live-token" --api-key raw-secret https://example.test',
  }).detail,
  'curl -H "Authorization: Bearer [redacted]" --api-key [redacted] https://example.test',
);
assert.deepEqual(
  classifyProviderOperation({
    toolName: 'Bash',
    toolInput: '{"command":"curl -H \\"Authorization: Bearer live-token\\" https://example.test","api_key":"raw-secret"}',
  }).input,
  { command: 'curl -H "Authorization: Bearer [redacted]" https://example.test', api_key: '[redacted]' },
  'structured provider input is redacted before entering a projection',
);

console.log('test-provider-operation-classifier: ok');
