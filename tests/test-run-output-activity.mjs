#!/usr/bin/env node
import assert from 'node:assert/strict';

import { classifyRunOutputActivity } from '../chat/session-activity.mjs';

const nowMs = Date.parse('2026-09-09T02:00:00.000Z');
const isoAgo = (milliseconds) => new Date(nowMs - milliseconds).toISOString();
const base = {
  state: 'running',
  runnerStartedAt: isoAgo(60_000),
  runnerHeartbeatAt: isoAgo(1000),
};

assert.equal(classifyRunOutputActivity({
  ...base,
  providerLastByteAt: isoAgo(1000),
  providerLastSemanticEventAt: isoAgo(1000),
  providerLastReasoningAt: isoAgo(1000),
  lastVisibleActivityAt: isoAgo(900),
}, { nowMs }), 'active_reasoning');

assert.equal(classifyRunOutputActivity({
  ...base,
  providerLastByteAt: isoAgo(1000),
  providerLastSemanticEventAt: isoAgo(20_000),
  lastVisibleActivityAt: isoAgo(20_000),
}, { nowMs }), 'projection_stalled');

assert.equal(classifyRunOutputActivity({
  ...base,
  providerLastByteAt: isoAgo(10_000),
  providerLastSemanticEventAt: isoAgo(10_000),
  lastVisibleActivityAt: isoAgo(20_000),
}, { nowMs }), 'visible_activity_starved');

assert.equal(classifyRunOutputActivity({
  ...base,
  providerLastByteAt: isoAgo(45_000),
  providerLastSemanticEventAt: isoAgo(45_000),
  providerLastReasoningAt: isoAgo(45_000),
  lastVisibleActivityAt: isoAgo(45_000),
}, { nowMs }), 'upstream_silent');

assert.equal(classifyRunOutputActivity({
  ...base,
  runnerStartedAt: isoAgo(1000),
}, { nowMs }), 'awaiting_provider_output');

assert.equal(classifyRunOutputActivity({ state: 'completed' }, { nowMs }), 'idle');

console.log('test-run-output-activity: ok');
