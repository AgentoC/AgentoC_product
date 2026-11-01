#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildCodexArgs,
  DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
} from '../chat/adapters/codex.mjs';

const args = buildCodexArgs('Say hello.', {});
assert.equal(args[0], 'exec');
assert.equal(args.at(-1), 'Say hello.');
assert.equal(args.includes('IMPORTANT: Complete ALL requested work in this single response.'), false);
assert.ok(
  args.includes('--disable') && args.includes('unified_exec'),
  'Codex runs should disable unified_exec using the current feature flag syntax',
);
assert.equal(
  args.includes('experimental_use_unified_exec_tool=false'),
  false,
  'Codex args should not use the deprecated unified exec config key',
);
const defaultDeveloperInstructionIndex = args.indexOf('-c');
assert.notEqual(defaultDeveloperInstructionIndex, -1);
assert.ok(
  args.includes(`developer_instructions=${JSON.stringify(DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS)}`),
  'Codex args should include the default developer instructions',
);

const overridden = buildCodexArgs('Say hello.', { systemPrefix: 'PREFIX\n\n' });
assert.equal(overridden.at(-1), 'PREFIX\n\nSay hello.');

const noImplicitResume = buildCodexArgs('Continue.', { threadId: 'thread-test-1' });
assert.equal(
  noImplicitResume.includes('resume'),
  false,
  'Codex should not resume provider threads unless explicitly requested',
);
assert.equal(noImplicitResume.at(-1), 'Continue.');

const explicitResume = buildCodexArgs('Continue.', {
  threadId: 'thread-test-1',
  useResume: true,
});
const resumeIndex = explicitResume.indexOf('resume');
assert.notEqual(resumeIndex, -1, 'explicit resume should still be available for diagnostics or opt-in workflows');
assert.equal(explicitResume[resumeIndex + 1], 'thread-test-1');

const withDeveloperInstructions = buildCodexArgs('Say hello.', {
  developerInstructions: 'Use plain prose.',
});
const developerInstructionIndex = withDeveloperInstructions.indexOf('-c');
assert.notEqual(developerInstructionIndex, -1);
assert.ok(
  withDeveloperInstructions.includes(
  'developer_instructions="Use plain prose."',
  ),
  'explicit developer instructions should be passed as a config override',
);

const withoutDeveloperInstructions = buildCodexArgs('Say hello.', {
  developerInstructions: '',
});
assert.equal(withoutDeveloperInstructions.includes('developer_instructions='), false);

console.log('ok - codex args do not inject a default system prefix');
console.log('ok - codex args inject a lightweight default developer instruction');
console.log('ok - codex args still allow explicit per-run system prefixes');
console.log('ok - codex args allow explicit developer instructions via config override');
console.log('ok - codex args allow explicit opt-out of developer instructions');
