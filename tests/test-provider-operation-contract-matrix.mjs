#!/usr/bin/env node
import assert from 'node:assert/strict';

import { createAgyStreamAdapter } from '../chat/adapters/agy.mjs';
import { createAcpEventParser } from '../chat/adapters/acp-stdio.mjs';
import { createDeepSeekHarnessAdapter } from '../chat/adapters/deepseek-harness.mjs';
import { createGooseAdapter } from '../chat/adapters/goose.mjs';
import { bridgeOpenHandsServiceEvent } from '../chat/adapters/openhands-service.mjs';
import { createPiAdapter } from '../chat/adapters/pi.mjs';
import { bridgeHarnessEvent } from '../chat/harness-event-bridge.mjs';
import { buildOperationProjection } from '../chat/operation-projection.mjs';
import { getProviderCapabilities } from '../chat/provider-contract.mjs';
import { classifyProviderOperation } from '../chat/provider-operation-classifier.mjs';

function withSeq(events) {
  return events.filter(Boolean).map((event, index) => ({ ...event, seq: index + 1 }));
}

function project(events) {
  return buildOperationProjection(withSeq(events));
}

// Real AgY tool dialects must resolve to user-visible actions instead of
// falling back to a bare provider tool name.
const agyTools = [
  ['view_file', { AbsolutePath: '/repo/chat/session-manager.mjs' }, 'read', 'read', 'session-manager.mjs'],
  ['grep_search', { Query: 'providerToolUseId', SearchPath: '/repo/chat' }, 'search', 'search', 'providerToolUseId'],
  ['find_by_name', { Pattern: '*.mjs', SearchDirectory: '/repo/chat' }, 'search', 'search', '*.mjs'],
  ['replace_file_content', { TargetFile: '/repo/chat/acp.mjs' }, 'file_edit', 'edit', 'acp.mjs'],
  ['manage_task', { Action: 'update', TaskId: 'task-3' }, 'subagent', 'task_update', 'task-3'],
  ['browser_click_element', { Selector: '#submit' }, 'web', 'click', '#submit'],
  ['send_message', { Recipient: 'adapter-audit', Message: 'verify it' }, 'subagent', 'message', 'adapter-audit'],
];
for (const [toolName, toolInput, kind, semanticKind, subject] of agyTools) {
  const classified = classifyProviderOperation({ provider: 'antigravity', toolName, toolInput });
  assert.equal(classified.kind, kind, `${toolName} kind`);
  assert.equal(classified.action?.semanticKind, semanticKind, `${toolName} semantic kind`);
  assert.match(classified.action?.subject || '', new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
const taskPresentation = project([{
  type: 'tool_use', toolName: 'TaskCreate', toolInput: { description: 'verify adapters' },
  providerToolUseId: 'task-create-1', operationLifecycle: 'started',
}]).operations[0].presentation;
assert.equal(taskPresentation.labelKind, 'task_create');
assert.equal(taskPresentation.subject, 'verify adapters');

const agy = createAgyStreamAdapter();
const agyStart = agy.parseLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 4,
    step_type: 'tool',
    state: 'ACTIVE',
    tool_name: 'replace_file_content',
    tool_info: { parameters: { TargetFile: '/repo/chat/acp.mjs' } },
  },
}));
const agyEnd = agy.parseLine(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_index: 4,
    step_type: 'tool',
    state: 'DONE',
    tool_name: 'replace_file_content',
    tool_info: { output: 'updated' },
  },
}));
const agyProjection = project([...agyStart, ...agyEnd]);
assert.equal(agyProjection.operations.length, 1);
assert.equal(agyProjection.operations[0].state, 'completed');
assert.equal(agyProjection.operations[0].presentation.labelKind, 'edit');
assert.equal(agyProjection.operations[0].fileChanges[0].filePath, '/repo/chat/acp.mjs');

// ACP in-progress updates are deltas, never terminal results. Names omitted by
// later updates inherit from the initial call through the stable call id.
const acp = createAcpEventParser({ provider: 'hermes', runtimeFamily: 'hermes-acp' });
const acpEvents = [
  ...acp.parseLine(JSON.stringify({ method: 'session/update', params: { update: {
    sessionUpdate: 'tool_call', toolCallId: 'acp-1', title: 'shell', rawInput: { command: 'echo ok' },
  } } })),
  ...acp.parseLine(JSON.stringify({ method: 'session/update', params: { update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', status: 'in_progress', rawOutput: { content: 'partial' },
  } } })),
];
let acpProjection = project(acpEvents);
assert.equal(acpEvents[1].operationLifecycle, 'delta');
assert.equal(acpEvents[1].toolName, 'shell');
assert.equal(acpProjection.operations.length, 1);
assert.equal(acpProjection.operations[0].state, 'running');
assert.deepEqual(acpProjection.operations[0].outputPreview.head, ['partial']);
const acpCompleted = acp.parseLine(JSON.stringify({ method: 'session/update', params: { update: {
  sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', status: 'completed', rawOutput: { content: 'done' },
} } }));
acpProjection = project([...acpEvents, ...acpCompleted]);
assert.equal(acpProjection.operations.length, 1);
assert.equal(acpProjection.operations[0].state, 'completed');
assert.deepEqual(acpProjection.operations[0].outputPreview.head, ['done']);

// Pi must retain exact ids even when two same-name calls complete out of order.
const pi = createPiAdapter();
const piEvents = [
  ...pi.parseLine(JSON.stringify({ type: 'tool_execution_start', id: 'p1-start', toolCallId: 'p1', toolName: 'bash', args: { command: 'echo one' } })),
  ...pi.parseLine(JSON.stringify({ type: 'tool_execution_start', id: 'p2-start', toolCallId: 'p2', toolName: 'bash', args: { command: 'echo two' } })),
  ...pi.parseLine(JSON.stringify({ type: 'tool_execution_end', id: 'p2-end', toolCallId: 'p2', toolName: 'bash', result: { content: 'two' } })),
  ...pi.parseLine(JSON.stringify({ type: 'tool_execution_end', id: 'p1-end', toolCallId: 'p1', toolName: 'bash', result: { content: 'one' } })),
];
assert.deepEqual(piEvents.filter((event) => event.type === 'tool_use').map((event) => event.providerToolUseId), ['p1', 'p2']);
const piProjection = project(piEvents);
assert.equal(piProjection.operations.length, 2);
assert.equal(piProjection.operations.every((operation) => operation.state === 'completed'), true);
assert.equal(piProjection.diagnostics.some((item) => item.code === 'orphan_operation'), false);

// OpenHands ActionEvent and ObservationEvent are one operation, not a running
// start plus an orphan result. Object observations must remain visible.
const openHandsHarnessEvents = [
  ...bridgeOpenHandsServiceEvent({
    kind: 'ActionEvent', id: 'oh-a', tool_call_id: 'oh-1', tool_name: 'execute_bash',
    action: { kind: 'ExecuteBashAction', command: 'echo ok' },
  }),
  ...bridgeOpenHandsServiceEvent({
    kind: 'ObservationEvent', id: 'oh-b', action_id: 'oh-1',
    observation: { kind: 'CmdOutputObservation', content: 'ok' },
  }),
];
const openHandsEvents = openHandsHarnessEvents.map((event) => bridgeHarnessEvent(event, {
  provider: 'openhands', runtimeFamily: 'openhands-agent-server',
}));
const openHandsProjection = project(openHandsEvents);
assert.equal(openHandsEvents[0].providerToolUseId, 'oh-1');
assert.equal(openHandsEvents[1].providerToolUseId, 'oh-1');
assert.equal(openHandsProjection.operations.length, 1);
assert.equal(openHandsProjection.operations[0].kind, 'command');
assert.equal(openHandsProjection.operations[0].state, 'completed');
assert.deepEqual(openHandsProjection.operations[0].outputPreview.head, ['ok']);
assert.deepEqual(openHandsProjection.quality, {
  totalOperations: 1,
  classifiedOperations: 1,
  unclassifiedOperations: 0,
  missingSubjectOperations: 0,
  orphanOperations: 0,
  missingTerminalOperations: 0,
  lifecycleRegressions: 0,
  classificationRate: 1,
});

const openHandsToolCalls = new Map();
const openHandsEditHarnessEvents = [
  ...bridgeOpenHandsServiceEvent({
    kind: 'ActionEvent', id: 'oh-edit-a', tool_call_id: 'oh-edit-1', tool_name: 'FileEditAction',
    action: { kind: 'FileEditAction', path: '/repo/chat/bridge.mjs' },
  }, { toolCalls: openHandsToolCalls }),
  ...bridgeOpenHandsServiceEvent({
    kind: 'ObservationEvent', id: 'oh-edit-b', action_id: 'oh-edit-1',
    observation: { kind: 'FileEditObservation', content: 'updated' },
  }, { toolCalls: openHandsToolCalls }),
];
const openHandsEditProjection = project(openHandsEditHarnessEvents.map((event) => bridgeHarnessEvent(event, {
  provider: 'openhands', runtimeFamily: 'openhands-agent-server',
})));
assert.equal(openHandsEditProjection.operations.length, 1);
assert.equal(openHandsEditProjection.operations[0].kind, 'file_edit');
assert.equal(openHandsEditProjection.operations[0].fileChanges[0].filePath, '/repo/chat/bridge.mjs');

// Goose 1.47 stream-json messages contain nested MessageContent blocks. Raw
// JSON and unknown frames must never become assistant messages.
const goose = createGooseAdapter();
const gooseEvents = [
  ...goose.parseLine(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [
    { type: 'text', text: 'I will inspect this.' },
    { type: 'toolRequest', id: 'goose-1', toolCall: { status: 'success', value: {
      name: 'developer__shell', arguments: { command: 'echo ok' },
    } } },
  ] } })),
  ...goose.parseLine(JSON.stringify({ type: 'message', message: { role: 'user', content: [
    { type: 'toolResponse', id: 'goose-1', toolResult: { status: 'success', value: {
      content: [{ type: 'text', text: 'ok' }],
    } } },
  ] } })),
  ...goose.parseLine(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [
    { type: 'text', text: 'Finished.' },
  ] } })),
  ...goose.parseLine(JSON.stringify({ type: 'complete', input_tokens: 10, output_tokens: 4, total_tokens: 14 })),
];
assert.equal(goose.parseLine('{"type":"future_event","secret":"not assistant text"}').length, 0);
assert.equal(goose.parseLine('not-json diagnostic').length, 0);
assert.equal(gooseEvents.find((event) => event.type === 'message')?.content, 'Finished.');
const gooseProjection = project(gooseEvents);
assert.equal(gooseProjection.operations.length, 1);
assert.equal(gooseProjection.operations[0].kind, 'command');
assert.equal(gooseProjection.operations[0].state, 'completed');
assert.deepEqual(gooseProjection.operations[0].outputPreview.head, ['ok']);

// Unknown JSON emitted by a mixed DeepSeek ACP/headless runtime is diagnostic
// protocol material, not assistant content.
const deepSeek = createDeepSeekHarnessAdapter();
assert.equal(deepSeek.parseLine('{"type":"diagnostic","message":"internal"}').length, 0);
assert.equal(deepSeek.parseLine('final answer')[0].content, 'final answer');

for (const family of ['hermes-acp', 'deepseek-harness-acp', 'qwen-code-acp', 'kimi-code-acp', 'pi-rpc-jsonl', 'goose-headless']) {
  assert.equal(getProviderCapabilities(family).supportsToolEvents, true, `${family} capability`);
}

console.log('Provider operation contract matrix tests passed');
