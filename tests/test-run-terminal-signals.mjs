#!/usr/bin/env node
import assert from 'assert/strict';
import { isProviderRunCompletionEvent } from '../chat/run-terminal-signals.mjs';

assert.equal(
  isProviderRunCompletionEvent({
    type: 'status',
    content: 'completed',
    providerLifecycle: 'task_notification',
  }, 'claude-stream-json-bidi'),
  false,
  'Claude background task completion must not terminate the parent bidi run',
);

assert.equal(
  isProviderRunCompletionEvent({
    type: 'status',
    content: 'completed',
    providerLifecycle: 'completed',
  }, 'claude-stream-json-bidi'),
  true,
  'Claude top-level result completion should terminate the bidi run',
);

assert.equal(
  isProviderRunCompletionEvent({ type: 'status', content: 'completed' }, 'codex-app-server-json'),
  false,
  'Codex completion must carry an explicit provider lifecycle',
);

assert.equal(
  isProviderRunCompletionEvent({
    type: 'status',
    content: 'completed',
    providerLifecycle: 'completed',
    providerTurnId: 'turn-current',
  }, 'codex-app-server-json', 'turn-current'),
  true,
  'the current Codex turn completion should be accepted',
);

assert.equal(
  isProviderRunCompletionEvent({
    type: 'status',
    content: 'completed',
    providerLifecycle: 'completed',
    providerTurnId: 'turn-old',
  }, 'codex-app-server-json', 'turn-current'),
  false,
  'a stale Codex turn completion should be ignored by the observer',
);

assert.equal(
  isProviderRunCompletionEvent({ type: 'status', content: 'completed' }, 'other-runtime'),
  true,
  'other runtimes retain their existing completion behavior',
);

console.log('test-run-terminal-signals: ok');
