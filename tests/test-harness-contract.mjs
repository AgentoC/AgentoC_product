#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  HARNESS_ADAPTER_CONTRACT_VERSION,
  HARNESS_ADAPTER_SUPPORTED_VERSIONS,
  HARNESS_EVENT_TYPES,
  HARNESS_OPTIONAL_OPERATIONS,
  HARNESS_REQUIRED_OPERATIONS,
  HARNESS_TERMINAL_STATES,
  HARNESS_TRANSPORTS,
  validateHarnessAdapterDescriptor,
  validateHarnessEvent,
} from '../chat/harness-contract.mjs';

assert.equal(HARNESS_ADAPTER_CONTRACT_VERSION, '1.2');
assert.deepEqual(HARNESS_ADAPTER_SUPPORTED_VERSIONS, ['1.0', '1.1', '1.2']);
assert.deepEqual(HARNESS_TERMINAL_STATES, ['completed', 'failed', 'cancelled']);
assert.deepEqual(HARNESS_REQUIRED_OPERATIONS, ['start', 'sendTurn', 'cancel', 'terminate']);
assert.ok(HARNESS_OPTIONAL_OPERATIONS.includes('resume'));
assert.ok(HARNESS_TRANSPORTS.includes('acp'));
assert.ok(HARNESS_TRANSPORTS.includes('process-jsonl-bidi'));
assert.ok(HARNESS_EVENT_TYPES.includes('tool.approval_required'));

const valid = validateHarnessAdapterDescriptor({
  contractVersion: '1.0',
  id: 'pi-rpc-jsonl',
  provider: 'pi',
  transport: 'process-jsonl',
  operations: ['start', 'sendTurn', 'cancel', 'terminate', 'resume', 'steer', 'followUp'],
  capabilities: {
    supportsResume: true,
    supportsSteer: true,
    supportsInterrupt: true,
    supportsApproval: false,
  },
  events: [
    'run.started', 'assistant.message', 'assistant.delta', 'tool.started',
    'tool.completed', 'run.completed', 'run.failed', 'run.cancelled',
  ],
});
assert.equal(valid.valid, true);

assert.deepEqual(valid.errors, []);

const invalid = validateHarnessAdapterDescriptor({
  contractVersion: '0.9',
  id: 'unsafe-harness',
  provider: 'test',
  transport: 'process-jsonl',
  operations: ['start', 'sendTurn', 'cancel', 'terminate'],
  capabilities: {
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: true,
  },
  events: ['run.started', 'assistant.message', 'run.completed', 'run.failed', 'run.cancelled'],
});
assert.equal(invalid.valid, false);
assert.ok(invalid.errors.includes('contractVersion must be one of: 1.0, 1.1, 1.2'));
assert.ok(invalid.errors.includes('supportsResume requires resume operation'));
assert.ok(invalid.errors.includes('supportsApproval requires respondToApproval operation'));
assert.ok(invalid.errors.includes('supportsApproval requires tool.approval_required event'));

const missingToolCallId = validateHarnessEvent({
  type: 'tool.completed', eventId: 'event-1', seq: 1, runId: 'run-1', data: { output: 'ok' },
});
assert.equal(missingToolCallId.valid, false);
assert.ok(missingToolCallId.errors.includes('tool.completed requires toolCallId'));
assert.equal(validateHarnessEvent({
  type: 'tool.completed', eventId: 'event-2', seq: 2, runId: 'run-1',
  data: { toolCallId: 'call-1', output: 'ok' },
}).valid, true);

console.log('harness contract tests passed');
