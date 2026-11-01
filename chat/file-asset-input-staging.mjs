import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'path';

import {
  CHAT_FILE_ASSETS_DIR,
  CHAT_FILE_ASSET_CACHE_DIR,
  CHAT_IMAGES_DIR,
  CHAT_RUNS_DIR,
} from '../lib/config.mjs';
import {
  SEMANTIC_COMPILER_VERSION,
  SEMANTIC_OPERATION_VERSION,
  SEMANTIC_POLICY_VERSION,
  aggregateDecisions,
  computeSemanticManifestHash,
  defaultDecision,
  validateSemanticOperation,
} from './semantic-operation.mjs';
import {
  FILE_ASSET_ID_PATTERN,
  FILE_ASSET_INPUT_STAGING_SCHEMA_VERSION,
  FILE_ASSET_READ_EFFECTS,
  FILE_ASSET_READ_OPERATION,
} from './file-asset-input-contract.mjs';
import {
  getFileAsset,
  localizeFileAsset,
  recordFileAssetContentDigest,
} from './file-assets.mjs';
import { runDir } from './runs.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;
const COPY_BUFFER_BYTES = 64 * 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createStagingError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeSize(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeHash(value) {
  const hash = trimString(value).toLowerCase();
  return SHA256_PATTERN.test(hash) ? hash : '';
}

function isContained(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath !== ''
    && !relativePath.startsWith('..')
    && !isAbsolute(relativePath);
}

async function resolveExistingPath(value, label) {
  const sourcePath = trimString(value);
  if (!sourcePath) {
    throw createStagingError(`${label} is required`, 'FILE_ASSET_INPUT_PATH_REQUIRED');
  }
  let stats;
  try {
    stats = await lstat(sourcePath);
  } catch {
    throw createStagingError(`${label} does not exist`, 'FILE_ASSET_INPUT_NOT_FOUND', 404);
  }
  if (stats.isSymbolicLink()) {
    throw createStagingError(`${label} must not be a symlink`, 'FILE_ASSET_INPUT_SYMLINK', 409);
  }
  if (!stats.isFile()) {
    throw createStagingError(`${label} must be a regular file`, 'FILE_ASSET_INPUT_NOT_FILE', 409);
  }
  let realPath;
  try {
    realPath = await realpath(sourcePath);
  } catch {
    throw createStagingError(`${label} cannot be resolved`, 'FILE_ASSET_INPUT_UNRESOLVABLE', 409);
  }
  return { sourcePath, realPath, stats };
}

async function allowedSourceRoots() {
  const candidates = [
    join(CHAT_FILE_ASSETS_DIR, 'objects'),
    CHAT_FILE_ASSET_CACHE_DIR,
    CHAT_IMAGES_DIR,
  ];
  const roots = [];
  for (const candidate of candidates) {
    try {
      roots.push(await realpath(candidate));
    } catch {
      // A storage tier may not exist until the first upload.
    }
  }
  return roots;
}

async function assertSafeSourcePath(sourcePath, label) {
  const resolved = await resolveExistingPath(sourcePath, label);
  const roots = await allowedSourceRoots();
  if (!roots.some((root) => isContained(root, resolved.realPath))) {
    throw createStagingError(`${label} is outside an approved control-plane input root`, 'FILE_ASSET_INPUT_PATH_ESCAPE');
  }
  return resolved;
}

async function ensureInputRoot(runId) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw createStagingError('runId is invalid', 'FILE_ASSET_INPUT_RUN_INVALID', 400);
  }
  const root = resolve(runDir(runId));
  const runsRoot = resolve(CHAT_RUNS_DIR);
  await mkdir(runsRoot, { recursive: true });
  const realRunsRoot = await realpath(runsRoot);
  const realRunRoot = await (async () => {
    await mkdir(root, { recursive: true });
    const runStats = await lstat(root);
    if (!runStats.isDirectory() || runStats.isSymbolicLink()) {
      throw createStagingError('run directory must be a real directory', 'FILE_ASSET_INPUT_RUN_ESCAPE');
    }
    const candidate = await realpath(root);
    if (!isContained(realRunsRoot, candidate)) {
      throw createStagingError('run directory escapes the run root', 'FILE_ASSET_INPUT_RUN_ESCAPE');
    }
    return candidate;
  })();
  const inputRoot = join(realRunRoot, 'inputs');
  await mkdir(inputRoot, { recursive: true, mode: 0o750 });
  const inputStats = await lstat(inputRoot);
  if (!inputStats.isDirectory() || inputStats.isSymbolicLink()) {
    throw createStagingError('run input directory must be a real directory', 'FILE_ASSET_INPUT_RUN_ESCAPE');
  }
  const realInputRoot = await realpath(inputRoot);
  if (!isContained(realRunRoot, realInputRoot)) {
    throw createStagingError('run input directory escapes the run directory', 'FILE_ASSET_INPUT_RUN_ESCAPE');
  }
  await chmod(realInputRoot, 0o750).catch(() => {});
  return { realRunRoot, realInputRoot };
}

async function writeBufferFully(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    if (!result.bytesWritten) {
      throw createStagingError('failed to write staged attachment', 'FILE_ASSET_INPUT_WRITE_FAILED', 502);
    }
    offset += result.bytesWritten;
  }
}

async function copyAndDigest(sourcePath, targetPath, { expectedSize = null, expectedHash = '' } = {}) {
  const sourceFlags = fsConstants.O_RDONLY
    | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  let sourceHandle = null;
  let targetHandle = null;
  try {
    sourceHandle = await open(sourcePath, sourceFlags);
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) {
      throw createStagingError('attachment source is not a regular file', 'FILE_ASSET_INPUT_NOT_FILE');
    }
    if (expectedSize !== null && sourceStat.size !== expectedSize) {
      throw createStagingError('attachment source size does not match its asset descriptor', 'FILE_ASSET_SIZE_MISMATCH');
    }

    targetHandle = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o640,
    );
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    let sizeBytes = 0;
    while (true) {
      const result = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      await writeBufferFully(targetHandle, chunk);
      position += result.bytesRead;
      sizeBytes += result.bytesRead;
    }
    await targetHandle.sync();
    const sha256 = hash.digest('hex');
    if (expectedSize !== null && sizeBytes !== expectedSize) {
      throw createStagingError('staged attachment size changed during read', 'FILE_ASSET_SIZE_MISMATCH');
    }
    if (expectedHash && sha256 !== expectedHash) {
      throw createStagingError('staged attachment hash does not match its asset descriptor', 'FILE_ASSET_HASH_MISMATCH');
    }
    const targetStat = await targetHandle.stat();
    if (!targetStat.isFile() || targetStat.size !== sizeBytes) {
      throw createStagingError('staged attachment size verification failed', 'FILE_ASSET_SIZE_MISMATCH');
    }
    await targetHandle.close();
    targetHandle = null;
    await rename(tempPath, targetPath);
    return { sha256, sizeBytes };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await targetHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
  }
}

function safeExtension(name) {
  const extension = extname(trimString(name)).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : '.bin';
}

function buildOperation({ sessionId, runId, turnId, asset, relativePath, sha256, sizeBytes }) {
  const requestKey = asset.id;
  const rawRequestHash = createHash('sha256')
    .update(JSON.stringify({ sessionId, runId, turnId, assetId: asset.id, sha256, sizeBytes }), 'utf8')
    .digest('hex');
  const operation = {
    schemaVersion: SEMANTIC_OPERATION_VERSION,
    operationId: `file_asset.read:${runId}:${asset.id}`,
    requestBinding: { sessionId, runId, turnId, requestKey },
    primaryAction: 'file_asset.read',
    effects: [...FILE_ASSET_READ_EFFECTS],
    executionClass: 'session',
    target: {
      kind: 'file_asset',
      platform: process.platform,
      assetId: asset.id,
      resourceSnapshot: {
        identity: `file_asset:${asset.id}`,
        assetId: asset.id,
        sessionId: asset.sessionId,
        sha256,
        sizeBytes,
      },
    },
    scope: {
      kind: 'current_run_inputs',
      computed: true,
      sessionId,
      runId,
      turnId,
      relativePath,
    },
    impact: {
      estimatedItems: 1,
      containsSensitiveMaterial: false,
      reversible: true,
    },
    source: {
      rawRequestHash: `sha256:${rawRequestHash}`,
      commandForm: 'structured',
    },
    analysis: {
      confidence: 'high',
      unknowns: [],
      policyVersion: SEMANTIC_POLICY_VERSION,
      compilerVersion: SEMANTIC_COMPILER_VERSION,
    },
    sensitive: false,
    generated: false,
    privileged: false,
    decision: 'ALLOW',
  };
  const validation = validateSemanticOperation(operation);
  if (!validation.ok) {
    throw createStagingError(
      `file_asset.read operation is invalid: ${validation.errors.join(', ')}`,
      'FILE_ASSET_INPUT_OPERATION_INVALID',
    );
  }
  if (defaultDecision(operation) !== 'ALLOW') {
    throw createStagingError('file_asset.read operation was not allowlisted', 'FILE_ASSET_INPUT_POLICY_DENIED');
  }
  return {
    ...operation,
    operationManifestHash: computeSemanticManifestHash(operation),
  };
}

async function stageOneAttachment({ sessionId, runId, turnId, inputRoot, attachment, index }) {
  const assetId = trimString(attachment?.assetId);
  let asset = null;
  let sourcePath = '';
  let sourceLabel = '';
  if (assetId) {
    if (!FILE_ASSET_ID_PATTERN.test(assetId)) {
      throw createStagingError('Unknown file asset', 'FILE_ASSET_NOT_FOUND', 404);
    }
    asset = await getFileAsset(assetId);
    if (!asset) throw createStagingError('Unknown file asset', 'FILE_ASSET_NOT_FOUND', 404);
    if (asset.sessionId !== sessionId) {
      throw createStagingError('File asset is bound to a different session', 'FILE_ASSET_SESSION_MISMATCH', 403);
    }
    if (asset.status !== 'ready') {
      throw createStagingError('File asset is not ready', 'FILE_ASSET_NOT_READY', 409);
    }
    if (asset.sha256 && !normalizeHash(asset.sha256)) {
      throw createStagingError('File asset hash descriptor is invalid', 'FILE_ASSET_HASH_INVALID');
    }
    sourcePath = await localizeFileAsset(asset);
    sourceLabel = `file asset ${asset.id}`;
  } else {
    throw createStagingError(
      'Attachment resource must be resolved to an exact file asset id',
      'FILE_ASSET_INPUT_RESOURCE_UNKNOWN',
    );
  }

  const source = await assertSafeSourcePath(sourcePath, sourceLabel);
  const refreshedAsset = asset ? (await getFileAsset(asset.id) || asset) : null;
  const expectedSize = refreshedAsset ? normalizeSize(refreshedAsset.sizeBytes) : null;
  const expectedHash = refreshedAsset ? normalizeHash(refreshedAsset.sha256) : '';
  if (refreshedAsset && refreshedAsset.sha256 && !expectedHash) {
    throw createStagingError('File asset hash descriptor is invalid', 'FILE_ASSET_HASH_INVALID');
  }

  const displayName = trimString(attachment?.originalName)
    || trimString(refreshedAsset?.originalName)
    || 'attachment';
  const inputName = asset
    ? `${asset.id}${safeExtension(displayName)}`
    : `input_${index}_${Date.now().toString(36)}${safeExtension(displayName)}`;
  const inputPath = join(inputRoot, inputName);
  const runRoot = resolve(inputRoot, '..');
  const relativePath = relative(runRoot, inputPath).split(sep).join('/');
  if (!isContained(runRoot, inputPath) || !relativePath || isAbsolute(relativePath)) {
    throw createStagingError('staged attachment path escapes the current Run', 'FILE_ASSET_INPUT_RUN_ESCAPE');
  }
  const staged = await copyAndDigest(source.realPath, inputPath, {
    expectedSize,
    expectedHash,
  });
  if (asset) {
    await recordFileAssetContentDigest(asset.id, staged);
  }

  const normalizedMimeType = trimString(attachment?.mimeType)
    || trimString(refreshedAsset?.mimeType)
    || 'application/octet-stream';
  const descriptor = {
    ...(asset ? { assetId: asset.id } : {}),
    originalName: displayName,
    mimeType: normalizedMimeType,
    sizeBytes: staged.sizeBytes,
    sha256: staged.sha256,
    relativePath,
    ...(trimString(attachment?.renderAs) === 'file' ? { renderAs: 'file' } : {}),
  };
  const operation = buildOperation({
    sessionId,
    runId,
    turnId,
    asset: refreshedAsset || asset,
    relativePath,
    sha256: staged.sha256,
    sizeBytes: staged.sizeBytes,
  });
  return { descriptor, operation };
}

export { FILE_ASSET_READ_EFFECTS };

export async function stageAttachmentInputs({ sessionId, runId, turnId, attachments = [] } = {}) {
  const normalizedSessionId = trimString(sessionId);
  const normalizedRunId = trimString(runId);
  const normalizedTurnId = trimString(turnId);
  if (!normalizedSessionId || !normalizedRunId || !normalizedTurnId) {
    throw createStagingError('sessionId, runId, and turnId are required', 'FILE_ASSET_INPUT_SCOPE_REQUIRED', 400);
  }
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { attachments: [], operations: [], staging: null };
  }

  const { realInputRoot } = await ensureInputRoot(normalizedRunId);
  try {
    const staged = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const entry = await stageOneAttachment({
        sessionId: normalizedSessionId,
        runId: normalizedRunId,
        turnId: normalizedTurnId,
        inputRoot: realInputRoot,
        attachment: attachments[index],
        index,
      });
      staged.push(entry);
    }
    const operations = staged.map((entry) => entry.operation).filter(Boolean);
    const decision = aggregateDecisions(operations.map((operation) => operation.decision));
    if (decision !== 'ALLOW') {
      throw createStagingError('Attachment input staging was not allowlisted', 'FILE_ASSET_INPUT_POLICY_DENIED');
    }
    return {
      attachments: staged.map((entry) => entry.descriptor),
      operations,
      staging: {
        schemaVersion: FILE_ASSET_INPUT_STAGING_SCHEMA_VERSION,
        operation: FILE_ASSET_READ_OPERATION,
        decision,
        scope: {
          sessionId: normalizedSessionId,
          runId: normalizedRunId,
          turnId: normalizedTurnId,
          computed: true,
        },
        effects: [...FILE_ASSET_READ_EFFECTS],
        operations,
      },
    };
  } catch (error) {
    await rm(realInputRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
