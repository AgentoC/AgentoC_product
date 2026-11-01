#!/usr/bin/env node
// 24h summary for the background AI operation ledger (DS-03).
//
// Reads the daily operation-ledger JSONL files and prints a human-readable
// rollup: per-operation call counts (succeeded / failed / timeout / skipped),
// success rate, duration stats (avg / p95 / max), error-code and skip-reason
// breakdowns, usage token totals, and the most recent failures.
//
// The ledger never contains full prompts or message bodies — only length,
// hash and truncated previews — so this summary is safe to read and share.
//
// Usage:
//   node scripts/operation-ledger-summary-24h.mjs [--days 1] [--json]
//       [--ledger-dir DIR] [--operation KEY] [--error-code CODE] [--kind KIND]

import { queryOperationLedger } from '../chat/operation-ledger.mjs';

function parseArgs(argv) {
  const out = { days: 1, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') out.days = Number.parseInt(argv[i + 1], 10) || 1;
    else if (arg === '--json') out.json = true;
    else if (arg === '--ledger-dir') out.ledgerDir = argv[i + 1];
    else if (arg === '--operation') out.operation = argv[i + 1];
    else if (arg === '--error-code') out.errorCode = argv[i + 1];
    else if (arg === '--kind') out.kind = argv[i + 1];
  }
  return out;
}

function formatMs(value) {
  if (value === null || value === undefined) return '-';
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function printHumanSummary(summary) {
  const { window, operations, byKind, byErrorCode, byReason, usageTotals, recentFailures } = summary;
  console.log(`Operation ledger ${window.start} → ${window.end} (${window.days}d)`);
  console.log(`Events scanned: ${summary.eventsScanned}, files: ${summary.filesScanned}`);
  console.log('');

  console.log('By kind:');
  for (const [kind, count] of byKind) {
    console.log(`  ${kind.padEnd(12)} ${count}`);
  }
  console.log('');

  console.log('By operation:');
  if (operations.length === 0) {
    console.log('  (no terminal events in window)');
  }
  for (const op of operations) {
    const successRate = op.successRate === null ? '-' : `${Math.round(op.successRate * 100)}%`;
    console.log(
      `  ${op.key.padEnd(28)} calls=${op.count} ok=${op.succeeded} failed=${op.failed}`
      + ` timeout=${op.timeout} skipped=${op.skipped} rate=${successRate}`
      + ` avg=${formatMs(op.avgDurationMs)} p95=${formatMs(op.p95DurationMs)} max=${formatMs(op.maxDurationMs)}`,
    );
  }
  console.log('');

  if (byErrorCode.length > 0) {
    console.log('By error code:');
    for (const [code, count] of byErrorCode) {
      console.log(`  ${code.padEnd(16)} ${count}`);
    }
    console.log('');
  }

  if (byReason.length > 0) {
    console.log('By skip reason:');
    for (const [reason, count] of byReason) {
      console.log(`  ${reason.padEnd(24)} ${count}`);
    }
    console.log('');
  }

  console.log('Usage totals (from inline usage on events):');
  console.log(`  inputTokens=${usageTotals.inputTokens} outputTokens=${usageTotals.outputTokens}`
    + ` cachedInputTokens=${usageTotals.cachedInputTokens} reasoningTokens=${usageTotals.reasoningTokens}`);
  console.log(`  costUsd=${usageTotals.costUsd.toFixed(6)} estimatedCostUsd=${usageTotals.estimatedCostUsd.toFixed(6)}`);
  console.log('');

  if (recentFailures.length > 0) {
    console.log(`Recent failures (${recentFailures.length}):`);
    for (const failure of recentFailures) {
      console.log(
        `  ${failure.ts} ${failure.kind}:${failure.errorCode || 'unknown'} ${failure.operation}`
        + ` [${failure.provider || '-'}/${failure.model || '-'}] ${failure.operationId}`,
      );
      if (failure.errorMessage) {
        console.log(`    ${failure.errorMessage}`);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const summary = await queryOperationLedger({
    days: args.days,
    operation: args.operation,
    errorCode: args.errorCode,
    kind: args.kind,
    ledgerDir: args.ledgerDir,
  });
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printHumanSummary(summary);
}

main().catch((error) => {
  console.error(`[operation-ledger-summary] Failed: ${error.message}`);
  process.exit(1);
});
