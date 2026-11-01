#!/usr/bin/env node
// P1-D: control-plane health projection regression tests.
//
// /healthz must reflect whether the control plane is fully usable, not just
// whether the Node event loop is alive. The concrete degraded detector is the
// CLI identity transport: when the socket this process bound is gone, local
// CLI auth silently breaks while HTTP keeps answering 200 — /healthz must flip
// to degraded (503) instead of a false-green 200.
import assert from 'node:assert/strict';
import {
  HEALTH_DEGRADED,
  HEALTH_READY,
  computeControlPlaneHealth,
} from '../lib/control-plane-health.mjs';

async function main() {
  // ── 1) healthy CLI transport -> 200 ready ────────────────────────────────
  {
    const health = computeControlPlaneHealth({ cliTransport: HEALTH_READY });
    assert.equal(health.httpCode, 200);
    assert.equal(health.ok, true);
    assert.equal(health.status, HEALTH_READY);
    assert.equal(health.cliTransport, HEALTH_READY);
    assert.equal(health.http, HEALTH_READY);
  }

  // ── 2) degraded CLI transport -> 503 degraded ────────────────────────────
  {
    const health = computeControlPlaneHealth({ cliTransport: HEALTH_DEGRADED });
    assert.equal(health.httpCode, 503);
    assert.equal(health.ok, false);
    assert.equal(health.status, HEALTH_DEGRADED);
    assert.equal(health.cliTransport, HEALTH_DEGRADED);
    // The HTTP server itself is still alive; only the CLI channel is down.
    assert.equal(health.http, HEALTH_READY);
  }

  // ── 3) missing/unknown transport defaults to degraded (fail-closed) ──────
  {
    const health = computeControlPlaneHealth({});
    assert.equal(health.httpCode, 503, 'unknown transport must fail closed');
    assert.equal(health.status, HEALTH_DEGRADED);
    assert.equal(health.ok, false);
  }

  // ── 4) anything other than 'ready' degrades ──────────────────────────────
  {
    const health = computeControlPlaneHealth({ cliTransport: 'unbound' });
    assert.equal(health.httpCode, 503);
    assert.equal(health.status, HEALTH_DEGRADED);
  }

  console.log('test-control-plane-health: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
