#!/usr/bin/env node
import assert from 'assert/strict';

import { buildClaudeArgs } from '../chat/adapters/claude.mjs';
import { buildClaudeBidiArgs } from '../chat/adapters/claude-bidi.mjs';

const explicitEffort = buildClaudeArgs('hello world', {
  model: 'sonnet',
  effort: 'medium',
});
assert.deepEqual(
  explicitEffort.slice(-4),
  ['--model', 'sonnet', '--effort', 'medium'],
  'explicit Claude effort should pass through to the CLI args',
);
assert.deepEqual(
  explicitEffort.slice(0, 2),
  ['-p', '--output-format'],
  'Claude prompt must be supplied through stdin, never as an argv value',
);

const thinkingFallback = buildClaudeArgs('hello world', {
  model: 'sonnet',
  thinking: true,
});
assert.deepEqual(
  thinkingFallback.slice(-4),
  ['--model', 'sonnet', '--effort', 'high'],
  'thinking toggle should still map to high effort when no explicit effort is set',
);

const explicitWins = buildClaudeArgs('hello world', {
  model: 'sonnet',
  effort: 'low',
  thinking: true,
});
assert.deepEqual(
  explicitWins.slice(-4),
  ['--model', 'sonnet', '--effort', 'low'],
  'explicit Claude effort should win over the legacy thinking fallback',
);

for (const effort of ['xhigh', 'max']) {
  const args = buildClaudeArgs('hello world', {
    model: 'opus',
    effort,
  });
  assert.deepEqual(
    args.slice(-4),
    ['--model', 'opus', '--effort', effort],
    `Claude ${effort} effort should pass through to the CLI args`,
  );
}

const nativePermissionMode = buildClaudeArgs('hello world', {
  permissionMode: 'acceptEdits',
});
assert.deepEqual(
  nativePermissionMode.slice(-2),
  ['--permission-mode', 'acceptEdits'],
  'Claude permission mode should pass through to the native CLI flag',
);

const defaultPermissionMode = buildClaudeArgs('hello world', {
  permissionMode: 'default',
});
assert.deepEqual(
  defaultPermissionMode.slice(-2),
  ['--permission-mode', 'default'],
  'Claude default permission mode must pass through so the approval gate remains active',
);

const bidiDefaultPermissionMode = buildClaudeBidiArgs({ permissionMode: 'default' });
assert.deepEqual(
  bidiDefaultPermissionMode.slice(-2),
  ['--permission-mode', 'default'],
  'Claude bidi must preserve default so its stdio approval gate remains active',
);

const legacySkipPermissionMode = buildClaudeArgs('hello world', {
  permissionMode: 'skip-permissions',
});
assert.deepEqual(
  legacySkipPermissionMode.slice(-2),
  ['--permission-mode', 'bypassPermissions'],
  'legacy skip-permissions should map to the native Claude bypassPermissions mode',
);

console.log('test-claude-build-args: ok');
