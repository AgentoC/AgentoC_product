// Scenario: archive.
// Archive a finished session, verify it lands in the archived list, then
// restore it. Cost of archiving large histories is a FOLLOW_UP metric
// (DS-06/11/21).
// B0: sanity thresholds only; real ones are FOLLOW_UP (DS-06/11/21).

export default {
  id: 'archive',
  description: 'Archive a finished session, verify the archived list, then restore it.',
  dependencies: [],
  thresholds: {
    maxDurationMs: 120000,
    maxDiskBytes: 256 * 1024 * 1024,
    maxRssBytes: 1536 * 1024 * 1024,
    minEventCount: 1,
  },
  async run(ctx) {
    const {
      port, request, track, createSession, submitMessage, waitForRunTerminal, log,
    } = ctx;
    const startedAt = Date.now();

    const session = await createSession(port, { name: 'Archive', description: 'archive scenario' });
    const submitted = await submitMessage(port, session.id, 'bench-archive');
    const terminal = await waitForRunTerminal(port, submitted.run.id);
    if (terminal.state !== 'completed') {
      throw new Error(`archive: run ended ${terminal.state}`);
    }

    const archive = await track('archive', () => request(port, 'PATCH', `/api/sessions/${session.id}`, { archived: true }));
    if (archive.status !== 200) {
      throw new Error(`archive: PATCH failed ${archive.status} ${String(archive.text || '').slice(0, 300)}`);
    }

    const archivedList = await request(port, 'GET', '/api/sessions/archived');
    if (archivedList.status !== 200) {
      throw new Error('archive: archived list request failed');
    }
    const ids = (archivedList.json?.sessions || []).map((entry) => entry.id);
    if (!ids.includes(session.id)) {
      throw new Error('archive: session missing from archived list');
    }

    const detail = await request(port, 'GET', `/api/sessions/${session.id}`);
    if (detail.status !== 200) {
      throw new Error('archive: archived session detail unreadable');
    }

    const restore = await track('restore', () => request(port, 'PATCH', `/api/sessions/${session.id}`, { archived: false }));
    if (restore.status !== 200) {
      throw new Error('archive: restore PATCH failed');
    }
    log('archive: ok, archived and restored');

    return {
      phases: { scenarioTotalMs: Date.now() - startedAt },
      run: { state: terminal.state, archived: true, restored: true },
    };
  },
};
