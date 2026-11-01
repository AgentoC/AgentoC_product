#!/usr/bin/env node
import assert from 'assert/strict';
import { parseSessionGetRoute } from '../chat/session-route-utils.mjs';

assert.deepEqual(
  parseSessionGetRoute('/api/sessions'),
  { kind: 'list' },
  'session collection route should stay distinct',
);

assert.equal(
  parseSessionGetRoute('/api/sessions/archived'),
  null,
  'the retired archive collection route should not resolve as a session detail route',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123'),
  { kind: 'detail', sessionId: 'session-123' },
  'session detail routes should still parse normally',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/events'),
  { kind: 'events', sessionId: 'session-123' },
  'session event routes should still parse normally',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/snapshot'),
  { kind: 'snapshot', sessionId: 'session-123' },
  'combined session snapshot routes should parse separately from detail routes',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/events/wait'),
  { kind: 'event-wait', sessionId: 'session-123' },
  'session event wait routes should parse separately from ordinary event pages',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/projection'),
  { kind: 'projection', sessionId: 'session-123', projectionView: 'projection' },
  'session projection routes should expose a lightweight audit/run-sheet projection',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/run-sheet'),
  { kind: 'projection', sessionId: 'session-123', projectionView: 'run-sheet' },
  'run-sheet aliases should resolve to the projection route',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/events/delta'),
  { kind: 'event-delta', sessionId: 'session-123' },
  'session event delta routes should parse normally',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/events/blocks/10-20'),
  { kind: 'event-block', sessionId: 'session-123', startSeq: 10, endSeq: 20 },
  'collapsed event-block routes should parse normally',
);

assert.equal(
  parseSessionGetRoute('/api/sessions/session-123/unarchive'),
  null,
  'non-GET action routes should not be parsed as GET session routes',
);

console.log('test-session-route-utils: ok');
