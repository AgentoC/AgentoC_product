#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  createClaudeThinkingTokenSampler,
  isClaudeThinkingTokenFrame,
} from '../chat/provider-spool-sampling.mjs';

const frame = (estimatedTokens) => ({
  type: 'system',
  subtype: 'thinking_tokens',
  estimated_tokens: estimatedTokens,
});

assert.equal(isClaudeThinkingTokenFrame(frame(1)), true);
assert.equal(isClaudeThinkingTokenFrame({ type: 'stream_event' }), false);

const sampler = createClaudeThinkingTokenSampler({ intervalMs: 1000 });
assert.equal(sampler.observe(frame(1), 10_000).persist, true, 'first counter is retained');
for (let index = 2; index <= 1000; index += 1) {
  assert.equal(sampler.observe(frame(index), 10_100).persist, false);
}
assert.equal(
  sampler.flush()?.estimated_tokens,
  1000,
  'terminal flush retains the newest counter skipped inside the interval',
);
assert.equal(sampler.flush(), null, 'terminal flush is one-shot');
assert.equal(sampler.observe(frame(1001), 11_100).persist, true, 'next interval retains a current sample');

const passthrough = { type: 'stream_event', event: { type: 'content_block_delta' } };
assert.deepEqual(
  sampler.observe(passthrough, 11_101),
  { handled: false, persist: true, frame: passthrough },
  'non-counter provider frames are never sampled',
);

console.log('test-provider-spool-sampling: ok');
