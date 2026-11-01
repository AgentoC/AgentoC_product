#!/usr/bin/env node
import assert from 'node:assert/strict';

import { bridgeHarnessEvents } from '../chat/harness-event-bridge.mjs';

const bridged = bridgeHarnessEvents([
  { type: 'run.started', id: 'h1' },
  { type: 'assistant.delta', id: 'h2', data: { delta: 'hello' } },
  { type: 'tool.completed', data: { name: 'shell', output: 'ok', exitCode: 0 } },
  { type: 'run.completed', data: { message: 'done' } },
], { provider: 'pi', runtimeFamily: 'pi-rpc-jsonl' });

assert.deepEqual(bridged.map((event) => event.type), ['status', 'text_delta', 'tool_result', 'status']);
assert.equal(bridged[0].source, 'external-harness');
assert.equal(bridged[1].text, 'hello');
assert.equal(bridged[2].toolName, 'shell');
assert.equal(bridged[3].runState, 'completed');

const approval = bridgeHarnessEvents([{
  type: 'tool.approval_required',
  data: { approvalId: 'approval-1', toolName: 'shell', command: 'echo safe', reason: 'needs approval' },
}], { provider: 'pi', runtimeFamily: 'pi-rpc-jsonl' });
assert.equal(approval.length, 1);
assert.equal(approval[0].type, 'approval_request');
assert.equal(approval[0].approvalId, 'approval-1');
assert.equal(approval[0].command, 'echo safe');

assert.deepEqual(bridgeHarnessEvents([{ type: 'unknown.event' }]), []);
console.log('harness event bridge tests passed');
