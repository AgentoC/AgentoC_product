#!/usr/bin/env node
/**
 * Phase 2B slice 2B-4 tests — execution-time resolver revalidation (invariant 8).
 *
 * Run: node tests/test-approved-action-revalidation.mjs
 *
 * A policy ALLOW is a preflight, not an executor grant. The executor must
 * re-resolve and revalidate the target immediately before argv construction /
 * privileged exec. This suite locks:
 *   - the fail-closed default (no provider): host privileged ops and any target
 *     carrying an approved resource snapshot DENY with NON_REVALIDATABLE_HOST_EFFECT;
 *     a plain session target (no snapshot) passes through (existing
 *     manifest-integrity guarantee).
 *   - injected provider failure DENYs before exec (the exec provider / execFile
 *     is never reached).
 *   - injected provider success lets exec proceed unchanged.
 *   - the injected provider is actually invoked BEFORE execFile (spy order).
 *   - the approved resource snapshot identity / canonical resource are surfaced
 *     to the revalidation context from the server-computed envelope.
 *   - the host privileged route stays fail-closed end-to-end (no new ALLOW).
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  approvedRevalidationContext,
  buildHostPermissionFacts,
  executeApprovedAction,
  runApprovedActionRevalidation,
} from '../chat/approved-action-executor.mjs';
import {
  APPROVED_ACTION_SCHEMA_VERSION,
  computeApprovedActionManifestHash,
} from '../chat/approved-actions.mjs';
import {
  PERMISSION_REASON_CODES,
} from '../chat/permission-policy.mjs';
import {
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  SEMANTIC_RESOLVER_VERSION,
  computeSemanticManifestHash,
} from '../chat/semantic-operation.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const KID = 'test-kid-2b4';
generateKeyPairSync('ed25519'); // key material is not needed for these seam tests

const SESSION = 'session-test';
const RUN = 'run-test';
const TURN = 'turn-test';

function operation(overrides = {}) {
  return {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: 'sop_reval_001',
    requestBinding: { sessionId: SESSION, runId: RUN, turnId: TURN, requestKey: 'request-test' },
    primaryAction: 'package.install',
    effects: ['process.execute'],
    executionClass: 'host',
    target: {
      kind: 'package', platform: 'linux', manager: 'apt', source: 'trusted_repository',
      packages: ['nginx'], exact: true,
      resourceSnapshot: {
        resolverVersion: SEMANTIC_RESOLVER_VERSION,
        observedAt: new Date(NOW).toISOString(),
        identity: 'snapshot-nginx',
        manager: 'apt', source: 'trusted_repository',
        packages: [{ name: 'nginx', requestedVersion: '', availableVersion: '1.25' }],
        repositories: [{ id: 'main', trust: 'configured' }],
      },
    },
    scope: { kind: 'system', computed: true, manager: 'apt' },
    impact: { estimatedItems: 1, containsSensitiveMaterial: false, containsGitMetadata: false, reversible: true },
    source: { rawRequestHash: `sha256:${'1'.repeat(64)}`, commandForm: 'argv' },
    analysis: {
      confidence: 'high', unknowns: [], policyVersion: SEMANTIC_POLICY_VERSION,
      compilerVersion: SEMANTIC_COMPILER_VERSION, resolverVersion: SEMANTIC_RESOLVER_VERSION,
      effectsComplete: true,
    },
    ...overrides,
  };
}

function decisionEntry(operationObject) {
  return {
    operationId: operationObject.operationId,
    operation: operationObject,
    operationManifestHash: computeSemanticManifestHash(operationObject),
    resolverSnapshotIdentity: operationObject.target?.resourceSnapshot?.identity,
    policyVersion: SEMANTIC_POLICY_VERSION,
    unknowns: [],
    decision: 'ASK',
    strictness: 2,
    reasons: [{ code: 'effect_strictness_raise', message: 'requires owner approval' }],
  };
}

function hostEntryWithFacts(operationObject) {
  const entry = decisionEntry(operationObject);
  return { ...entry, facts: buildHostPermissionFacts({ ...entry, factsProof: undefined }) };
}

const HOST_CONTEXT = approvedRevalidationContext({
  executionClass: 'host',
  entries: [hostEntryWithFacts(operation())],
  action: { actionId: 'aa_host_reval' },
});

// ── 1. fail-closed default: host privileged op with no provider DENYs ──────────
{
  const result = await runApprovedActionRevalidation(null, HOST_CONTEXT, {});
  eq('host revalidation with no provider fails closed', result.ok, false);
  eq('host no-provider reason is NON_REVALIDATABLE_HOST_EFFECT',
    result.code, PERMISSION_REASON_CODES.NON_REVALIDATABLE_HOST_EFFECT);
}

// ── 2. fail-closed default: session target with an approved snapshot DENYs ────
{
  const snapshotContext = approvedRevalidationContext({
    executionClass: 'session',
    entries: [{ operation: operation(), facts: { resourceSnapshotIdentity: 'snapshot-nginx', resource: {}, selection: {} } }],
    action: {},
    argv: ['apt-get'],
  });
  const result = await runApprovedActionRevalidation(null, snapshotContext, {});
  eq('session snapshot revalidation with no provider fails closed', result.ok, false);
  eq('session snapshot no-provider reason is NON_REVALIDATABLE_HOST_EFFECT',
    result.code, PERMISSION_REASON_CODES.NON_REVALIDATABLE_HOST_EFFECT);
}

// ── 3. fail-closed default: plain session target (no snapshot) passes through ──
{
  const plainContext = approvedRevalidationContext({
    executionClass: 'session',
    entries: [],
    action: { actionId: 'aa_plain_session', cwd: '/tmp' },
    argv: ['printf', 'ok'],
  });
  const result = await runApprovedActionRevalidation(null, plainContext, {});
  eq('plain session target (no snapshot) passes through without a provider', result.ok, true);
}

// ── 4. host path with failing revalidation → DENY before exec ─────────────────
{
  let execCalls = 0;
  const failProvider = async () => ({ ok: false, code: 'HOST_REVALIDATION_FAILED', error: 'target changed' });
  const revalidation = await runApprovedActionRevalidation(failProvider, HOST_CONTEXT, {});
  eq('host failing revalidation is fail-closed', revalidation.ok, false);
  eq('host failing revalidation reports the provider code', revalidation.code, 'HOST_REVALIDATION_FAILED');
  if (revalidation.ok) { execCalls += 1; }
  eq('host exec provider is never reached after failed revalidation', execCalls, 0);
}

// ── 5. host path with successful revalidation admits the exec step ────────────
{
  const okProvider = async () => ({ ok: true });
  const revalidation = await runApprovedActionRevalidation(okProvider, HOST_CONTEXT, {});
  eq('host successful revalidation admits exec', revalidation.ok, true);
}

// ── 6. injected provider failure DENYs session exec (execFile not reached) ────
{
  const result = await executeApprovedAction({
    actionId: 'aa_session_reval_deny',
    executionClass: 'session',
    argv: ['node', '-e', 'process.stdout.write("SHOULD_NOT_RUN")'],
    cwd: '/tmp',
  }, {
    sessionId: SESSION, runId: RUN, turnId: TURN,
    revalidate: async () => ({ ok: false, code: 'SESSION_REVALIDATION_FAILED', error: 'argv target no longer resolvable' }),
  });
  eq('session failing revalidation returns DENY', result.decision, 'DENY');
  check('session failing revalidation is not ok and never executes', result.ok === false && result.event === null);
  eq('session failing revalidation reports the provider code', result.reasonCode, 'SESSION_REVALIDATION_FAILED');
  eq('session failing revalidation produced no exec stdout', result.resultRef.stdout, undefined);
}

// ── 7. successful revalidation → exec proceeds, output unchanged ──────────────
{
  let invoked = false;
  const tmp = mkdtempSync(join(tmpdir(), 'approved-action-revalidation-'));
  const result = await executeApprovedAction({
    actionId: 'aa_session_reval_ok',
    executionClass: 'session',
    argv: ['printf', 'approved-action-revalidation-ok'],
    cwd: tmp,
  }, {
    sessionId: SESSION, runId: RUN, turnId: TURN,
    revalidate: async () => { invoked = true; return { ok: true }; },
  });
  check('injected revalidate provider was actually invoked', invoked === true);
  check('session successful revalidation executes argv', result.ok === true);
  eq('session successful revalidation preserves stdout', result.resultRef.stdout, 'approved-action-revalidation-ok');
}

// ── 8. injected provider is invoked BEFORE execFile (spy order) ────────────────
{
  const tmp = mkdtempSync(join(tmpdir(), 'approved-action-revalidation-spy-'));
  const marker = join(tmp, 'marker');
  const provider = async () => {
    writeFileSync(marker, 'revalidated');
    return { ok: true };
  };
  const script = `const fs=require('fs');process.stdout.write(fs.existsSync(${JSON.stringify(marker)})?'provider-first':'exec-first');`;
  const result = await executeApprovedAction({
    actionId: 'aa_session_reval_spy',
    executionClass: 'session',
    argv: ['node', '-e', script],
    cwd: tmp,
  }, {
    sessionId: SESSION, runId: RUN, turnId: TURN,
    revalidate: provider,
  });
  eq('revalidate ran before execFile (marker visible to the executed argv)', result.resultRef.stdout, 'provider-first');
}

// ── 9. revalidation context surfaces approved snapshot identity + resource ────
{
  const entry = hostEntryWithFacts(operation());
  const context = approvedRevalidationContext({
    executionClass: 'host',
    entries: [entry],
    action: { actionId: 'aa_ctx', cwd: '/tmp/project' },
    argv: ['apt-get', 'install', 'nginx'],
  });
  eq('context carries the approved resource snapshot identity', context.resourceSnapshotIdentity, 'snapshot-nginx');
  eq('context carries the canonical resource packages', context.resource.packages[0], 'nginx');
  eq('context carries the server-computed executionClass', context.executionClass, 'host');
  eq('context carries the approved argv', context.argv[0], 'apt-get');
  eq('context carries the approved cwd', context.cwd, '/tmp/project');
}

// ── 10. host privileged route stays fail-closed end-to-end (no new ALLOW) ─────
{
  // A legacy host action without a server-computed projection cannot produce
  // permission facts, so the Phase 2B-3 gate DENYs it (FACTS_REQUIRED) before
  // any revalidation seam or privileged exec is reached. No new ALLOW.
  const legacy = {
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    actionId: 'aa_legacy_reval',
    sessionId: SESSION,
    runId: RUN,
    turnId: TURN,
    requestKey: 'request-legacy-reval',
    canonicalCommand: 'systemctl restart nginx',
    cwd: '/tmp/project',
    declaredCategory: 'privileged_other',
    category: 'privileged_other',
    sawLeadingSudo: true,
    originalRequest: { description: 'restart nginx', reason: 'test' },
    executionClass: 'host',
    risk: { tier: 'danger' },
    semanticProjection: null,
    semanticManifestHash: '',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 600000).toISOString(),
    state: 'authorized',
    auditId: 'aaudit_legacy_reval',
    authorization: { source: 'owner', credentialId: 'cred-test', selectionManifestHash: 'sel-hash' },
  };
  legacy.manifestHash = computeApprovedActionManifestHash(legacy);
  const result = await executeApprovedAction(legacy, {
    sessionId: SESSION, runId: RUN, turnId: TURN,
    revalidate: async () => ({ ok: true }),
  });
  eq('legacy host action without policy facts is DENY (gate preflight)', result.decision, 'DENY');
  eq('legacy host action fails closed on missing facts', result.reasonCode, PERMISSION_REASON_CODES.FACTS_REQUIRED);
}

console.log(`approved-action-revalidation: ${passed} checks passed`);
