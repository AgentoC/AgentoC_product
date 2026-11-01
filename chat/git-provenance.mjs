// Lightweight, read-only Git provenance capture (Execution-Scope slice 2,
// design section 6.3).
//
// NOT a shadow snapshot: it records where the workspace started and whether it
// was dirty, so an ExecutionScopeSnapshot can freeze the start state without
// promising undo or bit-for-bit restore.
//
// Rules:
// - Every git invocation is read-only with hooks, external diff drivers and
//   textconv disabled:
//     git -c core.hooksPath=/dev/null -c diff.external= -c textconv=false
//         --no-optional-locks ...
//   plus GIT_OPTIONAL_LOCKS=0 in the environment.
// - `git diff HEAD` is piped into a streaming sha256 — the patch is never
//   materialized in memory. Output over the byte cap (default 512MB) or a
//   timeout (default 5000ms) yields partial=true + reason and never fakes a
//   clean tree.
// - Untracked v1 records a manifest hash over the normalized porcelain paths
//   and metadata only (sorted, deduped) — not file contents.
// - detached HEAD => branch=null, headCommit still reported.
// - non-git directories => state='not_git' (the Run can still execute).
// - spawn is injectable at module level (setGitProvenanceSpawn) for tests that
//   simulate timeouts and failures without a mock library.
import { createHash } from 'crypto';
import { spawn as defaultSpawn } from 'child_process';

export const GIT_PROVENANCE_DEFAULT_TIMEOUT_MS = 5000;
export const GIT_PROVENANCE_DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const GIT_PROVENANCE_MAX_STDERR_BYTES = 2 * 1024 * 1024;

const GIT_READONLY_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
  '--no-optional-locks',
];
// External diff drivers and textconv must be disabled for the diff invocation:
// `-c diff.external=` (empty) is interpreted by git as an external program
// named '' and fails with exit 128, so use the explicit flags instead.
const GIT_DIFF_DISABLE_DRIVERS = ['--no-ext-diff', '--no-textconv'];
// Force English diagnostics so error-message parsing is host-locale independent
// (e.g. `fatal: not a git repository` stays stable on non-English systems).
const GIT_READONLY_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

const EMPTY_SHA256 = createHash('sha256').update('', 'utf8').digest('hex');

let spawnImpl = defaultSpawn;

// Module-level injectable spawn for tests (timeout / failure simulation).
export function setGitProvenanceSpawn(fn) {
  spawnImpl = typeof fn === 'function' ? fn : defaultSpawn;
}

export function resetGitProvenanceSpawn() {
  spawnImpl = defaultSpawn;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function partialResult(reason, details = {}) {
  return {
    state: 'partial',
    dirty: false,
    partial: true,
    reason,
    ...details,
  };
}

function gitArgs(args) {
  return [...GIT_READONLY_ARGS, ...args];
}

function buildGitEnv(extraEnv) {
  return { ...process.env, ...GIT_READONLY_ENV, ...(extraEnv || {}) };
}

function runGitCapture(args, { cwd, timeoutMs, maxBytes, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('git', gitArgs(args), {
        cwd,
        env: buildGitEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ error, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, exceeded: false, code: null });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        if (exceeded) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBytes) {
          exceeded = true;
          stdoutChunks.length = 0;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          return;
        }
        stdoutChunks.push(chunk);
      });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        if (exceeded || timedOut) return;
        stderrBytes += chunk.length;
        if (stderrBytes > GIT_PROVENANCE_MAX_STDERR_BYTES) {
          stderrChunks.length = 0;
          return;
        }
        stderrChunks.push(chunk);
      });
    }
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        error: error || null,
        code: typeof code === 'number' ? code : (error ? null : 0),
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        timedOut,
        exceeded,
      });
    };
    if (typeof child.on === 'function') {
      child.on('error', finish);
      child.on('close', (code) => finish(null, code));
    } else {
      finish(null, 0);
    }
  });
}

function streamGitToHash(args, { cwd, timeoutMs, maxBytes, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('git', gitArgs(args), {
        cwd,
        env: buildGitEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ error, digest: null, bytes: 0, timedOut: false, exceeded: false, code: null });
      return;
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        if (exceeded) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          exceeded = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          return;
        }
        hash.update(chunk);
      });
    }
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        error: error || null,
        code: typeof code === 'number' ? code : (error ? null : 0),
        digest: exceeded ? null : `sha256:${hash.digest('hex')}`,
        bytes,
        timedOut,
        exceeded,
      });
    };
    if (typeof child.on === 'function') {
      child.on('error', finish);
      child.on('close', (code) => finish(null, code));
    } else {
      finish(null, 0);
    }
  });
}

function summarizeStderr(stderrBuffer) {
  const text = stderrBuffer.toString('utf8').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 300) : '';
}

function isUnbornHeadFailure(stderrBuffer) {
  const text = stderrBuffer.toString('utf8');
  // `git rev-parse --verify HEAD` on an unborn repo prints either the
  // ambiguous-argument message (TTY) or the short "Needed a single revision"
  // message (non-TTY). Both mean HEAD does not resolve to a commit yet.
  return /unknown revision/i.test(text) || /needed a single revision/i.test(text);
}

// Pure manifest hash over `git status --porcelain` text: keeps only untracked
// ('??') entries, normalizes (trim + sort + dedupe) the path/metadata lines,
// and hashes the canonical text. Empty input hashes the empty string, so a
// stable empty untracked manifest is distinguishable from any real one.
export function hashUntrackedManifest(porcelainText) {
  const lines = [];
  for (const rawLine of String(porcelainText || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('?? ')) {
      const path = line.slice(3).trim();
      if (path) lines.push(path);
    }
  }
  const canonical = [...new Set(lines)].sort().join('\n');
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function untrackedManifestIsEmpty(hash) {
  return hash === `sha256:${EMPTY_SHA256}`;
}

/**
 * collectGitProvenance(cwd, options?) -> { state, repositoryRoot?, branch?,
 * baseCommit?, headCommit?, dirty, trackedDiffHash?, untrackedManifestHash?,
 * partial, reason?, timeoutMs? }
 *
 * options: { timeoutMs, maxOutputBytes, env, spawn }
 */
export async function collectGitProvenance(cwd, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : GIT_PROVENANCE_DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isInteger(options.maxOutputBytes) && options.maxOutputBytes > 0
    ? options.maxOutputBytes
    : GIT_PROVENANCE_DEFAULT_MAX_OUTPUT_BYTES;
  const runOptions = { cwd, timeoutMs, maxBytes, env: options.env };

  const probe = await runGitCapture(['rev-parse', '--is-inside-work-tree'], runOptions);
  if (probe.timedOut || probe.exceeded) {
    return partialResult(probe.timedOut ? 'timeout' : 'output-limit', { timeoutMs: probe.timedOut ? timeoutMs : undefined });
  }
  if (probe.error) {
    if (probe.error.code === 'ENOENT') {
      return { state: 'not_git', dirty: false, partial: false, reason: 'git-not-found' };
    }
    return partialResult(`git-probe-failed:${probe.error.message || String(probe.error)}`);
  }
  if (probe.code !== 0) {
    const stderr = summarizeStderr(probe.stderr);
    if (/\bnot a git repository\b/i.test(stderr)) {
      return { state: 'not_git', dirty: false, partial: false };
    }
    return partialResult(`git-probe-failed:${stderr || `exit-${probe.code}`}`);
  }

  // Separate captures: rev-parse deduplicates identical requested revisions,
  // so the branch ref and the full head sha must be requested in different
  // invocations. `--show-toplevel` succeeds even on an unborn repo; the branch
  // lookup is separate and tolerates failure (detached/unborn), because the
  // head step below classifies unborn repos as partial 'unborn-head'.
  const top = await runGitCapture(['rev-parse', '--show-toplevel'], runOptions);
  if (top.timedOut || top.exceeded) {
    return partialResult(top.timedOut ? 'timeout' : 'output-limit', { timeoutMs: top.timedOut ? timeoutMs : undefined });
  }
  if (top.error) {
    return partialResult(`git-meta-failed:${top.error.message || String(top.error)}`);
  }
  if (top.code !== 0) {
    return partialResult(`git-meta-failed:${summarizeStderr(top.stderr) || `exit-${top.code}`}`);
  }
  const repositoryRoot = top.stdout.toString('utf8').split('\n').map((line) => line.trim())[0] || undefined;

  const branchCapture = await runGitCapture(['rev-parse', '--abbrev-ref', 'HEAD'], runOptions);
  let branch = null;
  if (!branchCapture.timedOut && !branchCapture.exceeded && !branchCapture.error && branchCapture.code === 0) {
    const branchRef = branchCapture.stdout.toString('utf8').split('\n').map((line) => line.trim())[0] || '';
    branch = branchRef && branchRef !== 'HEAD' ? branchRef : null;
  }

  const head = await runGitCapture(['rev-parse', '--verify', 'HEAD'], runOptions);
  if (head.timedOut || head.exceeded) {
    return partialResult(head.timedOut ? 'timeout' : 'output-limit', {
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(branch !== undefined ? { branch } : {}),
      timeoutMs: head.timedOut ? timeoutMs : undefined,
    });
  }
  if (head.error) {
    return partialResult(`git-meta-failed:${head.error.message || String(head.error)}`);
  }
  if (head.code !== 0) {
    if (isUnbornHeadFailure(head.stderr)) {
      return partialResult('unborn-head', {
        ...(repositoryRoot ? { repositoryRoot } : {}),
        ...(branch !== undefined ? { branch } : {}),
      });
    }
    return partialResult(`git-meta-failed:${summarizeStderr(head.stderr) || `exit-${head.code}`}`);
  }
  const headCommit = head.stdout.toString('utf8').split('\n').map((line) => line.trim())[0] || undefined;
  // v1: the dirty-diff base is HEAD itself, so baseCommit equals headCommit at
  // snapshot time (matches the frozen canonical example in design 6.1).
  const baseCommit = headCommit;

  const diff = await streamGitToHash(['diff', ...GIT_DIFF_DISABLE_DRIVERS, 'HEAD'], runOptions);
  if (diff.timedOut || diff.exceeded) {
    return partialResult(diff.timedOut ? 'timeout' : 'output-limit', {
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(headCommit ? { headCommit } : {}),
      timeoutMs: diff.timedOut ? timeoutMs : undefined,
    });
  }
  if (diff.error) {
    return partialResult(`git-diff-failed:${diff.error.message || String(diff.error)}`, {
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(headCommit ? { headCommit } : {}),
    });
  }
  if (diff.code !== 0) {
    return partialResult('git-diff-failed', {
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(headCommit ? { headCommit } : {}),
    });
  }

  const status = await runGitCapture(['status', '--porcelain'], runOptions);
  if (status.timedOut || status.exceeded) {
    return partialResult(status.timedOut ? 'timeout' : 'output-limit', {
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(headCommit ? { headCommit } : {}),
      timeoutMs: status.timedOut ? timeoutMs : undefined,
    });
  }
  if (status.error) {
    return partialResult(`git-status-failed:${status.error.message || String(status.error)}`, {
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(headCommit ? { headCommit } : {}),
    });
  }
  if (status.code !== 0) {
    return partialResult('git-status-failed', {
      ...(repositoryRoot ? { repositoryRoot } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(headCommit ? { headCommit } : {}),
    });
  }

  const untrackedManifestHash = hashUntrackedManifest(status.stdout.toString('utf8'));
  const trackedDiffHash = diff.digest;
  const trackedDirty = diff.bytes > 0;
  const untrackedDirty = !untrackedManifestIsEmpty(untrackedManifestHash);
  const dirty = trackedDirty || untrackedDirty;

  return {
    state: 'available',
    ...(repositoryRoot ? { repositoryRoot } : {}),
    branch,
    ...(baseCommit ? { baseCommit } : {}),
    ...(headCommit ? { headCommit } : {}),
    dirty,
    trackedDiffHash,
    untrackedManifestHash,
    partial: false,
  };
}
