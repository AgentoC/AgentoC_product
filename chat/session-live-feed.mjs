import { randomUUID } from 'node:crypto';

// Only consecutive Codex deltas with the same complete semantic identity can
// share a delivery frame. Explicit delivery IDs remain indivisible.
function mergePendingDelta(previous, source) {
  if (!previous || source.eventId || source.type !== 'text_delta' || previous.type !== source.type
    || !source.canonicalMessageId || !source.runId || typeof source.text !== 'string' || !source.text) return null;
  const ordinal = /^agent-message:(.+):(\d+)$/.exec(source.providerEventId || '');
  const priorOrdinal = /^agent-message:(.+):(\d+)$/.exec(previous.providerEventId || '');
  if (!ordinal || !priorOrdinal || ordinal[1] !== priorOrdinal[1]
    || Number(ordinal[2]) !== Number(priorOrdinal[2]) + 1) return null;
  const semantic = event => Object.fromEntries(Object.entries(event)
    .filter(([key]) => !['text', 'id', 'eventId', 'providerEventId', 'timestamp'].includes(key)
      && !(key === 'harnessEventId' && event.harnessEventSource === 'spool-record'))
    .sort(([a], [b]) => a.localeCompare(b)));
  if (JSON.stringify(semantic(previous)) !== JSON.stringify(semantic(source))) return null;
  return { ...previous, text: previous.text + source.text, providerEventId: source.providerEventId };
}

// Ephemeral, bounded delivery only. Durable history retains its own cursor.
export function createSessionLiveFeed({ clock = Date.now, maximumSessions = 64,
  maximumEvents = 2048, maximumSessionBytes = 2 * 1024 * 1024, maximumBytes = 8 * 1024 * 1024,
  ttlMs = 5 * 60_000, compactPendingDeltas = false } = {}) {
  for (const value of [maximumSessions, maximumEvents, maximumSessionBytes, maximumBytes, ttlMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid live feed capacity');
  }
  const streamId = randomUUID(), sessions = new Map();
  let bytes = 0;
  function drop(id) { const old = sessions.get(id); if (old) bytes -= old.bytes; sessions.delete(id); }
  function prune() {
    for (const [id, state] of sessions) if (clock() - state.updatedAt >= ttlMs) drop(id);
    while (sessions.size > maximumSessions || bytes > maximumBytes) drop(sessions.keys().next().value);
  }
  return {
    publish(sessionId, events) {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !Array.isArray(events)) return false;
      prune();
      const state = sessions.get(sessionId) || { entries: [], bytes: 0, cursor: 0, exposedCursor: 0, updatedAt: clock() };
      let appended = false;
      for (const source of events.slice(0, 512)) {
        if (!source || typeof source !== 'object') continue;
        if (Number(source.seq) > 0 || Number(source.endSeq) > 0) continue;
        const cursor = ++state.cursor;
        const tail = state.entries.at(-1);
        const merged = compactPendingDeltas && tail && tail.cursor > state.exposedCursor && tail.cursor === cursor - 1
          ? mergePendingDelta(tail.event, source) : null;
        if (merged) {
          merged.eventId = `live:${streamId}:${tail.firstCursor}-${cursor}`;
          const serialized = JSON.stringify(merged);
          const size = Buffer.byteLength(serialized);
          if (size <= Math.min(64 * 1024, maximumSessionBytes)) {
            state.bytes += size - tail.bytes; bytes += size - tail.bytes;
            tail.cursor = cursor; tail.event = JSON.parse(serialized); tail.bytes = size;
            while (state.bytes > maximumSessionBytes) {
              const removed = state.entries.shift(); state.bytes -= removed.bytes; bytes -= removed.bytes;
            }
            appended = true;
            continue;
          }
        }
        const event = { ...source,
          ...(!source.eventId && !(Number(source.seq) > 0) ? { eventId: `live:${streamId}:${cursor}` } : {}) };
        let serialized;
        try { serialized = JSON.stringify(event); } catch { serialized = ''; }
        const size = Buffer.byteLength(serialized);
        // Advance the cursor on an oversized frame as well: a reader must
        // detect the missing interval instead of silently accepting its tail.
        if (!serialized || size > Math.min(64 * 1024, maximumSessionBytes)) {
          bytes -= state.bytes; state.entries = []; state.bytes = 0; appended = true; continue;
        }
        state.entries.push({ firstCursor: cursor, cursor, event: JSON.parse(serialized), bytes: size });
        state.bytes += size; bytes += size; appended = true;
        while (state.entries.length > maximumEvents || state.bytes > maximumSessionBytes) {
          const removed = state.entries.shift(); state.bytes -= removed.bytes; bytes -= removed.bytes;
        }
      }
      state.updatedAt = clock(); sessions.delete(sessionId); sessions.set(sessionId, state); prune();
      return appended;
    },
    read(sessionId, { afterCursor = 0, requestedStreamId = '' } = {}) {
      prune();
      const state = sessions.get(sessionId), latest = state?.cursor || 0;
      const first = state?.entries[0]?.firstCursor || latest + 1;
      const reset = !Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterCursor > latest
        || Boolean(requestedStreamId && requestedStreamId !== streamId)
        || afterCursor < first - 1
        || Boolean(state?.entries.some(item => item.firstCursor <= afterCursor && afterCursor < item.cursor));
      const entries = reset ? [] : (state?.entries || []).filter(item => item.cursor > afterCursor).slice(0, 128);
      // Retain a 256KiB per-response budget independently of ring capacity.
      let size = 0; const page = [];
      for (const entry of entries) { if (size + entry.bytes > 256 * 1024) break; size += entry.bytes; page.push(entry); }
      // Freeze anything exposed to any reader, including a response whose
      // acknowledgement is lost. Retrying that cursor must not duplicate text.
      if (state && page.length) state.exposedCursor = Math.max(state.exposedCursor, page.at(-1).cursor);
      return { liveStreamId: streamId, liveCursor: reset ? latest : (page.at(-1)?.cursor ?? afterCursor),
        liveEvents: page.map(item => item.event), liveResetRequired: reset };
    },
    stats() { prune(); return { sessions: sessions.size, bytes }; },
  };
}

export const sessionLiveFeed = createSessionLiveFeed();

// V2 is opt-in: legacy clients retain their original per-event delivery.
export const sessionRealtimeLiveFeed = createSessionLiveFeed({ compactPendingDeltas: true, maximumBytes: 4 * 1024 * 1024 });

export function publishAllLiveEvents(feed, sessionId, events) {
  if (!Array.isArray(events)) return false;
  let appended = false;
  for (let offset = 0; offset < events.length; offset += 512) {
    appended = feed.publish(sessionId, events.slice(offset, offset + 512)) || appended;
  }
  return appended;
}
