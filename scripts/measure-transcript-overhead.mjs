#!/usr/bin/env node

import process from 'process';
import { getSession, getSessionTimelineEvents } from '../chat/session-manager.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';

function parseArgs(argv) {
  const parsed = {
    sessionId: '',
    iterations: 5,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--session' || arg === '--session-id') {
      parsed.sessionId = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--iterations') {
      const next = Number.parseInt(argv[index + 1] || '', 10);
      if (Number.isInteger(next) && next > 0) {
        parsed.iterations = next;
      }
      index += 1;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
  }

  return parsed;
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.sessionId) {
    console.error('Usage: node scripts/measure-transcript-overhead.mjs --session <sessionId> [--iterations 5] [--json]');
    process.exit(1);
  }

  const samples = [];

  for (let index = 0; index < options.iterations; index += 1) {
    const startedAt = process.hrtime.bigint();
    const session = await getSession(options.sessionId, { includeQueuedMessages: true });
    if (!session) {
      console.error(`Session not found: ${options.sessionId}`);
      process.exit(1);
    }
    const timeline = await getSessionTimelineEvents(options.sessionId);
    const displayStartedAt = process.hrtime.bigint();
    const display = buildSessionDisplayEvents(timeline, {
      sessionRunning: session?.activity?.run?.state === 'running',
    });
    const endedAt = process.hrtime.bigint();

    const totalMs = Number(endedAt - startedAt) / 1_000_000;
    const displayMs = Number(endedAt - displayStartedAt) / 1_000_000;
    samples.push({
      totalMs,
      displayMs,
      timelineEventCount: timeline.length,
      displayEventCount: display.length,
      runState: session?.activity?.run?.state || 'idle',
    });
  }

  const summary = samples.reduce((acc, sample) => {
    acc.totalMs += sample.totalMs;
    acc.displayMs += sample.displayMs;
    acc.timelineEventCount = sample.timelineEventCount;
    acc.displayEventCount = sample.displayEventCount;
    acc.runState = sample.runState;
    return acc;
  }, {
    totalMs: 0,
    displayMs: 0,
    timelineEventCount: 0,
    displayEventCount: 0,
    runState: 'idle',
  });

  const output = {
    sessionId: options.sessionId,
    iterations: options.iterations,
    runState: summary.runState,
    timelineEventCount: summary.timelineEventCount,
    displayEventCount: summary.displayEventCount,
    avgTotalMs: summary.totalMs / options.iterations,
    avgDisplayMs: summary.displayMs / options.iterations,
    maxTotalMs: Math.max(...samples.map((sample) => sample.totalMs)),
    maxDisplayMs: Math.max(...samples.map((sample) => sample.displayMs)),
    samples,
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Session: ${output.sessionId}`);
  console.log(`Run state: ${output.runState}`);
  console.log(`Iterations: ${output.iterations}`);
  console.log(`Timeline events: ${output.timelineEventCount}`);
  console.log(`Display events: ${output.displayEventCount}`);
  console.log(`Average total: ${formatMs(output.avgTotalMs)}`);
  console.log(`Average display transform: ${formatMs(output.avgDisplayMs)}`);
  console.log(`Max total: ${formatMs(output.maxTotalMs)}`);
  console.log(`Max display transform: ${formatMs(output.maxDisplayMs)}`);
}

await main();
