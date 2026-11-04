// Cross-platform Path Resolver (Execution-Scope slice 1, design section 5.3).
//
// All Project / Run / lease / collaboration path checks must go through this
// module: expand ~, reject empty/NUL, absolutize, realpath() symlink/junction
// resolution, and containment via path.relative() -- never string startsWith().
//
// Frozen error codes (notes/current/execution-scope-contract.md):
//   PROJECT_SCOPE_ESCAPE (400)  -- subpath escapes the workspace after resolution
//   WORKSPACE_ROOT_DRIFT (409)  -- workspace root realpath differs from recorded
//                                  identity (raised by chat/workspaces.mjs)
// Invalid inputs (empty/NUL/non-string) raise EINVAL (400), mirroring Node's
// EINVAL convention; they are programming errors, not scope violations.
import { createHash, randomUUID } from 'crypto';
import { realpath } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, posix, relative, resolve, win32 } from 'path';

export const PATH_IDENTITY_VERSION = 1;

const UNRESOLVED_INPUT_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'EPERM',
  'ELOOP',
  'ENAMETOOLONG',
]);

function pathsFor(platform = process.platform) {
  return platform === 'win32' ? win32 : posix;
}

function createPathError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function scopeEscape(message, details = {}) {
  return createPathError(message, 'PROJECT_SCOPE_ESCAPE', 400, details);
}

function assertSafePathString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw createPathError(`${label} must be a non-empty string`, 'EINVAL');
  }
  if (value.includes('\0')) {
    throw createPathError(`${label} must not contain NUL bytes`, 'EINVAL');
  }
}

function expandUserHome(value, platform) {
  if (value === '~') return homedir();
  const sep = pathsFor(platform).sep;
  if (value.startsWith('~/') || (sep !== '/' && value.startsWith(`~${sep}`))) {
    return pathsFor(platform).join(homedir(), value.slice(2));
  }
  return value;
}

// Platform normalization used only for identity/keys, never for containment.
// - win32: lowercase the drive letter and unify separators to '\'.
// - posix / other: return the path unchanged.
export function normalizePlatformPath(value, platform = process.platform) {
  assertSafePathString(value, 'Path');
  if (platform !== 'win32') return value;
  let normalized = value.replaceAll('/', '\\');
  normalized = normalized.replace(/^([A-Za-z]):/, (match, drive) => `${drive.toLowerCase()}:`);
  return normalized;
}

// physicalKey = sha256(identityVersion + "\0" + hostId + "\0" +
//                      platformNormalized(realRootPath))
// Two textual aliases / symlink aliases of the same realpath produce the same
// key; different hostIds always produce different keys.
export function physicalKeyForPath(hostId, realRootPath, platform = process.platform) {
  if (typeof hostId !== 'string' || hostId.length === 0) {
    throw createPathError('hostId must be a non-empty string', 'EINVAL');
  }
  const normalized = normalizePlatformPath(realRootPath, platform);
  const digest = createHash('sha256')
    .update(`${PATH_IDENTITY_VERSION}\0${hostId}\0${normalized}`, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

// Expand ~, reject empty/NUL, absolutize, then realpath() (symlink/junction).
// Rejects with the underlying fs code (ENOENT/ENOTDIR/EACCES/EPERM/ELOOP/
// ENAMETOOLONG) when the root is missing/inaccessible so callers can decide
// whether the failure maps to an unresolved workspace; invalid input raises
// EINVAL.
export async function resolveRealRoot(inputPath, platform = process.platform) {
  assertSafePathString(inputPath, 'rootPath');
  const expanded = expandUserHome(inputPath, platform);
  const absolute = pathsFor(platform).resolve(expanded);
  return realpath(absolute);
}

// True when the root cannot currently be resolved to a realpath (missing,
// inaccessible, symlink loop, ...). Used by workspaces.mjs to mark a root
// unresolved instead of failing the migration path.
export function isUnresolvableRootError(error) {
  return !!error && UNRESOLVED_INPUT_CODES.has(error.code);
}

function isContained(realRoot, realCandidate, paths) {
  const rel = paths.relative(realRoot, realCandidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel));
}

async function realRootOf(value, platform) {
  assertSafePathString(value, 'Workspace root');
  const paths = pathsFor(platform);
  if (!paths.isAbsolute(value)) {
    throw createPathError('Workspace root must be an absolute path', 'EINVAL');
  }
  // Re-resolve the workspace root too so symlink aliases of the root itself
  // cannot break the containment check.
  return realpath(value);
}

// Resolve a Workspace-scoped relative path and verify it stays inside the
// workspace. scopeRelativePath '' means the whole workspace (shared scope).
// Returns { relativePath, realPath } with relativePath normalized to '/'
// separators for durable storage.
export async function resolveContainedScope(realWorkspaceRoot, scopeRelativePath, platform = process.platform) {
  const paths = pathsFor(platform);
  const realWsRoot = await realRootOf(realWorkspaceRoot, platform);

  if (scopeRelativePath === '') {
    return { relativePath: '', realPath: realWsRoot };
  }
  assertSafePathString(scopeRelativePath, 'scopeRelativePath');
  if (paths.isAbsolute(scopeRelativePath)) {
    throw scopeEscape('scope subpath must be relative to the workspace root');
  }
  if (scopeRelativePath.includes('\\')) {
    throw scopeEscape('scope subpath must not contain backslashes');
  }
  for (const segment of scopeRelativePath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw scopeEscape('scope subpath must not contain empty, "." or ".." segments');
    }
  }

  const candidate = paths.resolve(realWsRoot, scopeRelativePath);
  // realpath() also fails closed for symlinks escaping the workspace: the
  // resolved path is checked with path.relative, never startsWith().
  const realScopeRoot = await realpath(candidate);
  if (!isContained(realWsRoot, realScopeRoot, paths)) {
    throw scopeEscape('scope subpath resolves outside the workspace root');
  }
  const rel = paths.relative(realWsRoot, realScopeRoot);
  return {
    relativePath: rel.split(paths.sep).join('/'),
    realPath: realScopeRoot,
  };
}

// Boolean containment check: both sides are realpath()'d, then compared with
// path.relative(). Returns false when either path cannot be resolved.
export async function scopeContainsPath(realRoot, candidate, platform = process.platform) {
  const paths = pathsFor(platform);
  try {
    const [realWsRoot, realCandidate] = await Promise.all([
      realpath(realRoot),
      realpath(candidate),
    ]);
    return isContained(realWsRoot, realCandidate, paths);
  } catch {
    return false;
  }
}

// ── ExecutionScopeSnapshot (Execution-Scope slice 2, design section 6) ─────
// Canonical storage is inline in each Run's manifest.json; this module only
// builds the immutable snapshot and its digest. The digest is computed over the
// canonical JSON of the snapshot minus the identity-varying fields (snapshotId,
// createdAt), so identical inputs always produce identical digests while every
// snapshot still carries a unique snapshotId.

export const EXECUTION_SCOPE_SCHEMA_VERSION = 1;
const EXECUTION_SCOPE_SNAPSHOT_ID_PREFIX = 'ess_';

export function createExecutionScopeSnapshotId() {
  return `${EXECUTION_SCOPE_SNAPSHOT_ID_PREFIX}${randomUUID().replaceAll('-', '')}`;
}

// Canonical JSON: recursive stable key ordering, no whitespace. Guarantees the
// digest is independent of object construction order.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

// sha256 over the canonical JSON of the snapshot excluding snapshotId and
// createdAt (both vary per snapshot; everything else is frozen input).
export function computeExecutionScopeDigest(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw createPathError('execution scope snapshot must be an object', 'EINVAL');
  }
  const { snapshotId, createdAt, ...canonical } = snapshot;
  return `sha256:${createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex')}`;
}

function normalizeGitProvenance(git) {
  if (!git || typeof git !== 'object') {
    return { state: 'not_git', dirty: false, partial: false };
  }
  const state = git.state === 'available' || git.state === 'partial' || git.state === 'not_git'
    ? git.state
    : 'not_git';
  return {
    state,
    ...(typeof git.repositoryRoot === 'string' && git.repositoryRoot ? { repositoryRoot: git.repositoryRoot } : {}),
    ...(git.branch !== undefined && git.branch !== null ? { branch: git.branch } : {}),
    ...(typeof git.baseCommit === 'string' && git.baseCommit ? { baseCommit: git.baseCommit } : {}),
    ...(typeof git.headCommit === 'string' && git.headCommit ? { headCommit: git.headCommit } : {}),
    dirty: git.dirty === true,
    ...(typeof git.trackedDiffHash === 'string' && git.trackedDiffHash ? { trackedDiffHash: git.trackedDiffHash } : {}),
    ...(typeof git.untrackedManifestHash === 'string' && git.untrackedManifestHash
      ? { untrackedManifestHash: git.untrackedManifestHash }
      : {}),
    partial: git.partial === true,
    ...(typeof git.reason === 'string' && git.reason ? { reason: git.reason } : {}),
  };
}

function defaultAgentPolicyDigest(agentId) {
  return agentId ? `sha256:${createHash('sha256').update(agentId, 'utf8').digest('hex')}` : '';
}

/**
 * Build an immutable ExecutionScopeSnapshot.
 *
 * Inputs:
 *   project   - stored Project record (id, rootPath, scopeMode, scopePath,
 *               revision, workspaceId)
 *   workspace - stored Workspace record (id, hostId, rootPath, realRootPath,
 *               physicalKey, revision, resolutionState)
 *   session   - session object (id, folder, templateId/sourceId)
 *   agent     - optional { id, revision, policyDigest }; defaults are derived
 *               from the session's template/app identity (agent records do not
 *               carry revisions yet, so agentRevision defaults to 1)
 *   scopeMode / accessMode / executionIsolation - effective execution
 *               dimensions (scopeMode falls back to project.scopeMode)
 *   git       - git provenance from chat/git-provenance.mjs
 *
 * Returns { snapshot, digest } where snapshot matches the frozen canonical
 * shape in design section 6.1.
 */
export async function buildExecutionScopeSnapshot({
  project,
  workspace,
  session,
  agent,
  scopeMode,
  accessMode,
  executionIsolation,
  git,
  platform = process.platform,
} = {}) {
  const effectiveScopeMode = scopeMode === 'subpath' ? 'subpath' : (project?.scopeMode === 'subpath' ? 'subpath' : 'shared');
  const workspaceId = typeof workspace?.id === 'string' ? workspace.id : '';
  const projectId = typeof project?.id === 'string' ? project.id : '';
  const sessionId = typeof session?.id === 'string' ? session.id : '';
  const hostId = typeof workspace?.hostId === 'string' ? workspace.hostId : '';
  const realRootPath = typeof workspace?.realRootPath === 'string' ? workspace.realRootPath : '';
  const physicalKey = typeof workspace?.physicalKey === 'string' ? workspace.physicalKey : '';
  const workspaceRoot = {
    path: typeof workspace?.rootPath === 'string' && workspace.rootPath ? workspace.rootPath : (project?.rootPath || ''),
    realPath: realRootPath,
    physicalKey,
  };

  let scopeRoot;
  if (effectiveScopeMode === 'subpath' && typeof project?.scopePath === 'string' && project.scopePath) {
    scopeRoot = await resolveContainedScope(realRootPath, project.scopePath, platform);
  } else {
    scopeRoot = { relativePath: '', realPath: realRootPath };
  }

  const agentId = typeof agent?.id === 'string' && agent.id
    ? agent.id
    : (typeof session?.templateId === 'string' && session.templateId ? session.templateId
      : (typeof session?.sourceId === 'string' ? session.sourceId : ''));
  const agentRevision = Number.isInteger(agent?.revision) && agent.revision > 0 ? agent.revision : 1;
  const agentPolicyDigest = typeof agent?.policyDigest === 'string' && agent.policyDigest
    ? agent.policyDigest
    : defaultAgentPolicyDigest(agentId);

  const snapshot = {
    schemaVersion: EXECUTION_SCOPE_SCHEMA_VERSION,
    snapshotId: createExecutionScopeSnapshotId(),
    createdAt: new Date().toISOString(),
    workspaceId,
    projectId,
    sessionId,
    hostId,
    workspaceRoot,
    scopeRoot,
    cwd: { relativePath: scopeRoot.relativePath, realPath: scopeRoot.realPath },
    scopeMode: effectiveScopeMode,
    accessMode: accessMode === 'read' ? 'read' : 'write',
    executionIsolation: executionIsolation === 'worktree' || executionIsolation === 'container'
      ? executionIsolation
      : 'shared',
    projectRevision: Number.isInteger(project?.revision) && project.revision > 0 ? project.revision : 1,
    workspaceRevision: Number.isInteger(workspace?.revision) && workspace.revision > 0 ? workspace.revision : 1,
    agentId,
    agentRevision,
    agentPolicyDigest,
    git: normalizeGitProvenance(git),
  };

  return { snapshot, digest: computeExecutionScopeDigest(snapshot) };
}
