// Scenario: WS reconnect.
// A client loses its WebSocket mid-session, reconnects, and must keep
// receiving invalidation hints without needing a full reload.
// B0: sanity thresholds only; real ones are FOLLOW_UP (DS-06/11/21).

export default {
  id: 'ws-reconnect',
  description: 'Reconnect the WebSocket mid-session and verify invalidation hints resume.',
  dependencies: [],
  thresholds: {
    maxDurationMs: 120000,
    maxDiskBytes: 256 * 1024 * 1024,
    maxRssBytes: 1536 * 1024 * 1024,
    minEventCount: 1,
  },
  async run(ctx) {
    const {
      port, request, track, waitFor, wsConnect,
      createSession, submitMessage, waitForRunTerminal, getEvents, log,
    } = ctx;
    const startedAt = Date.now();

    const collect = (socket, messages) => {
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    };

    let ws1 = await wsConnect(port);
    const round1 = [];
    collect(ws1, round1);
    const session = await createSession(port, { name: 'WS reconnect', description: 'ws-reconnect scenario' });
    const first = await submitMessage(port, session.id, 'bench-ws-1');
    await waitFor(() => round1.some((message) => message.type === 'session_invalidated'), 'first invalidation hint', 30000);
    await track('ws_round1', async () => { ws1.close(); ws1 = null; });

    await waitForRunTerminal(port, first.run.id);

    const ws2 = await wsConnect(port);
    const round2 = [];
    collect(ws2, round2);
    const second = await submitMessage(port, session.id, 'bench-ws-2');
    await waitFor(() => round2.some((message) => message.type === 'session_invalidated'), 'invalidation after reconnect', 30000);

    await waitForRunTerminal(port, second.run.id);
    ws2.close();

    // Observed server WS contract: exactly one build_info handshake per
    // connection, then invalidation hints (sessions_invalidated /
    // session_invalidated) plus incremental session_events pushes. Everything
    // else is unexpected. (phase6's stricter invalidation-only assertion
    // predates the incremental session_events push.)
    const allowed = new Set(['build_info', 'sessions_invalidated', 'session_invalidated', 'session_events']);
    const events = await getEvents(port, session.id);
    for (const [roundName, round] of [['round1', round1], ['round2', round2]]) {
      const buildInfo = round.filter((message) => message.type === 'build_info');
      if (buildInfo.length !== 1) {
        throw new Error(`ws-reconnect: ${roundName} expected exactly 1 build_info handshake, got ${buildInfo.length}`);
      }
      const invalidation = round.filter((message) => message.type === 'session_invalidated');
      if (invalidation.length < 1) {
        throw new Error(`ws-reconnect: ${roundName} expected at least 1 invalidation hint`);
      }
      if (round.some((message) => !allowed.has(message.type))) {
        throw new Error(`ws-reconnect: ${roundName} unexpected non-invalidation payload`);
      }
    }
    log(`ws-reconnect: ${round1.length} + ${round2.length} WS payloads, ${events.length} events`);

    return {
      phases: { scenarioTotalMs: Date.now() - startedAt },
      events: { all: events.length },
      run: { state: 'completed', wsRounds: 2 },
    };
  },
};
