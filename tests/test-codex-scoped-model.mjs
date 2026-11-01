import assert from 'node:assert/strict';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

for (const [requested, expected] of [
  ['gpt-5.6-luna@review-provider', 'gpt-5.6-luna'],
  ['gpt-5.6-luna', 'gpt-5.6-luna'],
]) {
  const invocation = buildRuntimeInvocation('codex-json', 'Hello', { model: requested }, 'codex');
  const index = invocation.args.indexOf('-m');
  assert.notEqual(index, -1);
  assert.equal(invocation.args[index + 1], expected);
}
