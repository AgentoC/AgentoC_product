#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');
const sessionCatalogSource = readFileSync(join(repoRoot, 'static/chat/bootstrap-session-catalog.js'), 'utf8');

function sliceBetween(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  if (start === -1) {
    throw new Error(`Missing start token: ${startToken}`);
  }
  const end = source.indexOf(endToken, start);
  if (end === -1) {
    throw new Error(`Missing end token: ${endToken}`);
  }
  return source.slice(start, end);
}

function createSessionActivity({
  runState = 'idle',
  phase = null,
  runId = null,
  queueState = 'idle',
  queueCount = 0,
  renameState = 'idle',
  renameError = null,
  compactState = 'idle',
} = {}) {
  return {
    run: {
      state: runState,
      phase,
      runId,
      cancelRequested: false,
    },
    queue: {
      state: queueState,
      count: queueCount,
    },
    rename: {
      state: renameState,
      error: renameError,
    },
    compact: {
      state: compactState,
    },
  };
}

function createBaseContext() {
  const context = {
    console,
    Date,
    JSON,
    Set,
    Map,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Math,
    Promise,
    encodeURIComponent,
    structuredClone,
    currentSessionId: null,
    hasAttachedSession: false,
    archivedSessionCount: 0,
    sessions: [],
    visitorMode: false,
    getEffectiveSessionSourceId(session) {
      return session?.sourceId || 'chat';
    },
    normalizeSessionReviewStamp(value) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!trimmed) return '';
      const time = new Date(trimmed).getTime();
      return Number.isFinite(time) ? new Date(time).toISOString() : '';
    },
    getLocalSessionReviewedAt() {
      return '';
    },
    getSessionReviewBaselineAt() {
      return '';
    },
    clearTimeout() {},
    MESSAGE_SUBMIT_TIMEOUT_MS: 20_000,
    MESSAGE_SUBMIT_CONFIRMATION_RETRY_DELAY_MS: 350,
    MESSAGE_SUBMIT_CONFIRMATION_ATTEMPTS: 3,
  };
  context.globalThis = context;
  context.window = context;
  return context;
}

const normalizeSessionRecordSnippet = sliceBetween(
  sessionHttpSource,
  'function normalizeSessionRecord',
  'function upsertSession',
);

const applyAttachedSessionStateSnippet = sliceBetween(
  sessionHttpSource,
  'function applyAttachedSessionState',
  'async function fetchSessionState',
);

const sessionReviewSnippet = sliceBetween(
  sessionHttpSource,
  'const pendingSessionReviewSyncs = new Map();',
  'function normalizeSessionRecord',
);

const sessionCatalogVisibilitySnippet = sliceBetween(
  sessionCatalogSource,
  'function getArchivedSessionSortTime',
  'function getLatestSession',
);

const sessionRootVisibilitySnippet = sliceBetween(
  sessionCatalogSource,
  'function isRootSessionForPrimaryList',
  'function getSessionSourceCategory',
);

const dispatchActionSnippet = sliceBetween(
  realtimeSource,
  'async function dispatchAction',
  'function getCurrentSession',
);

const dispatchSupportSnippet = sliceBetween(
  realtimeSource,
  'function isAmbiguousMessageSubmitError',
  'function connect',
);

const attachActionSupportSnippet = sliceBetween(
  realtimeSource,
  'function isCurrentAttachAction',
  'async function dispatchAction',
);

function loadDispatchRuntime(context, filename = 'chat-dispatch-action-runtime.js') {
  vm.runInNewContext(
    `${dispatchSupportSnippet}\n${attachActionSupportSnippet}\n${dispatchActionSnippet}`,
    context,
    { filename },
  );
}

const recordContext = createBaseContext();
vm.runInNewContext(
  normalizeSessionRecordSnippet,
  recordContext,
  { filename: 'chat-session-record-runtime.js' },
);

const restored = recordContext.normalizeSessionRecord(
  {
    id: 'session-restore',
    activity: createSessionActivity(),
    lastEventAt: '2026-03-12T12:00:00.000Z',
  },
  {
    id: 'session-restore',
    activity: createSessionActivity(),
    archived: true,
    archivedAt: '2026-03-12T11:59:00.000Z',
  },
);
assert.equal(restored.archived, undefined, 'stale archived flags should not survive a fresh session payload');
assert.equal(restored.archivedAt, undefined, 'stale archived timestamps should not survive a fresh session payload');
assert.equal(restored.activity.run.state, 'idle', 'session activity should preserve the backend run state');

const carriedQueue = recordContext.normalizeSessionRecord(
  {
    id: 'session-queue',
    activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 1 }),
  },
  {
    id: 'session-queue',
    queuedMessages: [{ text: 'queued follow-up' }],
  },
);
assert.deepEqual(
  carriedQueue.queuedMessages,
  [{ text: 'queued follow-up' }],
  'queued message details should stay attached while the backend queue is still non-empty',
);

const clearedQueue = recordContext.normalizeSessionRecord(
  {
    id: 'session-queue',
    activity: createSessionActivity(),
  },
  {
    id: 'session-queue',
    queuedMessages: [{ text: 'queued follow-up' }],
  },
);
assert.equal(
  Object.prototype.hasOwnProperty.call(clearedQueue, 'queuedMessages'),
  false,
  'queued message details should clear once the backend queue drains',
);

const dispatchContext = createBaseContext();
let refreshCalls = 0;
let renderCalls = 0;
let savedPendingCalls = 0;
let clearedPendingCalls = 0;
let attentionRefreshes = 0;
let scheduledRefreshes = 0;
let appliedSession = null;
let requestPayload = null;
const acknowledgedRequestIds = [];
const finalizedRequestIds = [];

dispatchContext.currentSessionId = 'session-send';
dispatchContext.createRequestId = () => 'req-test';
dispatchContext.fetchSessionsList = async () => [];
dispatchContext.refreshCurrentSession = async () => {
  refreshCalls += 1;
  if (refreshCalls === 1) {
    throw new Error('temporary refresh failure');
  }
  return { ok: true };
};
dispatchContext.fetchJsonOrRedirect = async (url, options = {}) => {
  requestPayload = { url, options };
  return {
    queued: true,
    session: {
      id: 'session-send',
      activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 1 }),
    },
  };
};
dispatchContext.upsertSession = (value) => {
  dispatchContext.sessions = [value];
  return value;
};
dispatchContext.renderSessionList = () => {
  renderCalls += 1;
};
dispatchContext.applyAttachedSessionState = (id, session) => {
  appliedSession = { id, session };
};
dispatchContext.acknowledgeComposerPendingSend = (requestId) => {
  acknowledgedRequestIds.push(requestId);
  return true;
};
dispatchContext.finalizeComposerPendingSend = (requestId) => {
  finalizedRequestIds.push(requestId);
  return true;
};
dispatchContext.refreshSidebarSession = async () => null;
dispatchContext.savePendingMessage = () => {
  savedPendingCalls += 1;
};
dispatchContext.clearPendingMessage = () => {
  clearedPendingCalls += 1;
};
dispatchContext.refreshSessionAttentionUi = () => {
  attentionRefreshes += 1;
};
dispatchContext.setTimeout = (fn, delayMs) => {
  if (delayMs === 20_000) return 1;
  scheduledRefreshes += 1;
  fn();
  return 1;
};

loadDispatchRuntime(dispatchContext);

const sendAccepted = await dispatchContext.dispatchAction({ action: 'send', text: 'hello world' });
assert.equal(sendAccepted, true, 'send should resolve successfully after server acceptance');
assert.equal(requestPayload?.url, '/api/sessions/session-send/messages');
assert.match(String(requestPayload?.options?.body || ''), /"requestId":"req-test"/);
assert.equal(renderCalls, 1, 'accepted sends should immediately reflect the backend session payload');
assert.deepEqual(
  appliedSession,
  {
    id: 'session-send',
    session: {
      id: 'session-send',
      activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 1 }),
    },
  },
  'accepted sends should apply the returned backend session state before the refresh finishes',
);
assert.equal(refreshCalls, 2, 'accepted sends should retry the session refresh after a transient failure');
assert.equal(scheduledRefreshes, 1, 'accepted sends should schedule exactly one async refresh retry');
assert.deepEqual(acknowledgedRequestIds, ['req-test'], 'accepted sends should immediately acknowledge the pending composer request from the HTTP acknowledgment');
assert.deepEqual(finalizedRequestIds, [], 'HTTP acceptance alone should not fully finalize the processing acknowledgment');
assert.equal(savedPendingCalls, 0, 'frontend should not persist pending-send state');
assert.equal(clearedPendingCalls, 0, 'frontend should not clear any pending-send cache because none exists');
assert.equal(attentionRefreshes, 0, 'frontend should not synthesize unread or send-failure attention state');

const ambiguousSendContext = createBaseContext();
let ambiguousRefreshes = 0;
let ambiguousCommitted = false;
ambiguousSendContext.currentSessionId = 'session-ambiguous';
ambiguousSendContext.createRequestId = () => 'req-ambiguous';
ambiguousSendContext.fetchJsonOrRedirect = async () => {
  const error = new Error('Failed to fetch');
  error.name = 'TypeError';
  throw error;
};
ambiguousSendContext.refreshCurrentSession = async () => {
  ambiguousRefreshes += 1;
  ambiguousCommitted = true;
  return { id: 'session-ambiguous', activity: createSessionActivity({ runState: 'running' }) };
};
ambiguousSendContext.findCommittedUserMessageNode = () => ambiguousCommitted ? { requestId: 'req-ambiguous' } : null;
ambiguousSendContext.setTimeout = () => 1;
ambiguousSendContext.clearTimeout = () => {};
loadDispatchRuntime(ambiguousSendContext, 'chat-dispatch-action-ambiguous-runtime.js');
const ambiguousSendAccepted = await ambiguousSendContext.dispatchAction({
  action: 'send',
  requestId: 'req-ambiguous',
  text: 'the response was lost after acceptance',
});
assert.equal(ambiguousSendAccepted, true, 'a transport error after an accepted send should reconcile as success');
assert.equal(ambiguousRefreshes, 1, 'ambiguous sends should use one bounded confirmation refresh when the message is already committed');

const rejectedSendContext = createBaseContext();
let rejectedRefreshes = 0;
rejectedSendContext.currentSessionId = 'session-rejected';
rejectedSendContext.fetchJsonOrRedirect = async () => {
  const error = new Error('text is required');
  error.status = 400;
  throw error;
};
rejectedSendContext.setTimeout = () => 1;
rejectedSendContext.refreshCurrentSession = async () => {
  rejectedRefreshes += 1;
  return null;
};
loadDispatchRuntime(rejectedSendContext, 'chat-dispatch-action-rejected-runtime.js');
const rejectedSendAccepted = await rejectedSendContext.dispatchAction({
  action: 'send',
  requestId: 'req-rejected',
  text: 'invalid request',
});
assert.equal(rejectedSendAccepted, false, 'a definite client error should remain a send failure');
assert.equal(rejectedRefreshes, 0, 'definite client errors should not trigger ambiguous-send reconciliation');

const detachedSendContext = createBaseContext();
let detachedCurrentRefreshes = 0;
let detachedSidebarRefreshes = 0;
let detachedRequestPayload = null;

detachedSendContext.currentSessionId = 'session-viewing';
detachedSendContext.createRequestId = () => 'req-detached';
detachedSendContext.fetchSessionsList = async () => [];
detachedSendContext.refreshCurrentSession = async () => {
  detachedCurrentRefreshes += 1;
  return { ok: true };
};
detachedSendContext.refreshSidebarSession = async (sessionId) => {
  detachedSidebarRefreshes += 1;
  return { id: sessionId };
};
detachedSendContext.fetchJsonOrRedirect = async (url, options = {}) => {
  detachedRequestPayload = { url, options };
  return {
    queued: true,
    session: {
      id: 'session-origin',
      activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 1 }),
    },
  };
};
detachedSendContext.upsertSession = (value) => value;
detachedSendContext.renderSessionList = () => {};
detachedSendContext.applyAttachedSessionState = () => {
  throw new Error('send should not reattach a different session while the user is viewing another one');
};
detachedSendContext.acknowledgeComposerPendingSend = () => true;
detachedSendContext.finalizeComposerPendingSend = () => true;
detachedSendContext.savePendingMessage = () => {};
detachedSendContext.clearPendingMessage = () => {};
detachedSendContext.refreshSessionAttentionUi = () => {};
detachedSendContext.setTimeout = () => 1;

vm.runInNewContext(dispatchActionSnippet, detachedSendContext, {
  filename: 'chat-dispatch-action-runtime-detached.js',
});

const detachedSendAccepted = await detachedSendContext.dispatchAction({
  action: 'send',
  sessionId: 'session-origin',
  text: 'send this from the original session',
});
assert.equal(detachedSendAccepted, true, 'session-bound sends should still succeed when the UI is attached elsewhere');
assert.equal(detachedRequestPayload?.url, '/api/sessions/session-origin/messages', 'send should target the explicit origin session instead of the currently attached one');
assert.equal(detachedCurrentRefreshes, 0, 'detached sends should not refresh the unrelated currently attached session');
assert.equal(detachedSidebarRefreshes, 1, 'detached sends should refresh the origin session in the sidebar instead');

const attachmentCompatContext = createBaseContext();
let attachmentCompatPayload = null;

attachmentCompatContext.currentSessionId = 'session-mobile-attachments';
attachmentCompatContext.createRequestId = () => 'req-mobile-attachment';
attachmentCompatContext.FormData = class MockFormData {
  constructor() {
    this.entries = [];
  }

  set(name, value) {
    this.entries = this.entries.filter((entry) => entry.name !== name);
    this.entries.push({ name, value, filename: null });
  }

  append(name, value, filename = null) {
    this.entries.push({ name, value, filename });
  }

  getAll(name) {
    return this.entries.filter((entry) => entry.name === name);
  }
};
attachmentCompatContext.fetchSessionsList = async () => [];
attachmentCompatContext.refreshCurrentSession = async () => ({ ok: true });
attachmentCompatContext.refreshSidebarSession = async () => null;
attachmentCompatContext.fetchJsonOrRedirect = async (url, options = {}) => {
  attachmentCompatPayload = { url, options };
  return {
    queued: false,
    session: {
      id: 'session-mobile-attachments',
      activity: createSessionActivity({ runState: 'running' }),
    },
  };
};
attachmentCompatContext.upsertSession = (value) => value;
attachmentCompatContext.renderSessionList = () => {};
attachmentCompatContext.applyAttachedSessionState = () => {};
attachmentCompatContext.acknowledgeComposerPendingSend = () => true;
attachmentCompatContext.finalizeComposerPendingSend = () => true;
attachmentCompatContext.savePendingMessage = () => {};
attachmentCompatContext.clearPendingMessage = () => {};
attachmentCompatContext.refreshSessionAttentionUi = () => {};
attachmentCompatContext.setTimeout = () => 1;

vm.runInNewContext(dispatchActionSnippet, attachmentCompatContext, {
  filename: 'chat-dispatch-action-attachment-compat-runtime.js',
});

const mobileAttachmentAccepted = await attachmentCompatContext.dispatchAction({
  action: 'send',
  text: 'inspect this photo',
  images: [{
    file: {
      name: 'mobile-photo.jpg',
      type: 'image/jpeg',
    },
    originalName: 'mobile-photo.jpg',
    mimeType: 'image/jpeg',
  }],
});
assert.equal(mobileAttachmentAccepted, true, 'attachment sends should still succeed when the browser lacks File.arrayBuffer');
assert.equal(attachmentCompatPayload?.url, '/api/sessions/session-mobile-attachments/messages', 'attachment sends should target the current session');
assert.ok(
  attachmentCompatPayload?.options?.body instanceof attachmentCompatContext.FormData,
  'attachment sends should use multipart FormData whenever local files are present',
);
assert.deepEqual(
  attachmentCompatPayload.options.body.getAll('attachments'),
  [{
    name: 'attachments',
    value: {
      name: 'mobile-photo.jpg',
      type: 'image/jpeg',
    },
    filename: 'mobile-photo.jpg',
  }],
  'multipart attachment sends should append the original file object and filename',
);

const attachReuseContext = createBaseContext();
let attachRefreshCalls = 0;
let attachStateCalls = 0;
let attachEventCalls = 0;
let attachRequested = null;

attachReuseContext.sessions = [
  {
    id: 'session-attach-existing',
    activity: createSessionActivity({ runState: 'idle', queueState: 'idle', queueCount: 0 }),
  },
];
attachReuseContext.getCurrentSession = () => attachReuseContext.sessions.find((session) => session.id === attachReuseContext.currentSessionId) || null;
attachReuseContext.getSessionRunState = (session) => session?.activity?.run?.state || 'idle';
attachReuseContext.fetchSessionEvents = async (sessionId, options = {}) => {
  attachEventCalls += 1;
  attachRequested = { sessionId, options };
  return [];
};
attachReuseContext.fetchSessionState = async () => {
  attachStateCalls += 1;
  return null;
};
attachReuseContext.refreshCurrentSession = async () => {
  attachRefreshCalls += 1;
  return { id: 'session-attach-existing' };
};

vm.runInNewContext(dispatchActionSnippet, attachReuseContext, {
  filename: 'chat-dispatch-action-attach-runtime.js',
});

const attachReused = await attachReuseContext.dispatchAction({ action: 'attach', sessionId: 'session-attach-existing' });
assert.equal(attachReused, true, 'attach should succeed when the session is already available in local state');
assert.equal(attachReuseContext.currentSessionId, 'session-attach-existing', 'attach should still update the current session id');
assert.equal(attachReuseContext.hasAttachedSession, true, 'attach should still mark the UI as attached');
assert.equal(attachEventCalls, 0, 'attach should not bypass the shared refresh pipeline for an already-known session');
assert.equal(attachStateCalls, 0, 'attach should let the shared refresh pipeline own state loading');
assert.equal(attachRefreshCalls, 1, 'attach should use the shared refresh path even when local metadata is present');

const attachQueuedContext = createBaseContext();
let queuedAttachStateCalls = 0;
let queuedAttachEventCalls = 0;
let queuedAttachRefreshCalls = 0;

attachQueuedContext.sessions = [
  {
    id: 'session-attach-queued',
    activity: createSessionActivity({ runState: 'running', queueState: 'queued', queueCount: 2 }),
  },
];
attachQueuedContext.getCurrentSession = () => attachQueuedContext.sessions.find((session) => session.id === attachQueuedContext.currentSessionId) || null;
attachQueuedContext.getSessionRunState = (session) => session?.activity?.run?.state || 'idle';
attachQueuedContext.fetchSessionEvents = async () => {
  queuedAttachEventCalls += 1;
  return [];
};
attachQueuedContext.fetchSessionState = async () => {
  queuedAttachStateCalls += 1;
  return {
    id: 'session-attach-queued',
    queuedMessages: [{ text: 'queued follow-up' }],
  };
};
attachQueuedContext.refreshCurrentSession = async () => {
  queuedAttachRefreshCalls += 1;
  return { id: 'session-attach-queued' };
};

vm.runInNewContext(dispatchActionSnippet, attachQueuedContext, {
  filename: 'chat-dispatch-action-attach-queued-runtime.js',
});

const attachQueued = await attachQueuedContext.dispatchAction({ action: 'attach', sessionId: 'session-attach-queued' });
assert.equal(attachQueued, true, 'attach should succeed for queued sessions');
assert.equal(queuedAttachEventCalls, 0, 'queued attach should let the shared refresh pipeline load events');
assert.equal(queuedAttachStateCalls, 0, 'queued attach should let the shared refresh pipeline load queue details');
assert.equal(queuedAttachRefreshCalls, 1, 'queued attach should use the shared refresh path');

const cancelledAttachContext = createBaseContext();
let cancelledAttachRefreshCalls = 0;
let cancelledAttachError = null;
let cancelledAttachSkeletonCalls = 0;
cancelledAttachContext.setChatCurrentSession = (sessionId, { hasAttachedSession = false } = {}) => {
  cancelledAttachContext.currentSessionId = sessionId;
  cancelledAttachContext.hasAttachedSession = hasAttachedSession;
};
cancelledAttachContext.clearMessages = () => {};
cancelledAttachContext.scheduleSessionLoadingSkeleton = () => {
  cancelledAttachSkeletonCalls += 1;
};
cancelledAttachContext.refreshCurrentSession = async () => {
  cancelledAttachRefreshCalls += 1;
  return null;
};
cancelledAttachContext.showSessionLoadError = (sessionId, error, reason) => {
  cancelledAttachError = { sessionId, error, reason };
};
cancelledAttachContext.classifySessionLoadError = (error) => error.eventRefreshReason || 'request_failed';
cancelledAttachContext.resetAttachedSessionRenderState = () => {};
loadDispatchRuntime(cancelledAttachContext, 'chat-dispatch-action-cancelled-attach-runtime.js');

const cancelledAttach = await cancelledAttachContext.dispatchAction({
  action: 'attach',
  sessionId: 'session-attach-cancelled',
});
assert.equal(cancelledAttach, false, 'exhausting retries without a valid session must return false');
assert.equal(
  cancelledAttachRefreshCalls,
  20,
  'a persistently superseded attach should keep re-joining the newest refresh up to the bounded join limit',
);
assert.equal(cancelledAttachSkeletonCalls, 1, 'an attach should enter the loading state before its first refresh');
assert.equal(cancelledAttachContext.hasAttachedSession, false, 'an attach that exhausted retries must not mark session as attached');
assert.ok(cancelledAttachError, 'exhausting retries without a valid session surfaces the error card');

// A cancellation thrown while the navigation is still current must not open
// the session-load error card either (defensive: no attach path throws it
// anymore, but the catch guard keeps the old bug from returning).
const cancelledNavigationContext = createBaseContext();
let cancelledNavigationErrorShown = false;
cancelledNavigationContext.setChatCurrentSession = (sessionId, { hasAttachedSession = false } = {}) => {
  cancelledNavigationContext.currentSessionId = sessionId;
  cancelledNavigationContext.hasAttachedSession = hasAttachedSession;
};
cancelledNavigationContext.clearMessages = () => {};
cancelledNavigationContext.scheduleSessionLoadingSkeleton = () => {};
cancelledNavigationContext.refreshCurrentSession = async () => {
  const error = new Error('Session refresh was cancelled before content loaded');
  error.code = 'SESSION_REFRESH_CANCELLED';
  error.eventRefreshReason = 'refresh_cancelled';
  throw error;
};
cancelledNavigationContext.showSessionLoadError = () => {
  cancelledNavigationErrorShown = true;
  return true;
};
cancelledNavigationContext.classifySessionLoadError = (error) => error.eventRefreshReason || 'request_failed';
cancelledNavigationContext.resetAttachedSessionRenderState = () => {};
loadDispatchRuntime(cancelledNavigationContext, 'chat-dispatch-action-cancelled-attach-throw-runtime.js');

const cancelledNavigation = await cancelledNavigationContext.dispatchAction({
  action: 'attach',
  sessionId: 'session-attach-cancelled',
});
assert.equal(cancelledNavigation, 'cancelled', 'a thrown cancellation must keep its distinct attach result');
assert.equal(cancelledNavigationErrorShown, false, 'a cancelled attach must not surface the session-load error card');

const eventFailedAttachContext = createBaseContext();
let eventFailedAttachError = null;
eventFailedAttachContext.setChatCurrentSession = (sessionId, { hasAttachedSession = false } = {}) => {
  eventFailedAttachContext.currentSessionId = sessionId;
  eventFailedAttachContext.hasAttachedSession = hasAttachedSession;
};
eventFailedAttachContext.sessions = [{
  id: 'session-events-failed',
  activity: createSessionActivity(),
}];
eventFailedAttachContext.clearMessages = () => {};
eventFailedAttachContext.scheduleSessionLoadingSkeleton = () => {};
eventFailedAttachContext.refreshCurrentSession = async () => {
  const error = new Error('events unavailable');
  error.status = 503;
  error.sessionLoadErrorShown = true;
  eventFailedAttachContext.showSessionLoadError('session-events-failed', error, 'http_failed');
  throw error;
};
eventFailedAttachContext.showSessionLoadError = (sessionId, error, reason) => {
  eventFailedAttachError = { sessionId, error, reason };
};
eventFailedAttachContext.classifySessionLoadError = (error) => error.status === 503 ? 'http_failed' : 'request_failed';
eventFailedAttachContext.resetAttachedSessionRenderState = () => {};
loadDispatchRuntime(eventFailedAttachContext, 'chat-dispatch-action-events-failed-attach-runtime.js');

const eventFailedAttach = await eventFailedAttachContext.dispatchAction({
  action: 'attach',
  sessionId: 'session-events-failed',
});
assert.equal(eventFailedAttach, false, 'an event load failure must not resolve as a successful attach');
assert.equal(eventFailedAttachContext.hasAttachedSession, false, 'an event load failure must detach the empty transcript');
assert.equal(eventFailedAttachError?.sessionId, 'session-events-failed');
assert.equal(eventFailedAttachError?.reason, 'http_failed');

// A phone waking from the background often kills its sockets: the first
// refresh after resume can fail transiently. The attach must retry the
// transport-class failure instead of landing the reader on an error card.
const transientRetryContext = createBaseContext();
let transientRetryCalls = 0;
let transientRetryError = null;
transientRetryContext.setChatCurrentSession = (sessionId, { hasAttachedSession = false } = {}) => {
  transientRetryContext.currentSessionId = sessionId;
  transientRetryContext.hasAttachedSession = hasAttachedSession;
};
transientRetryContext.clearMessages = () => {};
transientRetryContext.scheduleSessionLoadingSkeleton = () => {};
transientRetryContext.sleep = async () => {};
transientRetryContext.refreshCurrentSession = async () => {
  transientRetryCalls += 1;
  if (transientRetryCalls === 1) {
    const error = new Error('gateway hiccup');
    error.status = 503;
    throw error;
  }
  return { id: 'session-attach-transient' };
};
transientRetryContext.showSessionLoadError = (sessionId, error, reason) => {
  transientRetryError = { sessionId, error, reason };
};
transientRetryContext.classifySessionLoadError = (error) => error.status === 503 ? 'http_failed' : 'request_failed';
transientRetryContext.resetAttachedSessionRenderState = () => {};
loadDispatchRuntime(transientRetryContext, 'chat-dispatch-action-transient-retry-runtime.js');

const transientRetryAttach = await transientRetryContext.dispatchAction({
  action: 'attach',
  sessionId: 'session-attach-transient',
});
assert.equal(transientRetryAttach, true, 'a transient refresh failure should be retried, not surfaced');
assert.equal(transientRetryCalls, 2, 'a transient attach failure should retry exactly once before succeeding');
assert.equal(transientRetryContext.hasAttachedSession, true, 'a retried attach stays attached');
assert.equal(transientRetryError, null, 'a retried attach must not surface the error card');

// A refresh failure with the transcript already rendered is soft: keep the
// attach alive and the visible content instead of detaching into the error
// card path that used to poison the next session switch.
const renderedSoftFailContext = createBaseContext();
let renderedSoftFailError = null;
renderedSoftFailContext.setChatCurrentSession = (sessionId, { hasAttachedSession = false } = {}) => {
  renderedSoftFailContext.currentSessionId = sessionId;
  renderedSoftFailContext.hasAttachedSession = hasAttachedSession;
};
renderedSoftFailContext.clearMessages = () => {};
renderedSoftFailContext.scheduleSessionLoadingSkeleton = () => {};
renderedSoftFailContext.refreshCurrentSession = async () => {
  const error = new Error('refresh raced the rendered transcript');
  error.status = 503;
  throw error;
};
renderedSoftFailContext.hasRenderedEventSnapshot = (sessionId) => sessionId === 'session-attach-rendered';
renderedSoftFailContext.showSessionLoadError = (sessionId, error, reason) => {
  renderedSoftFailError = { sessionId, error, reason };
};
renderedSoftFailContext.classifySessionLoadError = (error) => error.status === 503 ? 'http_failed' : 'request_failed';
renderedSoftFailContext.resetAttachedSessionRenderState = () => {};
loadDispatchRuntime(renderedSoftFailContext, 'chat-dispatch-action-rendered-soft-fail-runtime.js');

const renderedSoftFailAttach = await renderedSoftFailContext.dispatchAction({
  action: 'attach',
  sessionId: 'session-attach-rendered',
});
assert.equal(renderedSoftFailAttach, true, 'a soft refresh failure keeps the attach standing on the rendered transcript');
assert.equal(renderedSoftFailContext.hasAttachedSession, true, 'a soft refresh failure must not detach the rendered session');
assert.equal(renderedSoftFailError, null, 'a soft refresh failure must not surface the session-load error card');

// A failed attach leaves hasAttachedSession=false, but the previous
// transcript is still on screen. The next session switch must preserve it
// instead of wiping it into the blank-until-reload state.
const failedThenSwitchContext = createBaseContext();
let failedThenSwitchClearOptions = null;
failedThenSwitchContext.currentSessionId = 'session-previous';
failedThenSwitchContext.hasAttachedSession = false;
failedThenSwitchContext.setChatCurrentSession = (sessionId, { hasAttachedSession = false } = {}) => {
  failedThenSwitchContext.currentSessionId = sessionId;
  failedThenSwitchContext.hasAttachedSession = hasAttachedSession;
};
failedThenSwitchContext.clearMessages = (options = {}) => {
  failedThenSwitchClearOptions = options;
};
failedThenSwitchContext.scheduleSessionLoadingSkeleton = () => {};
failedThenSwitchContext.sleep = async () => {};
failedThenSwitchContext.refreshCurrentSession = async () => ({ id: 'session-next' });
failedThenSwitchContext.showSessionLoadError = () => true;
failedThenSwitchContext.classifySessionLoadError = (error) => error.eventRefreshReason || 'request_failed';
failedThenSwitchContext.resetAttachedSessionRenderState = () => {};
loadDispatchRuntime(failedThenSwitchContext, 'chat-dispatch-action-failed-then-switch-runtime.js');

const failedThenSwitch = await failedThenSwitchContext.dispatchAction({
  action: 'attach',
  sessionId: 'session-next',
});
assert.equal(failedThenSwitch, true, 'the follow-up attach should succeed');
assert.equal(
  failedThenSwitchClearOptions?.preserveContent,
  true,
  'a switch after a failed attach must preserve the visible transcript instead of wiping it',
);

const reviewContext = createBaseContext();
let reviewRenderCalls = 0;

reviewContext.renderSessionList = () => {
  reviewRenderCalls += 1;
};
reviewContext.setLocalSessionReviewedAt = (_sessionId, stamp) => stamp;

vm.runInNewContext(sessionReviewSnippet, reviewContext, {
  filename: 'chat-session-review-runtime.js',
});

const numericTimestamp = 1767225600000;
const reviewSession = {
  id: 'session-reviewed',
  lastEventAt: numericTimestamp,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const reviewedSession = await reviewContext.markSessionReviewed(reviewSession, { sync: false, render: true });
assert.equal(
  reviewSession.localReviewedAt,
  new Date(numericTimestamp).toISOString(),
  'marking a session reviewed should accept numeric event timestamps from the backend',
);
assert.equal(
  reviewedSession.localReviewedAt,
  new Date(numericTimestamp).toISOString(),
  'markSessionReviewed should keep the normalized local review timestamp on the session record',
);
assert.equal(reviewRenderCalls, 1, 'markSessionReviewed should rerender the session list after storing a numeric review stamp');

const openedReviewContext = createBaseContext();
let openedReviewRenderCalls = 0;
let openedReviewStored = [];

openedReviewContext.currentSessionId = 'session-held';
openedReviewContext.renderSessionList = () => {
  openedReviewRenderCalls += 1;
};
openedReviewContext.setLocalSessionReviewedAt = (sessionId, stamp) => {
  openedReviewStored.push({ sessionId, stamp });
  return stamp;
};
openedReviewContext.getChatStoreSession = (sessionId) => (
  openedReviewContext.sessions.find((session) => session.id === sessionId) || null
);

vm.runInNewContext(sessionReviewSnippet, openedReviewContext, {
  filename: 'chat-session-review-open-runtime.js',
});

const heldSession = {
  id: 'session-held',
  lastActivityAt: '2026-03-12T12:30:00.000Z',
  lastEventAt: '2026-03-12T12:30:00.000Z',
  lastAssistantMessageAt: '2026-03-12T12:29:00.000Z',
  updatedAt: '2026-03-12T12:30:00.000Z',
  workflowState: 'done',
  activity: createSessionActivity(),
};
openedReviewContext.sessions = [heldSession];
openedReviewContext.holdAttachedSessionSidebarState(heldSession);
openedReviewContext.stageSessionReviewedForAttachedSession({
  ...heldSession,
  lastActivityAt: '2026-03-12T12:35:00.000Z',
  lastEventAt: '2026-03-12T12:40:00.000Z',
});
assert.deepEqual(
  openedReviewStored,
  [{ sessionId: 'session-held', stamp: '2026-03-12T12:35:00.000Z' }],
  'opening the attached session should immediately store a local reviewed marker',
);
assert.equal(
  openedReviewContext.getSessionSidebarListSnapshot({
    ...heldSession,
    archived: true,
    updatedAt: '2026-03-12T12:40:00.000Z',
  })?.localReviewedAt,
  '2026-03-12T12:35:00.000Z',
  'the held sidebar snapshot should clear review indicators immediately on open',
);
assert.equal(
  openedReviewRenderCalls,
  1,
  'opening the attached session should rerender the sidebar after clearing review indicators',
);
await openedReviewContext.settleAttachedSessionSidebarState({
  sessionId: 'session-held',
  sync: false,
  render: true,
});
assert.deepEqual(
  openedReviewStored,
  [{
    sessionId: 'session-held',
    stamp: '2026-03-12T12:35:00.000Z',
  }],
  'leaving the attached session should not duplicate the already-persisted local review marker',
);
assert.equal(
  openedReviewRenderCalls,
  1,
  'settling an already-reviewed session should not cause another review render',
);

const heldArchiveVisibilityContext = createBaseContext();
heldArchiveVisibilityContext.currentSessionId = 'session-current';
heldArchiveVisibilityContext.sessions = [
  {
    id: 'session-current',
    archived: true,
    archivedAt: '2026-03-12T10:00:00.000Z',
    updatedAt: '2026-03-12T08:00:00.000Z',
  },
  {
    id: 'session-other',
    updatedAt: '2026-03-12T09:00:00.000Z',
  },
];
heldArchiveVisibilityContext.getSessionSidebarListSnapshot = (session) => (
  session?.id === 'session-current'
    ? { ...session, archived: false, archivedAt: undefined }
    : session
);

vm.runInNewContext(sessionRootVisibilitySnippet, heldArchiveVisibilityContext, {
  filename: 'chat-session-root-visibility-runtime.js',
});

vm.runInNewContext(sessionCatalogVisibilitySnippet, heldArchiveVisibilityContext, {
  filename: 'chat-session-catalog-visibility-runtime.js',
});

assert.deepEqual(
  heldArchiveVisibilityContext.getActiveSessions().map((session) => session.id),
  ['session-current', 'session-other'],
  'the held current session should stay in the active list even after an optimistic archive update',
);
assert.deepEqual(
  heldArchiveVisibilityContext.getArchivedSessions().map((session) => session.id),
  [],
  'the held current session should stay out of the archive bucket until the user leaves it',
);

const deleteContext = createBaseContext();
let deleteRequest = null;
let deleteRenderCalls = 0;
let deleteEmptyCalls = 0;

deleteContext.currentSessionId = 'session-delete';
deleteContext.hasAttachedSession = true;
deleteContext.sessions = [
  { id: 'session-newer', activity: createSessionActivity(), updatedAt: '2026-03-12T09:00:00.000Z' },
  { id: 'session-delete', activity: createSessionActivity(), pinned: true, updatedAt: '2026-03-12T08:00:00.000Z' },
];
deleteContext.fetchJsonOrRedirect = async (url, options = {}) => {
  deleteRequest = { url, options };
  return { deleted: true, sessionId: 'session-delete' };
};
deleteContext.removeChatSessionState = (sessionId) => {
  deleteContext.sessions = deleteContext.sessions.filter((session) => session.id !== sessionId);
  if (deleteContext.currentSessionId === sessionId) {
    deleteContext.currentSessionId = null;
    deleteContext.hasAttachedSession = false;
  }
};
deleteContext.renderSessionList = () => { deleteRenderCalls += 1; };
deleteContext.syncEmptyStateUi = () => { deleteEmptyCalls += 1; };
deleteContext.resetAttachedSessionRenderState = () => {};
deleteContext.clearMessages = () => {};
deleteContext.persistActiveSessionId = () => {};
deleteContext.syncBrowserState = () => {};
deleteContext.showEmpty = () => {};
deleteContext.updateStatus = () => {};

vm.runInNewContext(dispatchActionSnippet, deleteContext, {
  filename: 'chat-dispatch-action-runtime.js',
});

const deleteAccepted = await deleteContext.dispatchAction({ action: 'delete', sessionId: 'session-delete' });
assert.equal(deleteAccepted, true, 'delete should resolve after server acceptance');
assert.equal(deleteRequest?.url, '/api/sessions/session-delete');
assert.equal(deleteRequest?.options?.method, 'DELETE', 'delete should use the permanent deletion endpoint');
assert.equal(deleteContext.currentSessionId, null, 'deleting the attached session should detach it');
assert.equal(deleteContext.sessions.some((session) => session.id === 'session-delete'), false,
  'delete should remove the session from local state');
assert.equal(deleteRenderCalls, 1, 'delete should refresh the session list');
assert.equal(deleteEmptyCalls, 1, 'delete should refresh the empty state');

// Session creation must carry the explicitly browsed project through the
// realtime action layer. Without this field, the backend falls back to the
// canonical project for a shared folder and the new session lands elsewhere.
const createProjectContext = createBaseContext();
let createdSessionPayload = null;
let createdSessionAttached = null;
createProjectContext.fetchJsonOrRedirect = async (url, options = {}) => {
  createdSessionPayload = { url, options };
  return { session: { id: 'session-created', projectId: 'prj_selected' } };
};
createProjectContext.upsertSession = (session) => session;
createProjectContext.renderSessionList = () => {};
createProjectContext.syncBrowserState = () => {};
createProjectContext.attachSession = async (sessionId, session) => {
  createdSessionAttached = { sessionId, session };
};
createProjectContext.syncEmptyStateUi = () => {};
createProjectContext.inputArea = { hidden: true };

vm.runInNewContext(dispatchActionSnippet, createProjectContext, {
  filename: 'chat-dispatch-action-create-runtime.js',
});

const createAccepted = await createProjectContext.dispatchAction({
  action: 'create',
  folder: '/shared/workspace',
  tool: 'codex',
  projectId: 'prj_selected',
});
assert.equal(createAccepted, true, 'session creation should resolve successfully');
assert.equal(createdSessionPayload?.url, '/api/sessions');
assert.equal(
  JSON.parse(createdSessionPayload?.options?.body || '{}').projectId,
  'prj_selected',
  'session creation must forward the selected project id to the backend',
);
assert.deepEqual(
  createdSessionAttached,
  { sessionId: 'session-created', session: { id: 'session-created', projectId: 'prj_selected' } },
  'created session should still attach after preserving its project binding',
);

const deleteFailureContext = createBaseContext();
deleteFailureContext.console = { ...console, error() {} };
deleteFailureContext.currentSessionId = 'session-failure';
deleteFailureContext.sessions = [{ id: 'session-failure', activity: createSessionActivity() }];
deleteFailureContext.fetchJsonOrRedirect = async () => { throw new Error('delete failed'); };
deleteFailureContext.removeChatSessionState = () => { throw new Error('must not remove before server acceptance'); };
deleteFailureContext.renderSessionList = () => {};

vm.runInNewContext(dispatchActionSnippet, deleteFailureContext, {
  filename: 'chat-dispatch-action-runtime.js',
});

const deleteRejected = await deleteFailureContext.dispatchAction({ action: 'delete', sessionId: 'session-failure' });
assert.equal(deleteRejected, false, 'failed deletion should return a failed action result');
assert.equal(deleteFailureContext.currentSessionId, 'session-failure', 'failed deletion should preserve the attached session');

const attachContext = createBaseContext();
let attachStatusUpdate = null;
let queuedPanelSession = null;
let attachRenderCalls = 0;
let browserStateSyncs = 0;
let forkSyncs = 0;
let shareSyncs = 0;
let modelLoads = 0;
let draftRestores = 0;
let restoredInteractionSession = null;

attachContext.currentTokens = 99;
attachContext.contextTokens = { style: { display: 'block' } };
attachContext.compactBtn = { style: { display: 'block' } };
attachContext.dropToolsBtn = { style: { display: 'block' } };
attachContext.inputArea = { hidden: true };
let emptyStateSyncSnapshot = null;
attachContext.syncEmptyStateUi = () => {
  emptyStateSyncSnapshot = {
    currentSessionId: attachContext.currentSessionId,
    hasAttachedSession: attachContext.hasAttachedSession,
  };
};
attachContext.headerTitle = { textContent: '' };
attachContext.inlineToolSelect = { value: '' };
attachContext.selectedTool = 'claude';
attachContext.toolsList = [{ id: 'claude' }, { id: 'codex' }];
attachContext.getSessionDisplayName = (session) => session?.name || 'Session';
attachContext.updateStatus = (state, session) => {
  attachStatusUpdate = { state, session };
};
attachContext.renderQueuedMessagePanel = (session) => {
  queuedPanelSession = session;
};
attachContext.loadModelsForCurrentTool = () => {
  modelLoads += 1;
};
attachContext.restoreDraft = () => {
  draftRestores += 1;
};
attachContext.renderSessionList = () => {
  attachRenderCalls += 1;
};
attachContext.syncBrowserState = () => {
  browserStateSyncs += 1;
};
attachContext.syncForkButton = () => {
  forkSyncs += 1;
};
attachContext.syncShareButton = () => {
  shareSyncs += 1;
};
attachContext.restoreComposerInteractionMode = (session) => {
  restoredInteractionSession = session;
};

vm.runInNewContext(applyAttachedSessionStateSnippet, attachContext, {
  filename: 'chat-apply-attached-session-state-runtime.js',
});

const attachedSession = {
  id: 'session-attach',
  name: 'Render validation session',
  tool: 'codex',
  activity: createSessionActivity({ runState: 'idle' }),
};
attachContext.applyAttachedSessionState(attachedSession.id, attachedSession);

assert.equal(attachContext.currentSessionId, attachedSession.id, 'attaching a session should set the current session id');
assert.equal(attachContext.hasAttachedSession, true, 'attaching a session should mark the UI as attached');
assert.deepEqual(
  emptyStateSyncSnapshot,
  { currentSessionId: attachedSession.id, hasAttachedSession: true },
  'empty/home visibility must sync after the selected session state is committed',
);
assert.equal(attachContext.currentTokens, 0, 'attaching a session should reset the live-context token counter');
assert.equal(attachContext.headerTitle.textContent, 'Render validation session', 'attaching a session should refresh the header title');
assert.equal(attachContext.inlineToolSelect.value, 'codex', 'attaching a session should update the inline tool picker');
assert.equal(attachContext.selectedTool, 'codex', 'attaching a session should adopt the backend tool selection');
assert.equal(modelLoads, 1, 'attaching a session should refresh models when the tool changes');
assert.equal(draftRestores, 1, 'attaching a session should restore the local draft');
assert.equal(attachRenderCalls, 1, 'attaching a session should rerender the session list');
assert.equal(browserStateSyncs, 1, 'attaching a session should sync browser navigation state');
assert.equal(forkSyncs, 1, 'attaching a session should refresh fork affordances');
assert.equal(shareSyncs, 1, 'attaching a session should refresh share affordances');
assert.equal(restoredInteractionSession, attachedSession, 'attaching a session should restore its own interaction mode');
assert.deepEqual(attachStatusUpdate, { state: 'connected', session: attachedSession }, 'attaching a session should update the status indicator');
assert.equal(queuedPanelSession, attachedSession, 'attaching a session should refresh the queued-message panel');

// An existing cached session record must not bypass the shared refresh
// scheduler. The first request is allowed to be superseded; attach retries
// once so the cleared transcript can be repopulated by the replacement load.
const cachedAttachContext = createBaseContext();
cachedAttachContext.currentSessionId = 'session-cached';
cachedAttachContext.sessions = [{ id: 'session-cached', name: 'Cached session' }];
cachedAttachContext.hasAttachedSession = true;
cachedAttachContext.clearMessages = () => {};
cachedAttachContext.scheduleSessionLoadingSkeleton = () => {};
cachedAttachContext.setChatCurrentSession = (id, options = {}) => {
  cachedAttachContext.currentSessionId = id;
  cachedAttachContext.hasAttachedSession = options.hasAttachedSession === true;
};
let cachedAttachRefreshes = 0;
cachedAttachContext.refreshCurrentSession = async () => {
  cachedAttachRefreshes += 1;
  return cachedAttachRefreshes === 1 ? null : { id: 'session-cached' };
};
cachedAttachContext.fetchSessionEvents = async () => {
  throw new Error('attach must not bypass the shared refresh scheduler');
};
vm.runInNewContext(
  `${dispatchSupportSnippet}\n${attachActionSupportSnippet}\n${dispatchActionSnippet}`,
  cachedAttachContext,
  { filename: 'chat-dispatch-action-cached-attach-runtime.js' },
);
assert.equal(
  await cachedAttachContext.dispatchAction({ action: 'attach', sessionId: 'session-cached' }),
  true,
  'an attach with a cached session record should recover from a superseded refresh',
);
assert.equal(cachedAttachRefreshes, 2, 'cached attaches should use the same bounded refresh retry');

console.log('test-chat-session-state: ok');
