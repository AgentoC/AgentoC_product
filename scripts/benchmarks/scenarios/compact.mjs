// Scenario: compact.
// Compact a finished session and verify the endpoint contract and that the
// session stays readable afterwards. Memory/CPU cost of compaction on large
// histories is a FOLLOW_UP metric (DS-06/11/21).
// B0: sanity thresholds only; real ones are FOLLOW_UP (DS-06/11/21).

export default {
  id: 'compact',
  description: 'Compact a finished session and verify the session stays readable.',
  dependencies: [],
  thresholds: {
    maxDurationMs: 120000,
    maxDiskBytes: 256 * 1024 * 1024,
    maxRssBytes: 1536 * 1024 * 1024,
    minEventCount: 1,
  },
  async run(ctx) {
    const {
      port, request, track, createSession, submitMessage, waitForRunTerminal, getEvents, log,
    } = ctx;
    const startedAt = Date.now();

    const session = await createSession(port, { name: 'Compact', description: 'compact scenario' });
    const submitted = await submitMessage(port, session.id, 'bench-compact');
    const terminal = await waitForRunTerminal(port, submitted.run.id);
    if (terminal.state !== 'completed') {
      throw new Error(`compact: run ended ${terminal.state}`);
    }

    const before = await getEvents(port, session.id);

    const compact = await track('compact', () => request(port, 'POST', `/api/sessions/${session.id}/compact`));
    if (compact.status !== 200 || compact.json?.ok !== true) {
      throw new Error(`compact: unexpected response ${compact.status} ${String(compact.text || '').slice(0, 300)}`);
    }

    const after = await request(port, 'GET', `/api/sessions/${session.id}`);
    if (after.status !== 200) {
      throw new Error('compact: session unreadable after compaction');
    }
    const afterEvents = await getEvents(port, session.id);
    if (afterEvents.length < 1) {
      throw new Error('compact: session event timeline emptied by compaction');
    }
    log(`compact: ok, events ${before.length} -> ${afterEvents.length}`);

    return {
      phases: { scenarioTotalMs: Date.now() - startedAt },
      events: { before: before.length, after: afterEvents.length },
      run: { state: terminal.state },
    };
  },
};
