#!/usr/bin/env node
import assert from 'assert/strict';
import {
  classifyOrchestrationOutput,
  ORCHESTRATION_MARKER_REJECTED,
  ORCHESTRATION_MODE_CONFLICT,
} from '../chat/orchestration-ingress.mjs';
import {
  COLLABORATION_PLAN_END,
  COLLABORATION_PLAN_START,
  ORGANIZATION_PROPOSAL_END,
  ORGANIZATION_PROPOSAL_START,
} from '../chat/orchestration-markers.mjs';

const organization = `${ORGANIZATION_PROPOSAL_START}{"objective":"one"}${ORGANIZATION_PROPOSAL_END}`;
const collaboration = `${COLLABORATION_PLAN_START}{"idempotencyKey":"one"}${COLLABORATION_PLAN_END}`;

assert.deepEqual(classifyOrchestrationOutput('plain answer'), { mode: 'none' });
assert.deepEqual(classifyOrchestrationOutput(organization), { mode: 'organization' });
assert.deepEqual(classifyOrchestrationOutput(collaboration), { mode: 'collaboration' });

const conflict = classifyOrchestrationOutput(`${organization}\n${collaboration}`);
assert.equal(conflict.mode, 'conflict');
assert.equal(conflict.error.code, ORCHESTRATION_MODE_CONFLICT);
assert.equal(conflict.error.reason, 'multiple_modes');

const duplicate = classifyOrchestrationOutput(`${organization}\n${organization}`);
assert.equal(duplicate.mode, 'invalid');
assert.equal(duplicate.error.code, ORCHESTRATION_MARKER_REJECTED);
assert.equal(duplicate.error.reason, 'multiple_blocks');

const missingEnd = classifyOrchestrationOutput(ORGANIZATION_PROPOSAL_START + '{"objective":"one"}');
assert.equal(missingEnd.mode, 'invalid');
assert.equal(missingEnd.error.reason, 'missing_end_marker');

const extraEnd = classifyOrchestrationOutput(`${organization}${ORGANIZATION_PROPOSAL_END}`);
assert.equal(extraEnd.mode, 'invalid');
assert.equal(extraEnd.error.reason, 'multiple_end_markers');

const empty = classifyOrchestrationOutput(`${COLLABORATION_PLAN_START}   ${COLLABORATION_PLAN_END}`);
assert.equal(empty.mode, 'invalid');
assert.equal(empty.error.reason, 'empty_payload');

console.log('test-orchestration-ingress: ok');
