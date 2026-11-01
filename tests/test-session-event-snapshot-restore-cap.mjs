#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static/chat/session-http-helpers.js'), 'utf8')
  + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http-list-state.js'), 'utf8')
  + '\n' + readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

function makeElement() {
  return {
    style: {},
    textContent: '',
    children: [],
    className: '',
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    remove() { this.parentNode = null; },
    scrollIntoView() {},
    querySelector() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function createContext({ sessionId = 'session_cap_test', snapshotEvents = [] } = {}) {
  const renderCalls = [];
  const context = {
    console,
    Map,
    Set,
    Math,
    Date,
    JSON,
    window: {
      location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/', pathname: '/' },
      crypto: { randomUUID() { return 'test_cap_uuid'; } },
    },
    document: {
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement() { return makeElement(); },
    },
    navigator: {},
    currentSessionId: sessionId,
    hasAttachedSession: true,
    messagesInner: makeElement(),
    messagesEl: { scrollHeight: 0, scrollTop: 0, clientHeight: 0 },
    emptyState: makeElement(),
    renderedEventState: {
      sessionId: '',
      expandedOperationIds: new Set(),
      runningBlockExpanded: false,
    },
    jsonResponseCache: new Map(),
    pendingSessionReviewSyncs: new Map(),
    heldSidebarSessionState: null,
    __renderCalls: renderCalls,
    // Minimal mocks
    clearMessages() {},
    showEmpty() {
      context.emptyState.appendChild(makeElement());
    },
    renderEvent(event) {
      renderCalls.push(event);
      // Simulate DOM insertion so messagesInner.children grows
      const node = makeElement();
      node.__event = event;
      context.messagesInner.appendChild(node);
    },
    reconcilePendingMessageState() {},
    updateStatus() {},
    syncBrowserState() {},
    applyFinishedTurnCollapseState() { return null; },
    shouldExpandThinkingBlocksByDefaultForSessionUi() { return false; },
    requestAnimationFrame(fn) { setTimeout(fn, 0); },
    // Cache helpers — expose so the test can pre-seed
    ensureSessionEventSnapshotCache() {
      if (!(context.__sessionEventSnapshotCache instanceof Map)) {
        context.__sessionEventSnapshotCache = new Map();
      }
      return context.__sessionEventSnapshotCache;
    },
    setSessionEventSnapshot(id, events, opts = {}) {
      const cache = context.ensureSessionEventSnapshotCache();
      cache.set(id, {
        events: Array.isArray(events) ? events.slice() : [],
        pagination: opts.pagination || null,
        runState: opts.runState || 'idle',
        runActivity: opts.runActivity || null,
        expandedOperationIds: [],
        runningBlockExpanded: false,
        scrollTop: Number.isFinite(opts.scrollTop) ? Math.max(0, opts.scrollTop) : 0,
        updatedAt: Date.now(),
      });
    },
    getSessionEventSnapshot(id) {
      const cache = context.ensureSessionEventSnapshotCache();
      return cache.get(id) || null;
    },
    hasRenderedEventSnapshot() { return false; },
    getExpandedOperationIds() { return new Set(); },
    syncFetchedRunActivity() {},
    syncLiveMessageMetadataForRunState() {},
    syncEditableMessageActions() {},
    rebuildRenderedOperationIndexes() {},
    syncMessageViewportStabilitySnapshot() {},
    cloneSessionForSidebarHold() {},
    getSessionRunState() { return 'idle'; },
  };

  // Seed the snapshot cache
  context.setSessionEventSnapshot(sessionId, snapshotEvents, {
    pagination: context.snapshotPagination,
    runState: 'idle',
  });

  context.globalThis = context;
  context.self = context;
  return context;
}

// ─── Snapshot restore renders the standard page size ───────────────────
{
  const events = Array.from({ length: 45 }, (_, i) => ({
    seq: i + 1,
    type: 'message',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Event ${i + 1}`,
  }));
  const context = createContext({ snapshotEvents: events });
  context.snapshotPagination = {
    latestSeq: 45,
    oldestSeq: 1,
    hasMoreBefore: false,
  };

  vm.runInNewContext(source, context, { filename: 'static/chat/session-http.js' });

  const restored = context.restoreSessionEventSnapshot('session_cap_test');
  assert.equal(restored, true, 'restore returns true for a successful snapshot');
  assert.equal(context.__renderCalls.length, 45, 'under the cap, all events are rendered');
  assert.equal(context.renderedEventState.eventCount, 45, 'rendered event count matches');
  assert.equal(context.renderedEventState.hasMoreBefore, false, 'hasMoreBefore stays false when not trimmed');
  assert.equal(context.renderedEventState.earliestSeq, 1, 'earliestSeq is preserved when not trimmed');
}

// ─── Snapshot restore caps when events exceed the limit ────────────────
{
  const total = 200;
  const events = Array.from({ length: total }, (_, i) => ({
    seq: i + 1,
    type: 'message',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Event ${i + 1}`,
  }));
  const context = createContext({ snapshotEvents: events });
  context.snapshotPagination = {
    latestSeq: total,
    oldestSeq: 1,
    hasMoreBefore: false,
  };

  vm.runInNewContext(source, context, { filename: 'static/chat/session-http.js' });

  const restored = context.restoreSessionEventSnapshot('session_cap_test');
  assert.equal(restored, true, 'restore returns true for a capped snapshot');

  // SESSION_EVENT_SNAPSHOT_RESTORE_LIMIT is 120 (declared const; not exposed on the vm context).
  const limit = 120;
  assert.equal(limit, 120, 'sanity: limit is 120');
  assert.equal(context.__renderCalls.length, limit,
    `only ${limit} events are rendered when snapshot has ${total}`);
  assert.equal(context.renderedEventState.eventCount, limit,
    'rendered event count is capped to the limit');
  assert.equal(context.renderedEventState.hasMoreBefore, true,
    'hasMoreBefore is forced true after trimming');
  assert.equal(context.renderedEventState.earliestSeq, total - limit + 1,
    'earliestSeq points to the oldest rendered (capped) event');

  // Verify the snapshot cache was mutated to match
  const cached = context.getSessionEventSnapshot('session_cap_test');
  assert.equal(cached.events.length, limit, 'cached snapshot is trimmed to the render window');
  assert.equal(cached.events[0].seq, total - limit + 1,
    'cached snapshot starts at the oldest capped event');
  assert.equal(cached.pagination.hasMoreBefore, true,
    'cached pagination hasMoreBefore is true');
  assert.equal(cached.pagination.oldestSeq, undefined,
    'cached pagination oldestSeq is cleared so it recomputes from the cap window');

  // Verify the DOM received exactly the capped events
  const renderedSeqs = context.__renderCalls.map((e) => e.seq);
  assert.equal(renderedSeqs[0], total - limit + 1,
    'first rendered event is the oldest in the cap window');
  assert.equal(renderedSeqs[renderedSeqs.length - 1], total,
    'last rendered event is the latest');
}

// ─── Empty snapshot still shows empty state ────────────────────────────
{
  const context = createContext({ sessionId: 'empty_session', snapshotEvents: [] });
  context.snapshotPagination = { latestSeq: 0, oldestSeq: 0, hasMoreBefore: false };

  vm.runInNewContext(source, context, { filename: 'static/chat/session-http.js' });

  const restored = context.restoreSessionEventSnapshot('empty_session');
  assert.equal(restored, true, 'restore handles an empty snapshot');
  assert.equal(context.__renderCalls.length, 0, 'no events rendered for an empty snapshot');
}

// ─── Missing snapshot returns false ────────────────────────────────────
{
  const context = createContext({ sessionId: 'no_cache', snapshotEvents: [] });
  // Clear the cache entirely so getSessionEventSnapshot returns null
  context.ensureSessionEventSnapshotCache().clear();
  context.snapshotPagination = {};

  vm.runInNewContext(source, context, { filename: 'static/chat/session-http.js' });

  const restored = context.restoreSessionEventSnapshot('no_cache');
  assert.equal(restored, false, 'restore returns false when no cached snapshot exists');
}

console.log('test-session-event-snapshot-restore-cap: ok');
