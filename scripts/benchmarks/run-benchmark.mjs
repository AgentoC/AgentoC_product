#!/usr/bin/env node
// DS-37 benchmark harness (B0: tooling + baseline).
//
// Boots clean instances of chat-server.mjs (throwaway mkdtemp HOME + configDir,
// deterministic fake codex provider), runs scenario modules against them,
// samples RSS + disk, and writes JSON/Markdown reports. Exits non-zero when a
// scenario fails or a threshold is violated, and always removes the temp
// homes it created (unless --keep).
//
// Usage:
//   node scripts/benchmarks/run-benchmark.mjs \
//     --scenario restart-reconcile,ws-reconnect | --scenario all \
//     --events 100 --runs 1 --delay-ms 50 --body-bytes 200 \
//     --attachments 0 --seed 42 --out-dir artifacts/benchmarks
//
// B0 note: thresholds are permissive sanity bounds only. The real threshold
// matrix (p50/p95, RSS/heap/event-loop/network/disk at 1k/10k/50k events and
// 1/5/20 concurrent runs) depends on DS-06/11/21 and lands in a later batch.
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  dirBytes, percentiles, removeTempHome, sampleRssBytes, setupTempHome, sleep,
  startServer, stopServer, wsConnect, request, waitFor, createSession,
  submitMessage, getEvents, waitForRunTerminal, repoRoot,
} from './helpers.mjs';
import restartReconcile from './scenarios/restart-reconcile.mjs';
import wsReconnect from './scenarios/ws-reconnect.mjs';
import foregroundRefresh from './scenarios/foreground-refresh.mjs';
import olderPage from './scenarios/older-page.mjs';
import compact from './scenarios/compact.mjs';
import fork from './scenarios/fork.mjs';
import archive from './scenarios/archive.mjs';

const SCENARIOS = [restartReconcile, wsReconnect, foregroundRefresh, olderPage, compact, fork, archive];
const DEFAULT_OUT_DIR = join(repoRoot, 'artifacts', 'benchmarks');

function usage() {
  console.log(`Usage: node scripts/benchmarks/run-benchmark.mjs [options]
  --scenario <ids>   comma-separated scenario ids or "all" (default: all)
  --events <n>       fake provider event lines (default: 100)
  --runs <n>         concurrent runs to submit (default: 1)
  --delay-ms <n>     fake provider per-line delay (default: 50)
  --body-bytes <n>   synthetic body size per event line (default: 200)
  --attachments <n>  synthetic attachment refs on final message (default: 0)
  --seed <n>         deterministic provider seed (default: 42)
  --out-dir <path>   report output directory (default: artifacts/benchmarks)
  --keep             keep temp homes for debugging
  --help             show this help`);
}

function parseArgs(argv) {
  const options = {
    scenario: 'all',
    events: 100,
    runs: 1,
    delayMs: 50,
    bodyBytes: 200,
    attachments: 0,
    seed: 42,
    outDir: DEFAULT_OUT_DIR,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    switch (arg) {
      case '--scenario': options.scenario = next(); break;
      case '--events': options.events = Number(next()); break;
      case '--runs': options.runs = Number(next()); break;
      case '--delay-ms': options.delayMs = Number(next()); break;
      case '--body-bytes': options.bodyBytes = Number(next()); break;
      case '--attachments': options.attachments = Number(next()); break;
      case '--seed': options.seed = Number(next()); break;
      case '--out-dir': options.outDir = next(); break;
      case '--keep': options.keep = true; break;
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
        process.exit(2);
    }
  }
  if (!Number.isFinite(options.events) || options.events < 1) {
    console.error('--events must be a positive integer');
    process.exit(2);
  }
  if (!Number.isFinite(options.runs) || options.runs < 1) {
    console.error('--runs must be a positive integer');
    process.exit(2);
  }
  const wanted = options.scenario === 'all' ? null : new Set(options.scenario.split(',').map((id) => id.trim()));
  const selected = wanted ? SCENARIOS.filter((scenario) => wanted.has(scenario.id)) : SCENARIOS;
  if (wanted && selected.length !== wanted.size) {
    const found = new Set(selected.map((scenario) => scenario.id));
    const missing = [...wanted].filter((id) => !found.has(id));
    console.error(`Unknown scenario id(s): ${missing.join(', ')}`);
    process.exit(2);
  }
  return { options, selected };
}

const createdHomes = [];
let exitCode = 0;

function cleanupAll() {
  while (createdHomes.length > 0) {
    const home = createdHomes.pop();
    removeTempHome(home);
  }
}

process.on('SIGINT', () => { cleanupAll(); process.exit(130); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(143); });

function checkThresholds(thresholds, summary) {
  const violations = [];
  const checks = [];
  const measure = {
    maxDurationMs: summary.phases?.scenarioTotalMs,
    maxDiskBytes: summary.disk?.totalBytes,
    maxRssBytes: summary.rss?.peakBytes,
    minEventCount: summary.events?.all ?? summary.events?.after ?? summary.events?.parent,
  };
  for (const [key, limit] of Object.entries(thresholds)) {
    const actual = measure[key];
    if (actual == null) {
      checks.push({ key, limit, actual: null, ok: true, note: 'not measured' });
      continue;
    }
    const ok = key.startsWith('min') ? actual >= limit : actual <= limit;
    checks.push({ key, limit, actual, ok });
    if (!ok) violations.push({ key, limit, actual });
  }
  return { violations, checks };
}

function summaryMarkdown(summary) {
  const lines = [
    `# DS-37 Benchmark: ${summary.scenario}`,
    '',
    `- timestamp: ${summary.timestamp}`,
    `- host: ${summary.host.platform}/${summary.host.arch}, node ${summary.host.node}`,
    `- options: events=${summary.options.events}, runs=${summary.options.runs}, delayMs=${summary.options.delayMs}, bodyBytes=${summary.options.bodyBytes}, attachments=${summary.options.attachments}, seed=${summary.options.seed}`,
    '',
    '## Metrics',
    '',
    '| metric | value |',
    '| --- | --- |',
  ];
  for (const [key, value] of Object.entries(summary.phases || {})) lines.push(`| ${key} | ${value} ms |`);
  for (const [label, stats] of Object.entries(summary.latencies || {})) {
    lines.push(`| latency ${label} p50 | ${stats.p50?.toFixed?.(1) ?? stats.p50} ms |`);
    lines.push(`| latency ${label} p95 | ${stats.p95?.toFixed?.(1) ?? stats.p95} ms |`);
  }
  for (const [key, value] of Object.entries(summary.disk || {})) lines.push(`| disk ${key} | ${value} |`);
  for (const [key, value] of Object.entries(summary.rss || {})) lines.push(`| rss ${key} | ${value} |`);
  for (const [key, value] of Object.entries(summary.events || {})) lines.push(`| events ${key} | ${value} |`);
  if (summary.run) {
    for (const [key, value] of Object.entries(summary.run)) lines.push(`| run ${key} | ${String(value)} |`);
  }
  lines.push('', '## Thresholds', '', '| key | limit | actual | ok |', '| --- | --- | --- | --- |');
  for (const check of summary.thresholdChecks || []) {
    lines.push(`| ${check.key} | ${check.limit} | ${check.actual ?? 'n/a'} | ${check.ok ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', `## Verdict`, '', `**${summary.passed ? 'PASS' : 'FAIL'}**`);
  if (summary.errors?.length) {
    lines.push('', '## Errors', '');
    for (const error of summary.errors) lines.push(`- ${error}`);
  }
  return lines.join('\n') + '\n';
}

async function runScenario(scenario, options) {
  const { home, configDir } = setupTempHome();
  createdHomes.push(home);
  const port = 33000 + Math.floor(Math.random() * 10000);
  const providerEnv = {
    FAKE_PROVIDER_EVENTS: String(options.events),
    FAKE_PROVIDER_DELAY_MS: String(options.delayMs),
    FAKE_PROVIDER_BODY_BYTES: String(options.bodyBytes),
    FAKE_PROVIDER_ATTACHMENT_REFS: String(options.attachments),
    FAKE_PROVIDER_SEED: String(options.seed),
  };

  const metrics = { httpLatencies: {} };
  const rssSamples = [];
  let rssPeak = 0;

  const ctx = {
    options,
    home,
    configDir,
    port,
    request,
    sleep,
    waitFor,
    wsConnect,
    createSession,
    submitMessage,
    getEvents,
    waitForRunTerminal,
    providerEnv,
    metrics,
    server: null,
    currentServer: () => ctx.server,
    startServer: async (overrides = {}) => {
      ctx.server = await startServer({
        home,
        port,
        envOverrides: { ...providerEnv, ...(overrides.envOverrides || {}) },
      });
      return ctx.server;
    },
    stopServer: async (server = ctx.server) => {
      await stopServer(server);
      ctx.server = null;
    },
    track: async (label, fn) => {
      const started = Date.now();
      const result = await fn();
      (metrics.httpLatencies[label] ??= []).push(Date.now() - started);
      return result;
    },
    log: (message) => console.log(`[${scenario.id}] ${message}`),
  };

  const sampler = setInterval(() => {
    const pid = ctx.server?.pid;
    if (!pid) return;
    const bytes = sampleRssBytes(pid);
    if (bytes != null) {
      rssSamples.push(bytes);
      rssPeak = Math.max(rssPeak, bytes);
    }
  }, 500);
  sampler.unref?.();

  const summary = {
    task: 'DS-37',
    scenario: scenario.id,
    description: scenario.description,
    timestamp: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    options: { ...options, scenario: scenario.id },
    passed: false,
    thresholds: scenario.thresholds,
    thresholdChecks: [],
    violations: [],
    phases: {},
    latencies: {},
    events: {},
    disk: {},
    rss: {},
    run: null,
    errors: [],
    tempHome: home,
  };

  try {
    const bootStarted = Date.now();
    await ctx.startServer();
    summary.phases.serverBootMs = Date.now() - bootStarted;
    const fragment = await scenario.run(ctx);
    if (fragment.phases) Object.assign(summary.phases, fragment.phases);
    if (fragment.events) Object.assign(summary.events, fragment.events);
    if (fragment.run) summary.run = fragment.run;
    summary.passed = true;
  } catch (error) {
    summary.passed = false;
    summary.errors.push(error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error));
    console.error(`[${scenario.id}] scenario failed: ${error?.message || error}`);
  } finally {
    clearInterval(sampler);
    if (ctx.server) await stopServer(ctx.server);
    await sleep(200);

    const history = dirBytes(join(configDir, 'chat-history'));
    const runs = dirBytes(join(configDir, 'chat-runs'));
    summary.disk = {
      historyBytes: history.bytes,
      historyFiles: history.files,
      runsBytes: runs.bytes,
      runsFiles: runs.files,
      totalBytes: history.bytes + runs.bytes,
    };
    summary.rss = {
      peakBytes: rssPeak,
      finalBytes: rssSamples.length > 0 ? rssSamples[rssSamples.length - 1] : null,
      samples: rssSamples.length,
    };
    for (const [label, samples] of Object.entries(metrics.httpLatencies)) {
      summary.latencies[label] = percentiles(samples);
    }
    const thresholdResult = checkThresholds(scenario.thresholds, summary);
    summary.thresholdChecks = thresholdResult.checks;
    summary.violations = thresholdResult.violations;
    if (summary.passed && thresholdResult.violations.length > 0) {
      summary.passed = false;
    }

    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(join(options.outDir, `${scenario.id}.json`), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    writeFileSync(join(options.outDir, `${scenario.id}.md`), summaryMarkdown(summary), 'utf8');

    if (!options.keep) {
      const removed = createdHomes.pop();
      removeTempHome(removed);
    }
  }
  return summary;
}

async function main() {
  const { options, selected } = parseArgs(process.argv.slice(2));
  console.log(`DS-37 benchmark harness: ${selected.map((scenario) => scenario.id).join(', ')} (events=${options.events}, runs=${options.runs})`);

  const reports = [];
  for (const scenario of selected) {
    const started = Date.now();
    const summary = await runScenario(scenario, options);
    summary.durationMs = Date.now() - started;
    reports.push(summary);
    const verdict = summary.passed ? 'PASS' : 'FAIL';
    console.log(`[ds-37] ${scenario.id}: ${verdict} (${summary.durationMs} ms, disk=${summary.disk.totalBytes} B, rssPeak=${summary.rss.peakBytes ?? 'n/a'} B)`);
    if (!summary.passed) exitCode = 1;
  }

  const index = {
    task: 'DS-37',
    timestamp: new Date().toISOString(),
    total: reports.length,
    passed: reports.filter((report) => report.passed).length,
    failed: reports.filter((report) => !report.passed).length,
    scenarios: reports.map((report) => ({
      id: report.scenario,
      passed: report.passed,
      durationMs: report.durationMs,
      violations: report.violations,
      reportJson: join(options.outDir, `${report.scenario}.json`),
      reportMd: join(options.outDir, `${report.scenario}.md`),
    })),
  };
  writeFileSync(join(options.outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  console.log(`DS-37 benchmark: ${index.passed}/${index.total} passed, reports in ${options.outDir}`);
  if (exitCode !== 0) process.exit(exitCode);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  cleanupAll();
  process.exit(1);
});
