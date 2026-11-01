#!/usr/bin/env node
import assert from 'assert/strict';

import { parseModelCapabilities } from '../chat/models.mjs';

const result = parseModelCapabilities({
  supported_reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  default_effort: 'medium',
});

assert.deepEqual(result.effort, {
  supported: true,
  levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  default: 'medium',
  source: 'upstream',
});
assert.equal(result.serviceTier.supportsFast, null);

console.log('test-models-claude-reasoning: capability normalization ok');
