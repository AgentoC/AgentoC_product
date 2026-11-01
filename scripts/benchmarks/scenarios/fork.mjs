// Scenario: fork.
// Fork a finished session and verify the child copies the visible timeline.
// Cost of forking large histories is a FOLLOW_UP metric (DS-06/11/21).
// B0: sanity thresholds only; real ones are FOLLOW_UP (DS-06/11/21).

export default {
  id: 'fork',
  description: 'Fork a finished session and verify the child copies the visible timeline.',
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

    const parent = await createSession(port, { name: 'Fork parent', description: 'fork scenario' });
    const submitted = await submitMessage(port, parent.id, 'bench-fork');
    const terminal = await waitForRunTerminal(port, submitted.run.id);
    if (terminal.state !== 'completed') {
      throw new Error(`fork: run ended ${terminal.state}`);
    }

    const parentEvents = await getEvents(port, parent.id, 'visible');

    const fork = await track('fork', () => request(port, 'POST', `/api/sessions/${parent.id}/fork`));
    if (fork.status !== 201 || !fork.json?.session?.id) {
      throw new Error(`fork: unexpected response ${fork.status} ${String(fork.text || '').slice(0, 300)}`);
    }
    if (fork.json.session.id === parent.id) {
      throw new Error('fork: child session id must differ from parent');
    }

    const childEvents = await getEvents(port, fork.json.session.id, 'visible');
    if (childEvents.length !== parentEvents.length) {
      throw new Error(`fork: child timeline ${childEvents.length} != parent timeline ${parentEvents.length}`);
    }
    log(`fork: ok, ${parentEvents.length} events copied`);

    return {
      phases: { scenarioTotalMs: Date.now() - startedAt },
      events: { parent: parentEvents.length, child: childEvents.length },
      run: { state: terminal.state },
    };
  },
};
