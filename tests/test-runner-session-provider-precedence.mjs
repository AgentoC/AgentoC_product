#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveCodexRunModelSelection } from '../chat/runner-sidecar.mjs';

assert.deepEqual(
  resolveCodexRunModelSelection(
    { providerProfile: 'session-provider' },
    'gpt-5.6-sol@stale-model-provider',
  ),
  { model: 'gpt-5.6-sol', providerId: 'session-provider' },
  'the session Provider must override a stale scoped-model suffix',
);

assert.deepEqual(
  resolveCodexRunModelSelection({}, 'gpt-5.6-sol@legacy-provider'),
  { model: 'gpt-5.6-sol', providerId: 'legacy-provider' },
  'legacy sessions without providerProfile should retain scoped-model routing',
);

console.log('test-runner-session-provider-precedence: ok');
