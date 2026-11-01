#!/usr/bin/env node
import assert from 'assert/strict';
import {
  createClaudeFinalizedAssistantReplayFingerprint,
  filterDuplicateProviderEvents,
  getProviderEventDedupKey,
} from '../chat/provider-event-dedup.mjs';

const storedMessage = {
  type: 'message',
  role: 'assistant',
  runId: 'run-1',
  providerMessageId: 'msg-1',
  content: 'Done.',
};
const duplicateMessage = { ...storedMessage, id: 'different-normalized-id', timestamp: 2 };
const changedMessage = { ...storedMessage, content: 'A later block.' };
const storedTool = {
  type: 'tool_use',
  role: 'assistant',
  runId: 'run-1',
  providerToolUseId: 'tool-1',
  toolName: 'Bash',
  toolInput: '{"command":"pwd"}',
};
const duplicateFileChange = {
  type: 'file_change',
  runId: 'run-1',
  providerToolUseId: 'tool-edit',
  filePath: '/tmp/a.js',
  changeType: 'edit',
  added: 1,
  removed: 1,
};

assert.ok(getProviderEventDedupKey(storedMessage));
assert.deepEqual(
  filterDuplicateProviderEvents(
    [storedMessage, storedTool, duplicateFileChange],
    [duplicateMessage, changedMessage, { ...storedTool }, { ...duplicateFileChange }],
  ),
  [changedMessage],
  'terminal projection should drop exact provider duplicates while preserving distinct blocks',
);
assert.deepEqual(
  filterDuplicateProviderEvents([], [duplicateMessage, { ...duplicateMessage }]),
  [duplicateMessage],
  'duplicates inside one terminal batch should also collapse',
);
assert.equal(
  filterDuplicateProviderEvents([], [{ type: 'status', runId: 'run-1', content: 'completed' }]).length,
  1,
  'events without stable provider identity should remain untouched',
);

const spoolReplay = {
  type: 'message',
  role: 'assistant',
  runId: 'run-1',
  harnessEventId: 'spool:record-1:0',
  harnessEventSource: 'spool-record',
  content: 'Unidentified but replayable.',
};
assert.deepEqual(
  filterDuplicateProviderEvents([spoolReplay], [{ ...spoolReplay, id: 'new-normalized-id' }]),
  [],
  'the same persisted spool record must be dropped on a later projection even without a provider id',
);

const fallbackFingerprint = createClaudeFinalizedAssistantReplayFingerprint('claude-session-1', 'No upstream message id.');
const fallbackSnapshot = {
  type: 'message',
  role: 'assistant',
  runId: 'run-1',
  provider: 'claude',
  runtimeFamily: 'claude-stream-json',
  providerSessionId: 'claude-session-1',
  providerSnapshotKind: 'finalized-assistant',
  providerReplayFingerprint: fallbackFingerprint,
  content: 'No upstream message id.',
};
assert.ok(getProviderEventDedupKey(fallbackSnapshot));
assert.deepEqual(
  filterDuplicateProviderEvents([fallbackSnapshot], [{ ...fallbackSnapshot, harnessEventId: 'spool:record-2:0', harnessEventSource: 'spool-record' }]),
  [],
  'Claude final snapshots without message/frame ids use the restricted replay fingerprint before a derived spool identity',
);
assert.deepEqual(
  filterDuplicateProviderEvents([], [
    { ...fallbackSnapshot, providerMessageId: 'message-A', providerReplayFingerprint: undefined },
    { ...fallbackSnapshot, providerMessageId: 'message-B', providerReplayFingerprint: undefined },
  ]).map((event) => event.providerMessageId),
  ['message-A', 'message-B'],
  'equal text from distinct provider message ids remains distinct',
);

console.log('test-provider-event-dedup: ok');
