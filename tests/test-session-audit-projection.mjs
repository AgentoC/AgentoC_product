#!/usr/bin/env node
import assert from 'assert/strict';
import { join } from 'path';

import { CHAT_HISTORY_DIR } from '../lib/config.mjs';
import { removePath } from '../chat/fs-utils.mjs';
import {
  buildProjectionModel,
  buildSessionAuditProjection,
  ensureSessionAuditProjection,
  getArtifactFileId,
  readSessionAuditProjection,
  updateSessionAuditProjectionForEvents,
} from '../chat/session-audit-projection.mjs';

const sessionId = 'session-projection-test';

const events = [
  {
    seq: 1,
    id: 'evt-user-1',
    type: 'message',
    role: 'user',
    content: 'please inspect this',
  },
  {
    seq: 2,
    id: 'evt-assistant-1',
    type: 'message',
    role: 'assistant',
    runId: 'run-1',
    content: 'large assistant body must not be copied into projection',
    attachments: [
      {
        assetId: 'fasset_projection_markdown_001',
        originalName: 'audit-notes.md',
        mimeType: 'text/plain; charset=utf-8',
        sizeBytes: 512,
      },
      {
        filename: 'legacy-report.pdf',
        originalName: 'legacy-report.pdf',
        mimeType: 'application/pdf',
      },
    ],
  },
  {
    seq: 3,
    id: 'evt-edit-1',
    type: 'tool_use',
    toolName: 'Edit',
    runId: 'run-1',
    toolInput: JSON.stringify({
      file_path: 'static/chat/run-sheet.js',
      old_string: 'old line',
      new_string: 'new line',
    }),
  },
  {
    seq: 4,
    id: 'evt-file-change',
    type: 'file_change',
    filePath: 'chat/session-audit-projection.mjs',
    changeType: 'add',
    added: 12,
    removed: 0,
  },
  {
    seq: 5,
    id: 'evt-progress-plan',
    type: 'plan',
    planId: 'progress-plan-1',
    title: 'Execution progress',
    runId: 'run-1',
    interactionMode: 'agent',
    planIntent: 'progress',
    items: [
      { text: 'Inspect', status: 'completed' },
      { step: 'Patch projection', status: 'in_progress' },
    ],
  },
  {
    seq: 6,
    id: 'evt-proposal-plan',
    type: 'plan',
    planId: 'proposal-plan-1',
    title: 'Formal plan',
    interactionMode: 'plan',
    planIntent: 'proposal',
    items: [
      { title: 'Confirm', status: 'pending' },
    ],
  },
];

const projection = buildSessionAuditProjection(sessionId, events);
assert.equal(projection.schemaVersion, 2);
assert.equal(projection.sessionId, sessionId);
assert.equal(projection.sourceLatestSeq, 6);
assert.deepEqual(
  Object.keys(projection).sort(),
  ['artifactFiles', 'changedFiles', 'coveredFromSeq', 'progressPlans', 'projectionStale', 'schemaVersion', 'sessionId', 'sourceLatestSeq', 'updatedAt'].sort(),
  'the durable projection should only contain Run Sheet fields',
);

assert.equal(projection.artifactFiles.length, 2, 'message attachments should become lightweight artifact records');
assert.equal(projection.artifactFiles[0].id, 'artifact_asset_fasset_projection_markdown_001');
assert.equal(
  getArtifactFileId(sessionId, events[1], events[1].attachments[0], 0),
  projection.artifactFiles[0].id,
  'artifactFileId should be stable for message cards and projection records',
);
assert.equal(projection.artifactFiles[0].isMarkdown, true, 'md extension should be recognized even with text/plain mime');
assert.equal(projection.artifactFiles[0].url, '/api/assets/fasset_projection_markdown_001/download');
assert.equal(projection.artifactFiles[0].downloadUrl, '/api/assets/fasset_projection_markdown_001/download?download=1');
assert.equal(projection.artifactFiles[1].isPdf, true, 'pdf artifact should be marked readable');
assert.equal(projection.artifactFiles[1].url, '/api/images/legacy-report.pdf');
assert.equal(projection.artifactFiles[1].downloadUrl, '/api/images/legacy-report.pdf?download=1');

assert.equal(projection.changedFiles.length, 2, 'tool edits and file_change events should populate changedFiles');
assert.ok(
  projection.changedFiles.some((file) => file.filePath === 'static/chat/run-sheet.js' && file.added === 1 && file.removed === 1),
  'tool edit parser should produce line stats',
);
assert.ok(
  projection.changedFiles.some((file) => file.filePath === 'chat/session-audit-projection.mjs' && file.added === 12),
  'file_change events should preserve supplied stats',
);

assert.equal(projection.progressPlans.length, 1, 'only progress intent plans should enter progressPlans');
assert.equal(projection.progressPlans[0].sourceRunId, 'run-1');
assert.equal(projection.progressPlans[0].items[1].text, 'Patch projection', 'plan items should use text/title/step');

const serialized = JSON.stringify(projection);
assert.doesNotMatch(serialized, /large assistant body/, 'projection must not copy message bodies');
assert.doesNotMatch(serialized, /old_string|new_string|toolInput/, 'projection must not copy raw tool input');

const model = buildProjectionModel(projection, { session: { id: sessionId, title: 'Projection test' } });
assert.equal(model.session.id, sessionId);
assert.equal(model.files.length, projection.changedFiles.length);
assert.equal(model.artifactFiles[0].id, projection.artifactFiles[0].id);
assert.equal(model.progressPlans.length, 1);
assert.deepEqual(model.tools, []);
assert.deepEqual(model.activity, []);

const missing = await ensureSessionAuditProjection('session-projection-test-missing', { latestSeq: 9 });
assert.equal(missing.projectionStale, true, 'missing historical projections should be reported stale');
assert.equal(missing.sourceLatestSeq, 9, 'missing historical projections should expose the known source seq');
assert.equal(missing.artifactFiles.length, 0, 'missing projections should not be rebuilt by scanning raw events implicitly');

const streamedSessionId = `session-projection-stream-${process.pid}`;
await removePath(join(CHAT_HISTORY_DIR, streamedSessionId));
try {
  async function* eventStream() {
    for (const event of events) yield event;
  }
  const streamed = await ensureSessionAuditProjection(streamedSessionId, {
    latestSeq: events.at(-1).seq,
    loadEvents: () => eventStream(),
  });
  assert.equal(streamed.sourceLatestSeq, 6, 'async event streams should rebuild the audit projection');
  assert.equal(streamed.changedFiles.length, 2, 'streamed rebuild should preserve derived file facts');
  assert.equal(streamed.progressPlans.length, 1, 'streamed rebuild should preserve bounded plans');
} finally {
  await removePath(join(CHAT_HISTORY_DIR, streamedSessionId));
}

const incrementalSessionId = `session-projection-incremental-${process.pid}`;
await removePath(join(CHAT_HISTORY_DIR, incrementalSessionId));
try {
  await updateSessionAuditProjectionForEvents(incrementalSessionId, [
    {
      seq: 1,
      type: 'tool_use',
      toolName: 'Edit',
      toolInput: JSON.stringify({
        file_path: 'static/chat/run-sheet.js',
        old_string: 'one',
        new_string: 'two',
      }),
    },
  ], { latestSeq: 1 });
  await updateSessionAuditProjectionForEvents(incrementalSessionId, [
    {
      seq: 2,
      type: 'tool_use',
      toolName: 'Edit',
      toolInput: JSON.stringify({
        file_path: 'static/chat/run-sheet.js',
        old_string: 'three',
        new_string: 'four',
      }),
    },
  ], { latestSeq: 2 });
  const incremental = await readSessionAuditProjection(incrementalSessionId);
  assert.equal(incremental.changedFiles.length, 1, 'incremental updates should merge the same changed file');
  assert.equal(incremental.changedFiles[0].added, 2, 'incremental changed-file additions should accumulate');
  assert.equal(incremental.changedFiles[0].removed, 2, 'incremental changed-file removals should accumulate');
  assert.equal(incremental.sourceLatestSeq, 2);
} finally {
  await removePath(join(CHAT_HISTORY_DIR, incrementalSessionId));
}

console.log('test-session-audit-projection: ok');
