#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildHomeProjection } from '../chat/home-projection.mjs';

const now = Date.parse('2026-08-07T08:00:00.000Z');

function session(id, overrides = {}) {
  return {
    id,
    name: id,
    description: `${id} summary`,
    updatedAt: '2026-08-06T08:00:00.000Z',
    activity: { run: { state: 'idle' } },
    ...overrides,
  };
}

const projection = buildHomeProjection({
  now,
  sessions: [
    session('waiting', {
      workflowState: 'waiting_user',
      lastEventAt: '2026-08-07T07:50:00.000Z',
    }),
    session('high', {
      workflowPriority: 'high',
      lastEventAt: '2026-08-07T07:40:00.000Z',
    }),
    session('running', {
      lastEventAt: '2026-08-07T07:30:00.000Z',
      activity: { run: { state: 'running', runId: 'run-1' } },
    }),
    session('done', {
      workflowState: 'done',
      lastEventAt: '2026-08-06T07:00:00.000Z',
    }),
    session('reviewed', {
      workflowState: 'waiting_user',
      lastEventAt: '2026-08-07T07:55:00.000Z',
      lastReviewedAt: '2026-08-07T07:59:00.000Z',
    }),
    session('archived', { archived: true, workflowState: 'waiting_user' }),
    session('internal', { isInternalSession: true, workflowState: 'waiting_user' }),
  ],
  triggers: [
    {
      id: 'failed-trigger',
      sessionId: 'high',
      enabled: true,
      status: 'failed',
      lastError: 'Provider unavailable',
      scheduledAt: '2026-08-07T06:00:00.000Z',
    },
    {
      id: 'upcoming-trigger',
      sessionId: 'done',
      enabled: true,
      status: 'pending',
      scheduledAt: '2026-08-08T08:00:00.000Z',
    },
    {
      id: 'far-trigger',
      sessionId: 'done',
      enabled: true,
      status: 'pending',
      scheduledAt: '2026-08-20T08:00:00.000Z',
    },
    {
      id: 'disabled-trigger',
      sessionId: 'done',
      enabled: false,
      status: 'failed',
      scheduledAt: '2026-08-07T06:00:00.000Z',
    },
  ],
});

assert.equal(projection.counts.focus, 3, 'waiting, high priority, and failed trigger need attention');
assert.deepEqual(
  projection.focusItems.map((item) => item.id),
  ['session:waiting', 'trigger:failed-trigger', 'session:high'],
  'urgent work should sort before high-priority work, with newest urgent change first',
);
assert.deepEqual(projection.inProgress.map((item) => item.sessionId), ['running']);
assert.deepEqual(projection.recentResults.map((item) => item.sessionId), ['done']);
assert.deepEqual(projection.upcomingAutomation.map((item) => item.triggerId), ['upcoming-trigger']);
assert.equal(projection.focusItems.some((item) => item.sessionId === 'reviewed'), false);
assert.equal(projection.focusItems.some((item) => item.sessionId === 'archived'), false);
assert.equal(projection.focusItems.some((item) => item.sessionId === 'internal'), false);

console.log('test-home-projection: ok');
