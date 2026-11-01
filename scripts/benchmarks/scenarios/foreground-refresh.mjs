// Scenario: foreground refresh.
// While a run is active, the foreground view repeatedly refreshes session
// detail + events; read latency is recorded and no duplicate transcript rows
// may appear (p50/p95 of these reads is the metric DS-21 will threshold).
// B0: sanity thresholds only; real ones are FOLLOW_UP (DS-06/11/21).

export default {
  id: 'foreground-refresh',
  description: 'Hammer foreground session/event reads while a run is active and verify no duplicate transcript rows.',
  dependencies: [],
  thresholds: {
    maxDurationMs: 120000,
    maxDiskBytes: 256 * 1024 * 1024,
    maxRssBytes: 1536 * 1024 * 1024,
    minEventCount: 1,
  },
  async run(ctx) {
    const {
      options, port, request, track, waitFor,
      createSession, submitMessage, getEvents, waitForRunTerminal, log,
    } = ctx;
    const startedAt = Date.now();

    const session = await createSession(port, { name: 'Foreground refresh', description: 'foreground-refresh scenario' });
    const submitted = await submitMessage(port, session.id, 'bench-fg', 'Run under read load');
    await waitFor(async () => {
      const res = await request(port, 'GET', `/api/runs/${submitted.run.id}`);
      return res.status === 200 && res.json.run.state === 'running';
    }, 'run running', 30000);

    const rounds = 4;
    for (let round = 0; round < rounds; round += 1) {
      await track('session_detail', () => request(port, 'GET', `/api/sessions/${session.id}`));
      await track('events_visible', () => request(port, 'GET', `/api/sessions/${session.id}/events?filter=visible`));
      await track('run_status', () => request(port, 'GET', `/api/runs/${submitted.run.id}`));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const terminal = await waitForRunTerminal(port, submitted.run.id);
    if (terminal.state !== 'completed') {
      throw new Error(`foreground-refresh: run ended ${terminal.state}`);
    }

    const events = await getEvents(port, session.id);
    // The provider's final message content is deterministic; after hammering
    // the read paths it must have been archived exactly once.
    const prefix = `bench:${options.seed}:${options.events}:`;
    const finalContent = options.bodyBytes <= prefix.length
      ? prefix
      : prefix + 'x'.repeat(options.bodyBytes - prefix.length);
    const finalMessages = events.filter(
      (event) => event.type === 'message' && event.role === 'assistant' && event.content === finalContent,
    );
    if (finalMessages.length !== 1) {
      throw new Error(`foreground-refresh: expected exactly 1 final assistant message, got ${finalMessages.length}`);
    }
    const toolResults = events.filter((event) => event.type === 'tool_result');
    if (toolResults.length < 1) {
      throw new Error('foreground-refresh: expected at least 1 tool result');
    }
    log(`foreground-refresh: ${rounds} refresh rounds, ${events.length} events, no duplicates`);

    return {
      phases: { scenarioTotalMs: Date.now() - startedAt },
      events: { all: events.length, assistantMessages: finalMessages.length },
      run: { state: terminal.state },
    };
  },
};
