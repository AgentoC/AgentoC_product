#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const composerStoreSource = readFileSync(join(repoRoot, 'static', 'chat', 'composer-store.js'), 'utf8');
const sidebarUiSource = readFileSync(join(repoRoot, 'static', 'chat', 'sidebar-ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in sidebar-ui.js`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const createComposerAttachmentLocalIdSource = extractFunctionSource(sidebarUiSource, 'createComposerAttachmentLocalId');
const buildPendingAttachmentSource = extractFunctionSource(sidebarUiSource, 'buildPendingAttachment');
const addAttachmentFilesSource = extractFunctionSource(sidebarUiSource, 'addAttachmentFiles');
const toComposerDragListSource = extractFunctionSource(sidebarUiSource, 'toComposerDragList');
const hasDataTransferAttachmentFilesSource = extractFunctionSource(sidebarUiSource, 'hasDataTransferAttachmentFiles');
const getDataTransferAttachmentFilesSource = extractFunctionSource(sidebarUiSource, 'getDataTransferAttachmentFiles');
const canAcceptComposerFileDropSource = extractFunctionSource(sidebarUiSource, 'canAcceptComposerFileDrop');

function createHarness({ locked = false, directUpload = false } = {}) {
  const state = {
    objectUrls: [],
    renderCalls: 0,
    eagerUploadCalls: [],
  };
  const context = {
    console,
    currentSessionId: 'session-a',
    crypto: {
      randomUUID() {
        return `uuid-${state.objectUrls.length + 1}`;
      },
    },
    URL: {
      createObjectURL(file) {
        const objectUrl = `blob:${file.name}`;
        state.objectUrls.push(objectUrl);
        return objectUrl;
      },
    },
    renderImagePreviews() {
      state.renderCalls += 1;
    },
    hasPendingComposerSend() {
      return locked;
    },
    shouldUseDirectComposerAssetUploads() {
      return directUpload;
    },
    async ensureComposerAttachmentUploads(sessionId, options = {}) {
      state.eagerUploadCalls.push({ sessionId, ...options });
      return [];
    },
    inputArea: {
      hidden: false,
    },
    msgInput: {
      disabled: false,
      readOnly: false,
    },
    imgBtn: {
      disabled: false,
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    [
      composerStoreSource,
      createComposerAttachmentLocalIdSource,
      buildPendingAttachmentSource,
      addAttachmentFilesSource,
      toComposerDragListSource,
      hasDataTransferAttachmentFilesSource,
      getDataTransferAttachmentFilesSource,
      canAcceptComposerFileDropSource,
      'globalThis.addAttachmentFiles = addAttachmentFiles;',
      'globalThis.hasDataTransferAttachmentFiles = hasDataTransferAttachmentFiles;',
      'globalThis.getDataTransferAttachmentFiles = getDataTransferAttachmentFiles;',
      'globalThis.canAcceptComposerFileDrop = canAcceptComposerFileDrop;',
    ].join('\n\n'),
    context,
    { filename: 'static/chat/sidebar-ui.js' },
  );
  return { context, state };
}

const firstBatch = Array.from({ length: 3 }, (_, index) => ({
  name: `shot-${index + 1}.png`,
  type: 'image/png',
  size: 1024 + index,
}));
const secondBatch = Array.from({ length: 3 }, (_, index) => ({
  name: `shot-${index + 4}.png`,
  type: 'image/png',
  size: 2048 + index,
}));

const openHarness = createHarness();
await openHarness.context.addAttachmentFiles(firstBatch);
await openHarness.context.addAttachmentFiles(secondBatch);
assert.equal(openHarness.context.getComposerAttachmentsState('session-a').length, 6, 'attachment picker should preserve every selected file instead of truncating at four');
assert.deepEqual(
  Array.from(openHarness.context.getComposerAttachmentsState('session-a'), (image) => image.originalName),
  [...firstBatch, ...secondBatch].map((file) => file.name),
  'attachment picker should append each batch in order',
);
assert.equal(openHarness.state.objectUrls.length, 6, 'attachment picker should create a preview URL for every selected file');
assert.equal(openHarness.state.renderCalls, 2, 'attachment picker should rerender after each batch');
assert.equal(openHarness.state.eagerUploadCalls.length, 0, 'non-direct uploads should not start the eager upload queue');

const lockedHarness = createHarness({ locked: true });
await lockedHarness.context.addAttachmentFiles([...firstBatch, ...secondBatch]);
assert.equal(lockedHarness.context.getComposerAttachmentsState('session-a').length, 0, 'attachment picker should ignore new files while a send is already pending');
assert.equal(lockedHarness.state.objectUrls.length, 0, 'locked composer should not allocate preview URLs');
assert.equal(lockedHarness.state.renderCalls, 0, 'locked composer should not rerender the preview strip');

const directUploadHarness = createHarness({ directUpload: true });
await directUploadHarness.context.addAttachmentFiles([{ name: 'video.mov', type: 'video/quicktime', size: 42 }]);
assert.equal(directUploadHarness.context.getComposerAttachmentsState('session-a')[0]?.uploadState, 'queued', 'direct-upload attachments should enter the queued state immediately');
assert.equal(directUploadHarness.state.eagerUploadCalls.length, 1, 'direct-upload mode should start the background upload immediately');
assert.equal(directUploadHarness.state.eagerUploadCalls[0]?.localIds?.length, 1, 'background upload kickoff should target the queued attachment local id');

const dragHarness = createHarness();
const droppedFile = { name: 'report.pdf', type: 'application/pdf', size: 4096 };
const itemFile = { name: 'notes.txt', type: 'text/plain', size: 128 };
assert.equal(
  dragHarness.context.hasDataTransferAttachmentFiles({ types: ['Files'] }),
  true,
  'composer drop target should recognize browser file drags by DataTransfer types',
);
assert.equal(
  dragHarness.context.hasDataTransferAttachmentFiles({ items: [{ kind: 'file' }] }),
  true,
  'composer drop target should recognize file drags by DataTransfer items',
);
assert.equal(
  dragHarness.context.hasDataTransferAttachmentFiles({ types: ['text/plain'], items: [{ kind: 'string' }] }),
  false,
  'composer drop target should ignore non-file drags',
);
assert.deepEqual(
  Array.from(dragHarness.context.getDataTransferAttachmentFiles({ files: [droppedFile] }), (file) => file.name),
  [droppedFile.name],
  'composer drop target should prefer dropped FileList entries',
);
assert.deepEqual(
  Array.from(dragHarness.context.getDataTransferAttachmentFiles({
    files: [],
    items: [{ kind: 'file', getAsFile: () => itemFile }],
  }), (file) => file.name),
  [itemFile.name],
  'composer drop target should fall back to file DataTransferItem entries',
);
assert.equal(dragHarness.context.canAcceptComposerFileDrop(), true, 'composer should accept dropped files when editable');

const noSessionDragHarness = createHarness();
noSessionDragHarness.context.currentSessionId = '';
assert.equal(noSessionDragHarness.context.canAcceptComposerFileDrop(), false, 'composer should reject dropped files without an active session');

const disabledDragHarness = createHarness();
disabledDragHarness.context.msgInput.disabled = true;
assert.equal(disabledDragHarness.context.canAcceptComposerFileDrop(), false, 'composer should reject dropped files while the input is disabled');

const lockedDragHarness = createHarness({ locked: true });
assert.equal(lockedDragHarness.context.canAcceptComposerFileDrop(), false, 'composer should reject dropped files while a send is pending');

console.log('test-chat-sidebar-attachments: ok');
