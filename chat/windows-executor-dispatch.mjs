/**
 * Windows named-pipe executor semantic dispatch.
 *
 * After the peer gate admits the controlled executor, a semantic-exec request
 * (a signed capability) is dispatched here. The chain mirrors the Linux
 * privileged-executor's semantic route but runs on the Windows transport:
 *   1. signed capability verification (ed25519 via server-owned public key),
 *   2. one-shot nonce consumption (replay),
 *   3. target revalidation against current Windows facts,
 *   4. fixed-argv execution (no shell, no requester-provided command/argv/cwd).
 *
 * Every seam is injectable so the chain is unit-testable and a live Windows
 * test can substitute a safe target without installing software.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { SEMANTIC_ADAPTER_MSI_INSTALL_V1, SEMANTIC_ADAPTER_WINGET_INSTALL_V1, revalidateWindowsMsiInstall, revalidateWindowsWingetInstall } from './semantic-windows-adapter.mjs';
import { SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO, revalidateSemanticCapability, verifySemanticCapability } from './semantic-capability.mjs';
import {
  PERMISSION_MODES,
  CAPABILITY_AUTHORIZATION_CLASSES,
  PERMISSION_REASON_CODES,
  PERMISSION_REASON_MESSAGES,
  buildPermissionFacts,
  evaluatePermissionOperation,
  evaluatePermissionSet,
} from './permission-policy.mjs';
import { computeSemanticManifestHash } from './semantic-operation.mjs';
import { resolveWindowsSystemPaths } from './windows-system-paths.mjs';

const defaultExecFile = promisify(execFileCallback);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, error) {
  return { ok: false, code, error };
}

async function defaultRevalidate(capability, { execFile, artifactFacts } = {}) {
  const adapter = trimString(capability.adapter);
  if (adapter === SEMANTIC_ADAPTER_WINGET_INSTALL_V1) {
    if (typeof execFile !== 'function') return fail('WINDOWS_REVALIDATION_REQUIRED', 'winget metadata revalidation provider is required');
    return revalidateWindowsWingetInstall(capability, { execFile });
  }
  if (adapter === SEMANTIC_ADAPTER_MSI_INSTALL_V1) {
    if (typeof artifactFacts !== 'function') return fail('WINDOWS_REVALIDATION_REQUIRED', 'MSI artifact revalidation provider is required');
    return revalidateWindowsMsiInstall(capability, { artifactFacts });
  }
  return fail('SEMANTIC_CAPABILITY_ADAPTER_DENIED', `unsupported Windows adapter: ${adapter}`);
}

async function defaultExecInvocation(invocation, { execFile, timeoutMs = 120_000 } = {}) {
  if (typeof execFile !== 'function' || !invocation || !trimString(invocation.executable)) {
    return fail('WINDOWS_EXECUTOR_DISPATCH_FAILED', 'fixed-argv execution is unavailable');
  }
  const cwd = invocation.cwd || resolveWindowsSystemPaths()?.system32;
  if (!cwd) return fail('WINDOWS_EXECUTOR_DISPATCH_FAILED', 'Windows system working directory is unavailable');
  try {
    const result = await execFile(invocation.executable, Array.isArray(invocation.argv) ? invocation.argv : [], {
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      code: '',
      result: {
        exitCode: 0,
        stdout: String(result?.stdout || ''),
        stderr: String(result?.stderr || ''),
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: 'WINDOWS_EXECUTOR_EXEC_FAILED',
      error: error?.message || String(error),
      result: {
        exitCode: error?.code ?? -1,
        stdout: String(error?.stdout || ''),
        stderr: String(error?.stderr || ''),
      },
    };
  }
}

/**
 * Phase 2B-5 — Phase 2A permission policy gate for the Windows dispatch chain.
 *
 * After the signed semantic capability verifies (existing step) and immediately
 * before target revalidation / fixed-argv exec, an additional authoritative
 * policy gate runs `evaluatePermissionOperation` (or `evaluatePermissionSet`
 * for a multi-operation envelope). The gate is fail-closed:
 *
 *   - no server-computed operation/facts envelope, or an unbuildable one, is
 *     DENIED (`FACTS_REQUIRED`);
 *   - host-capable facts without a trusted resolver proof are DENIED
 *     (`FACTS_PROOF_REQUIRED`), and non-revalidatable host effects are DENIED
 *     (`NON_REVALIDATABLE_HOST_EFFECT`);
 *   - a default ALLOW is never a grant for a host effect: only an exact
 *     Phase 2A capability match (`capabilityMatched === true`) yields ALLOW;
 *   - ASK (owner checkpoint without an exact grant) blocks dispatch — the
 *     executor never proceeds on ASK.
 *   - a dispatch with no `policyGate` and no `policyContext` is DENIED
 *     (`POLICY_GATE_REQUIRED`): every operation this dispatch can admit is
 *     host-capable, so the gate is mandatory, not opt-in.
 *
 * The `policyGate`/`policyContext` options are how a caller wires the server
 * resolver envelope. A caller that holds the signed facts/proof and an exact
 * Phase 2A capability passes `policyContext`; one with a custom gate passes
 * `policyGate`. A dispatch that wires neither is rejected before revalidation.
 */

/**
 * Build the server-computed `PermissionFacts` envelope for a win32 package
 * operation, derived ONLY from the capability's bound operation / resolver
 * snapshot / Windows facts — never from requester-declared scope fields.
 *
 * Every value here is a server-owned field: the operation target/resource
 * snapshot (injected by the resolver) and the capability's canonical
 * `adapterInput`. Any platform/executionClass mismatch or missing/unknown fact
 * makes this throw; the caller treats a throw as DENY (fail closed).
 */
export function buildWindowsDispatchPermissionFacts(operation, capability = {}) {
  const target = isPlainObject(operation?.target) ? operation.target : {};
  const snapshot = isPlainObject(target.resourceSnapshot) ? target.resourceSnapshot : {};
  const impact = isPlainObject(operation?.impact) ? operation.impact : {};
  const bound = Array.isArray(capability?.operations) ? capability.operations[0] : null;
  const input = isPlainObject(bound?.adapterInput) ? bound.adapterInput : {};

  // Fail-closed platform/executionClass guards. The capability was signed
  // against a win32/host bound operation; a re-resolved operation that
  // disagrees (platform/executionClass smuggling) is DENIED before facts can
  // authorize anything.
  if (trimString(bound?.platform) !== 'win32' || trimString(target?.platform) !== 'win32') {
    throw new Error('Windows dispatch permission facts require a win32 target platform');
  }
  if (trimString(bound?.executionClass) !== 'host' || trimString(operation?.executionClass) !== 'host') {
    throw new Error('Windows dispatch permission facts require a host execution class');
  }

  const kind = trimString(target?.kind);
  let resource;
  let selection;
  if (kind === 'package') {
    const packages = Array.isArray(input?.packages) && input.packages.length > 0
      ? input.packages.map(trimString).filter(Boolean)
      : (Array.isArray(snapshot?.packages) ? snapshot.packages.map((entry) => trimString(entry?.name)).filter(Boolean) : []);
    resource = {
      manager: trimString(input?.manager) || trimString(target?.manager) || 'unknown',
      source: trimString(input?.source) || trimString(target?.source) || 'unknown',
    };
    if (packages.length) resource.packages = packages;
    selection = {
      packages: packages.length ? packages : ['unresolved'],
      exact: target?.exact === true,
    };
  } else if (kind === 'package_artifact') {
    resource = {
      manager: trimString(input?.manager) || trimString(target?.manager) || 'msiexec',
      source: 'local_artifact',
      artifact: trimString(input?.artifactPath) || trimString(target?.root) || 'unknown',
      digest: trimString(input?.artifactDigest) || trimString(snapshot?.artifactDigest) || 'unknown',
    };
    selection = {
      artifact: trimString(input?.artifactPath) || trimString(target?.root) || 'unknown',
      exact: target?.exact === true,
    };
  } else {
    throw new Error(`Windows dispatch permission facts require a package or package_artifact target, got ${kind || 'unknown'}`);
  }

  return buildPermissionFacts({
    operation,
    executionClass: trimString(operation?.executionClass) || 'host',
    impact: {
      reversible: impact.reversible === true,
      containsSensitiveMaterial: impact.containsSensitiveMaterial === true,
      containsGitMetadata: impact.containsGitMetadata === true,
    },
    resource,
    selection,
    resourceSnapshotIdentity: trimString(snapshot?.identity) || trimString(bound?.resourceSnapshotIdentity),
    effectEnumerationProof: computeSemanticManifestHash(operation),
    hostEffects: { dynamic: false, revalidatable: true },
    unknowns: Array.isArray(operation?.analysis?.unknowns) ? [...operation.analysis.unknowns] : [],
  });
}

/**
 * Build a fail-closed Phase 2A policy gate for the Windows dispatch chain.
 *
 * The returned gate is a function `async (input) => ({ ok, code?, error?,
 * decision? })`. Its default configuration is STANDARD mode with no injected
 * verifier/proof and no capability — so a host-capable operation without a
 * trusted proof is DENIED (`FACTS_PROOF_REQUIRED`) and an unbuildable envelope
 * is DENIED (`FACTS_REQUIRED`). Only an exact Phase 2A capability match
 * (`capabilityMatched === true`) yields `ok: true`.
 *
 * `input.entries` (array of `{ operation, facts }`) evaluates as a permission
 * set (`evaluatePermissionSet`); otherwise `input.operation` + `input.facts` is
 * evaluated as a single operation.
 */
export function createWindowsDispatchPolicyGate({
  mode = PERMISSION_MODES.STANDARD,
  capability = null,
  verifyFactsProof = null,
  verifyGrantProof = null,
  useNonce = '',
  usageConsumed = 0,
  consumedUseNonces = [],
  now = Date.now(),
} = {}) {
  return async function windowsDispatchPolicyGate(input = {}) {
    const current = {
      mode: input?.mode ?? mode,
      capability: input?.capabilityGrant ?? input?.capability ?? capability,
      verifyFactsProof: input?.verifyFactsProof ?? verifyFactsProof,
      verifyGrantProof: input?.verifyGrantProof ?? verifyGrantProof,
      useNonce: input?.useNonce ?? useNonce,
      usageConsumed: input?.usageConsumed ?? usageConsumed,
      consumedUseNonces: input?.consumedUseNonces ?? consumedUseNonces,
      now: input?.now ?? now,
    };
    const entries = Array.isArray(input?.entries) && input.entries.length > 0 ? input.entries : null;
    const operation = input?.operation ?? null;
    const facts = input?.facts ?? null;
    if (!entries && (!operation || !facts)) {
      return {
        ok: false,
        code: PERMISSION_REASON_CODES.FACTS_REQUIRED,
        error: 'Windows dispatch permission gate requires server-computed operation and permission facts',
        decision: 'DENY',
      };
    }
    let evaluated;
    try {
      evaluated = entries
        ? evaluatePermissionSet(entries, {
            mode: current.mode, capability: current.capability, now: current.now,
            verifyFactsProof: current.verifyFactsProof, verifyGrantProof: current.verifyGrantProof,
            useNonce: current.useNonce, usageConsumed: current.usageConsumed,
            consumedUseNonces: current.consumedUseNonces,
          })
        : evaluatePermissionOperation({
            operation, facts,
            mode: current.mode, capability: current.capability, now: current.now,
            verifyFactsProof: current.verifyFactsProof, verifyGrantProof: current.verifyGrantProof,
            useNonce: current.useNonce, usageConsumed: current.usageConsumed,
            consumedUseNonces: current.consumedUseNonces,
          });
    } catch (error) {
      return {
        ok: false,
        code: PERMISSION_REASON_CODES.OPERATION_INVALID,
        error: `Windows dispatch permission gate evaluation failed: ${error?.message || String(error)}`,
        decision: 'DENY',
      };
    }
    // evaluatePermissionSet returns { decision, results } with no top-level
    // capabilityMatched/reasonCode/reasons. Derive them per-entry so the
    // permission-set envelope can reach ALLOW only when every member is an
    // exact Phase 2A capability match (decision ALLOW + capabilityMatched).
    let capabilityMatched = evaluated.capabilityMatched === true;
    let reasonCode = evaluated.reasonCode || '';
    let reasons = evaluated.reasons || [];
    if (entries) {
      const entryResults = Array.isArray(evaluated.results) ? evaluated.results : [];
      capabilityMatched = entryResults.length > 0
        && entryResults.every((result) => result.decision === 'ALLOW' && result.capabilityMatched === true);
      if (capabilityMatched) {
        reasonCode = entryResults[0]?.reasonCode || PERMISSION_REASON_CODES.CAPABILITY_MATCHED;
      } else {
        // Surface the strongest non-allow reason (DENY beats ASK) so the
        // caller sees why the set was not fully matched.
        const blocker = entryResults.find((result) => result.decision === 'DENY')
          || entryResults.find((result) => result.decision === 'ASK')
          || entryResults[0];
        reasonCode = blocker?.reasonCode || PERMISSION_REASON_CODES.DENY_DEFAULT;
      }
      reasons = entryResults.flatMap((result) => result.reasons || []);
    }
    if (evaluated.decision === 'ALLOW' && capabilityMatched) {
      return { ok: true, code: reasonCode, decision: 'ALLOW', reasons };
    }
    return {
      ok: false,
      code: reasonCode || PERMISSION_REASON_CODES.DENY_DEFAULT,
      error: `Windows dispatch denied by permission policy (${evaluated.decision}): ${PERMISSION_REASON_MESSAGES[reasonCode] || reasonCode || PERMISSION_REASON_MESSAGES[PERMISSION_REASON_CODES.DENY_DEFAULT]}`,
      decision: evaluated.decision,
      reasons,
    };
  };
}

/** Fail-closed default gate: STANDARD mode, no verifier/proof, no capability. */
export const defaultWindowsDispatchPolicyGate = createWindowsDispatchPolicyGate();

function buildCapabilityRevalidationDecisions(capability, policyContext) {
  const entries = Array.isArray(policyContext?.entries) && policyContext.entries.length > 0
    ? policyContext.entries
    : null;
  const operations = entries
    ? entries.map((entry) => entry?.operation)
    : [policyContext?.operation];
  const supportedAdapters = [SEMANTIC_ADAPTER_WINGET_INSTALL_V1, SEMANTIC_ADAPTER_MSI_INSTALL_V1];
  const boundOperations = Array.isArray(capability?.operations) ? capability.operations : [];
  if (boundOperations.length !== 1
    || !supportedAdapters.includes(trimString(capability?.adapter))
    || trimString(boundOperations[0]?.platform) !== 'win32'
    || trimString(boundOperations[0]?.executionClass) !== 'host') {
    return {
      ok: false,
      code: 'SEMANTIC_CAPABILITY_ADAPTER_DENIED',
      error: 'Windows dispatch requires one signed win32 host operation for a supported Windows adapter',
    };
  }
  if (!policyContext || operations.length === 0
    || operations.some((operation) => !operation || typeof operation !== 'object')) {
    return {
      ok: false,
      code: PERMISSION_REASON_CODES.FACTS_REQUIRED,
      error: 'Windows dispatch requires a server-computed operation binding for capability revalidation',
    };
  }
  const decisions = operations.map((operation) => ({
    // Revalidation only needs the canonical resolver-bound operation. The
    // signed capability was originally minted from an owner-approved ASK;
    // never trust a caller-supplied decision field at execution time.
    operation,
    decision: 'ASK',
    operationManifestHash: computeSemanticManifestHash(operation),
  }));
  try {
    const result = revalidateSemanticCapability(capability, decisions);
    return result.ok
      ? { ok: true, code: '' }
      : {
          ok: false,
          code: result.code || 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED',
          error: result.error || 'Windows policy operation does not match the signed capability',
        };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED',
      error: error?.message || 'Windows policy operation could not be revalidated against the signed capability',
    };
  }
}

/**
 * Dispatch one semantic-exec request on the verified channel.
 *
 * Returns the response to relay back to the executor. Every failure fails
 * closed: no capability, bad signature, unknown key, missing/used nonce, the
 * Phase 2A permission policy gate (when wired), or failed revalidation DENYs
 * before any execution.
 *
 * Phase 2B-5 gate wiring (mandatory fail-closed): `policyContext` must carry
 * the server-computed `{ operation, facts }` envelope (or a complete `entries`
 * set). The operation set is first revalidated against the signed capability;
 * only then does the custom `policyGate`, or the fail-closed default gate, run.
 * This prevents a policy grant for one resource from authorizing execution of a
 * different resource carried by the signed capability. When neither
 * `policyGate` nor `policyContext` is provided the dispatch is DENIED with
 * `POLICY_GATE_REQUIRED` before signature -> nonce -> revalidation -> exec
 * proceeds, because every operation this dispatch can admit is host-capable.
 */
export async function dispatchWindowsSemanticExec({
  request,
  publicKeyByKid = null,
  revalidate = defaultRevalidate,
  execInvocation = defaultExecInvocation,
  nonceState = null,
  execFile = defaultExecFile,
  artifactFacts = null,
  now = Date.now(),
  timeoutMs = 120_000,
  policyGate = null,
  policyContext = null,
} = {}) {
  let parsedRequest = request;
  if (typeof request === 'string') {
    try {
      parsedRequest = JSON.parse(request);
    } catch {
      parsedRequest = null;
    }
  }
  const capability = parsedRequest && typeof parsedRequest === 'object'
    ? (parsedRequest.capability || parsedRequest)
    : null;
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)
    || (!capability.capabilityId && !capability.kid)) {
    return fail('SEMANTIC_CAPABILITY_REQUIRED', 'semantic-exec requires a signed capability');
  }

  const kid = trimString(capability.kid);
  const publicKey = typeof publicKeyByKid === 'function' ? await publicKeyByKid(kid) : null;
  if (!publicKey) {
    return fail('SEMANTIC_CAPABILITY_SIGNATURE_INVALID', `unknown or missing signing key: ${kid}`);
  }
  const verified = verifySemanticCapability(capability, { publicKey, now });
  if (!verified.ok) return verified;

  const nonce = trimString(capability.nonce);
  if (!nonce) return fail('SEMANTIC_CAPABILITY_NONCE_REQUIRED', 'capability nonce is required');
  if (!nonceState || typeof nonceState.consume !== 'function') {
    return fail(
      'SEMANTIC_CAPABILITY_NONCE_STATE_REQUIRED',
      'semantic-exec requires an atomic one-shot nonce store',
    );
  }
  if (nonceState && typeof nonceState.isUsed === 'function' && nonceState.isUsed(nonce)) {
    return fail('SEMANTIC_CAPABILITY_CONSUMED', 'capability nonce was already consumed');
  }

  // Phase 2B-5: Phase 2A permission policy gate. Mandatory fail-closed:
  // every operation this dispatch can admit is host-capable (win32 host
  // package / package_artifact) and there is no legitimate non-host chain to
  // preserve, so a dispatch with no `policyGate` and no `policyContext` is
  // rejected before target revalidation/exec and without consuming the
  // one-shot nonce. A wired gate that denies (or returns ASK) DENYs the same
  // way. This runs after the signed capability verifies and immediately before
  // target revalidation/exec.
  if (typeof policyGate !== 'function' && !policyContext) {
    return fail(
      PERMISSION_REASON_CODES.POLICY_GATE_REQUIRED,
      'Windows dispatch requires a Phase 2A permission policy gate for host-capable operations',
    );
  }
  const automaticCapability = capability.authMode === SEMANTIC_CAPABILITY_AUTH_MODE_POLICY_AUTO;
  const automaticGrant = policyContext?.capability?.authorizationClass === CAPABILITY_AUTHORIZATION_CLASSES.POLICY_AUTO;
  const automaticEntry = Array.isArray(policyContext?.entries)
    && policyContext.entries.some((entry) => entry?.capability?.authorizationClass === CAPABILITY_AUTHORIZATION_CLASSES.POLICY_AUTO);
  if (automaticCapability !== automaticGrant || automaticEntry || (automaticCapability && Array.isArray(policyContext?.entries))) {
    return fail('SEMANTIC_AUTHORIZATION_MISMATCH', 'semantic capability and policy grant authorization modes do not match');
  }
  const capabilityBinding = buildCapabilityRevalidationDecisions(capability, policyContext);
  if (!capabilityBinding.ok) {
    return fail(capabilityBinding.code, capabilityBinding.error);
  }
  {
    const activeGate = typeof policyGate === 'function' ? policyGate : defaultWindowsDispatchPolicyGate;
    let gateOperation = policyContext?.operation ?? null;
    let gateFacts = policyContext?.facts ?? null;
    let gateFactsError = null;
    if (gateOperation && !gateFacts) {
      try {
        gateFacts = buildWindowsDispatchPermissionFacts(gateOperation, capability);
      } catch (error) {
        // Preserve deterministic policy failures such as unknown host effects;
        // collapsing them into FACTS_REQUIRED hides the security ceiling and
        // makes the dispatch contract harder to audit.
        gateFactsError = error;
        gateFacts = null;
      }
    }
    if (gateFactsError) {
      return fail(
        gateFactsError?.code || PERMISSION_REASON_CODES.FACTS_REQUIRED,
        gateFactsError?.message || 'Windows dispatch permission facts could not be built',
      );
    }
    const gateResult = await activeGate({
      operation: gateOperation,
      facts: gateFacts,
      entries: Array.isArray(policyContext?.entries) ? policyContext.entries : null,
      mode: policyContext?.mode,
      capabilityGrant: policyContext?.capability ?? null,
      verifyFactsProof: policyContext?.verifyFactsProof ?? null,
      verifyGrantProof: policyContext?.verifyGrantProof ?? null,
      useNonce: policyContext?.useNonce ?? '',
      usageConsumed: policyContext?.usageConsumed ?? 0,
      consumedUseNonces: policyContext?.consumedUseNonces ?? [],
      now,
    });
    if (!gateResult?.ok) {
      return fail(
        gateResult?.code || PERMISSION_REASON_CODES.DENY_DEFAULT,
        gateResult?.error || 'Windows permission policy gate denied the dispatch',
      );
    }
  }

  const revalidation = await revalidate(capability, { execFile, artifactFacts });
  if (!revalidation?.ok) {
    return fail(
      revalidation?.code || 'WINDOWS_REVALIDATION_FAILED',
      revalidation?.error || 'Windows executor target revalidation failed',
    );
  }
  const invocation = revalidation.invocation;
  if (!invocation || !trimString(invocation.executable)) {
    return fail('WINDOWS_REVALIDATION_FAILED', 'revalidation did not produce a fixed-argv invocation');
  }

  // The check above is only an early rejection. Authorization is claimed here,
  // after policy and target revalidation but immediately before execution, by
  // one atomic operation. A split isUsed()/markUsed() sequence lets concurrent
  // dispatches both cross the async policy/revalidation window and execute.
  let consumed = false;
  try {
    consumed = await nonceState.consume(nonce) === true;
  } catch (error) {
    return fail(
      'SEMANTIC_CAPABILITY_NONCE_STATE_REQUIRED',
      `unable to consume capability nonce atomically: ${error?.message || String(error)}`,
    );
  }
  if (!consumed) {
    return fail('SEMANTIC_CAPABILITY_CONSUMED', 'capability nonce was already consumed');
  }

  return execInvocation(invocation, { execFile, timeoutMs });
}

export function createWindowsNonceTracker({ seed = [] } = {}) {
  const seen = new Set(Array.isArray(seed) ? seed.map(trimString).filter(Boolean) : []);
  return {
    isUsed(nonce) { return seen.has(trimString(nonce)); },
    consume(nonce) {
      const value = trimString(nonce);
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    },
    snapshot() { return [...seen]; },
  };
}
