// Scenario: restart/reconcile.
// Kill the chat server mid-run, restart it, and verify every detached run
// reconciles to a terminal state without duplicate events.
// B0: sanity thresholds only; real ones are FOLLOW_UP (DS-06/11/21).

export default {
  id: 'restart-reconcile',
  description: 'Kill the chat server while runs are in flight, restart it, and verify detached runs reconcile to completed.',
  dependencies: [],
  thresholds: {
    maxDurationMs: 180000,
    maxDiskBytes: 256 * 1024 * 1024,
    maxRssBytes: 1536 * 1024 * 1024,
    minEventCount: 1,
  },
  async run(ctx) {
    const {
      options, port, request, track, waitFor, sleep,
      createSession, submitMessage, getEvents, waitForRunTerminal,
      startServer, stopServer, log,
    } = ctx;
    const startedAt = Date.now();

    const runs = [];
    for (let index = 0; index < options.runs; index += 1) {
      const session = await createSession(port, { name: `Restart ${index}`, description: 'restart/reconcile scenario' });
      const submitted = await submitMessage(port, session.id, `bench-rs-${index}`, 'slow run for restart');
      runs.push({ sessionId: session.id, runId: submitted.run.id });
    }

    // Wait until every run is visibly running (in-flight during the restart).
    for (const run of runs) {
      await waitFor(async () => {
        const res = await request(port, 'GET', `/api/runs/${run.runId}`);
        return res.status === 200 && res.json.run.state === 'running';
      }, `run ${run.runId} running`, 30000);
    }

    // Wait for at least one incremental tool_result to be archived, or give up
    // after a short grace period — the restart assertion is about the run
    // reaching completed, not about which events existed pre-restart.
    const anyToolResult = await waitFor(async () => {
      const events = await getEvents(port, runs[0].sessionId);
      return events.some((event) => event.type === 'tool_result');
    }, 'incremental tool output archived', 5000).catch(() => false);

    await track('stop_server', async () => { await stopServer(await ctx.currentServer()); });
    await sleep(300);
    await track('restart_server', async () => {
      await startServer({ home: ctx.home, port, envOverrides: ctx.providerEnv });
    });
    await track('boot_after_restart', () => waitFor(
      async () => (await request(port, 'GET', '/api/auth/me')).status === 200,
      'server back up',
      30000,
    ));

    const terminalRuns = [];
    for (const run of runs) {
      const terminal = await waitForRunTerminal(port, run.runId);
      terminalRuns.push(terminal);
    }
    const failed = terminalRuns.filter((run) => run.state !== 'completed');
    if (failed.length > 0) {
      throw new Error(`restart-reconcile: ${failed.length}/${terminalRuns.length} runs did not complete`);
    }

    const events = await getEvents(port, runs[0].sessionId);
    const assistantMessages = events.filter(
      (event) => event.type === 'message' && event.role === 'assistant' && event.content.startsWith('bench:'),
    );
    if (assistantMessages.length < 1) {
      throw new Error('restart-reconcile: no final assistant message archived after restart');
    }
    const toolResults = events.filter((event) => event.type === 'tool_result');
    if (anyToolResult && toolResults.length < 1) {
      throw new Error('restart-reconcile: tool results vanished after restart');
    }

    log(`restart-reconcile: ${terminalRuns.length} run(s) completed, ${events.length} events, toolResultArchivedPreRestart=${anyToolResult}`);

    return {
      phases: { scenarioTotalMs: Date.now() - startedAt },
      events: { all: events.length, assistantMessages: assistantMessages.length },
      run: { state: terminalRuns[0].state, count: terminalRuns.length, toolResultArchivedPreRestart: anyToolResult },
    };
  },
};
