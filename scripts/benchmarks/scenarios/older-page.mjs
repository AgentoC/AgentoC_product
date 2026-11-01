// Scenario: older page.
// After a run completes, the client loads the latest visible page, then pages
// backward into older history; pagination latency is recorded (the metric the
// 1k/10k/50k event thresholds will bound in FOLLOW_UP).
// B0: sanity thresholds only; real ones are FOLLOW_UP (DS-06/11/21).

export default {
  id: 'older-page',
  description: 'Page backward through the visible event timeline and verify pagination contract.',
  dependencies: [],
  thresholds: {
    maxDurationMs: 120000,
    maxDiskBytes: 256 * 1024 * 1024,
    maxRssBytes: 1536 * 1024 * 1024,
    minEventCount: 1,
  },
  async run(ctx) {
    const {
      port, request, track,
      createSession, submitMessage, waitForRunTerminal, getEvents, log,
    } = ctx;
    const startedAt = Date.now();

    const session = await createSession(port, { name: 'Older page', description: 'older-page scenario' });
    const submitted = await submitMessage(port, session.id, 'bench-page');
    const terminal = await waitForRunTerminal(port, submitted.run.id);
    if (terminal.state !== 'completed') {
      throw new Error(`older-page: run ended ${terminal.state}`);
    }

    const latest = await track('latest_page', () => request(
      port,
      'GET',
      `/api/sessions/${session.id}/events?filter=visible&direction=latest&limit=1`,
    ));
    if (latest.status !== 200 || !Array.isArray(latest.json?.events) || latest.json.events.length !== 1) {
      throw new Error('older-page: latest page contract broken');
    }
    const oldestSeq = latest.json.pagination?.oldestSeq;
    if (!Number.isInteger(oldestSeq)) {
      throw new Error('older-page: pagination.oldestSeq missing');
    }

    const older = await track('older_page', () => request(
      port,
      'GET',
      `/api/sessions/${session.id}/events?filter=visible&beforeSeq=${oldestSeq}&limit=1`,
    ));
    if (older.status !== 200 || !Array.isArray(older.json?.events)) {
      throw new Error('older-page: older page request failed');
    }
    if (older.json.events.length > 0) {
      const latestSeq = older.json.pagination?.latestSeq;
      if (!Number.isInteger(latestSeq) || latestSeq >= oldestSeq) {
        throw new Error('older-page: older page did not stay before the latest page');
      }
    }

    const allEvents = await getEvents(port, session.id);
    log(`older-page: latestSeq=${oldestSeq}, olderPageEvents=${older.json.events.length}, total=${allEvents.length}`);

    return {
      phases: { scenarioTotalMs: Date.now() - startedAt },
      events: { all: allEvents.length, olderPageEvents: older.json.events.length },
      run: { state: terminal.state },
    };
  },
};
