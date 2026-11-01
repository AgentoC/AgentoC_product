// Private immutable download snapshots. Every HTTP entry must authorize the
// exact Session and download capability before invoking this module.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue, readJsonStrict, writeJsonAtomic } from './fs-utils.mjs';
import { getFileAsset, localizeFileAsset } from './file-assets.mjs';
import { getRun } from './runs.mjs';
import { getMessageSubmissionReceipt, getRetainedRunReplyPublication,
  getRetainedRunExportPublication } from './session-manager.mjs';

export const RESULT_EXPORT_CHUNK_BYTES = 64 * 1024;
export const RESULT_EXPORT_FILE_BYTES = 25 * 1024 * 1024;
export const RESULT_EXPORT_BATCH_BYTES = 100 * 1024 * 1024;
export const RESULT_EXPORT_TTL_MS = 15 * 60 * 1000;
const CACHE_BYTES = 256 * 1024 * 1024;
const CACHE_ROOT = resolve(CONFIG_DIR, 'result-exports', 'v1');
const snapshotQueue = createSerialTaskQueue();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, statusCode, message) => { throw Object.assign(new Error(message), { code, statusCode }); };

function cachePath(name) {
  if (!/^(?:[a-f0-9]{64}|building-[a-f0-9-]{36})$/.test(name)) fail('RESULT_EXPORT_INVALID', 400, 'Invalid export identity');
  const path = resolve(CACHE_ROOT, name);
  if (dirname(path) !== CACHE_ROOT) fail('RESULT_EXPORT_INVALID', 400, 'Invalid export path');
  return path;
}

function revisionOf(manifest) {
  return digest(JSON.stringify([manifest.instanceId, manifest.sessionId, manifest.requestId,
    manifest.runId, manifest.finalRunId, manifest.resources]));
}

function displayName(value, fallback) {
  return Array.from(String(value || fallback).trim().replace(/[\\/\u0000-\u001f\u007f]/g, '_')).slice(0, 255).join('') || fallback;
}

function mimeType(value) {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)
    ? value : 'application/octet-stream';
}

async function retained(context, complete) {
  const receipt = await getMessageSubmissionReceipt(context.sessionId, context.requestId);
  const run = receipt.runId ? await getRun(receipt.runId) : null;
  if (!run || run.sessionId !== context.sessionId || run.requestId !== context.requestId || run.state !== 'completed') {
    fail('RESULT_EXPORT_INCOMPLETE', 409, 'The exact submission has no completed result');
  }
  const publication = await (complete ? getRetainedRunExportPublication(run) : getRetainedRunReplyPublication(run));
  if (!publication?.ready || publication.rootRunId !== run.id) fail('RESULT_EXPORT_INCOMPLETE', 409, 'Result publication is not ready');
  return { run, publication };
}

async function cleanup(now) {
  let bytes = 0; let count = 0;
  for (const entry of await readdir(CACHE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:[a-f0-9]{64}|building-[a-f0-9-]{36})$/.test(entry.name)) continue;
    const path = cachePath(entry.name);
    const info = await lstat(path);
    const manifest = entry.name.startsWith('building-') ? null : await readJsonStrict(join(path, 'manifest.json')).catch(() => null);
    if ((manifest && Date.parse(manifest.expiresAt) <= now) || (!manifest && now - info.mtimeMs > RESULT_EXPORT_TTL_MS)) {
      // The generated direct child is checked above before recursive removal.
      await rm(path, { recursive: true, force: true });
      continue;
    }
    bytes += Number.isSafeInteger(manifest?.totalBytes) ? manifest.totalBytes : RESULT_EXPORT_BATCH_BYTES;
    count++;
  }
  return { bytes, count };
}

async function copyAsset(asset, destination, authorize) {
  await authorize?.();
  const source = await localizeFileAsset(asset);
  await authorize?.();
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > RESULT_EXPORT_FILE_BYTES) {
    fail('RESULT_EXPORT_TOO_LARGE', 413, 'Result file exceeds the export budget or is not a regular file');
  }
  const hash = createHash('sha256'); let size = 0;
  await pipeline(createReadStream(source), new Transform({
    transform(chunk, encoding, callback) {
      const accept = () => {
        size += chunk.length;
        if (size > RESULT_EXPORT_FILE_BYTES) return callback(Object.assign(new Error('File exceeds export budget'), { code: 'RESULT_EXPORT_TOO_LARGE', statusCode: 413 }));
        hash.update(chunk); callback(null, chunk);
      };
      if (authorize) Promise.resolve().then(authorize).then(accept, callback);
      else accept();
    },
  }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  const sha256 = hash.digest('hex');
  if (size !== sourceInfo.size || (asset.sizeBytes != null && asset.sizeBytes !== size) ||
      (asset.sha256 && asset.sha256 !== sha256)) fail('RESULT_EXPORT_CHANGED', 409, 'Result file integrity differs');
  return { sizeBytes: size, sha256 };
}

/** Explicit read/cache operation; creates no Session, message, Run or upload. */
export async function createMessageResultExport(context, { authorize } = {}) {
  return snapshotQueue(async () => {
    await authorize?.();
    await mkdir(CACHE_ROOT, { recursive: true, mode: 0o700 });
    const now = Date.now(); const cache = await cleanup(now);
    const { run, publication } = await retained(context, true);
    const attachments = publication.payload.attachments || [];
    if (!Array.isArray(attachments) || attachments.length > 16) fail('RESULT_EXPORT_TOO_LARGE', 413, 'Result has too many export resources');
    const staging = cachePath(`building-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const text = Buffer.from(publication.payload.text, 'utf8');
      await writeFile(join(staging, '0.bin'), text, { flag: 'wx', mode: 0o600 });
      const resources = [{ resourceId: 'text', originalName: 'result.txt', mimeType: 'text/plain',
        available: true, sizeBytes: text.length, sha256: digest(text) }];
      let totalBytes = text.length;
      const seen = new Set();
      for (const [index, item] of attachments.entries()) {
        const resourceId = typeof item?.assetId === 'string' ? item.assetId : '';
        if (!/^fasset_[a-f0-9]{24}$/.test(resourceId)) {
          resources.push({ resourceId: `reference_${index}`, originalName: displayName(item?.originalName, 'Result reference'),
            mimeType: 'application/octet-stream', available: false, errorCode: 'CAPABILITY_UNSUPPORTED' });
          continue;
        }
        if (seen.has(resourceId)) continue;
        seen.add(resourceId);
        const asset = await getFileAsset(resourceId);
        if (!asset || asset.sessionId !== context.sessionId || asset.status !== 'ready') {
          fail('RESULT_EXPORT_CHANGED', 409, 'Published result file is unavailable or belongs to another Session');
        }
        if (asset.sizeBytes > RESULT_EXPORT_FILE_BYTES) {
          resources.push({ resourceId, originalName: displayName(asset.originalName, 'Result file'),
            mimeType: mimeType(asset.mimeType), available: false, errorCode: 'RESOURCE_LIMIT' });
          continue;
        }
        const metadata = await copyAsset(asset, join(staging, `${resources.length}.bin`), authorize);
        totalBytes += metadata.sizeBytes;
        if (totalBytes > RESULT_EXPORT_BATCH_BYTES) fail('RESULT_EXPORT_TOO_LARGE', 413, 'Result exceeds the batch export budget');
        resources.push({ resourceId, originalName: displayName(asset.originalName, 'Result file'),
          mimeType: mimeType(asset.mimeType), available: true, ...metadata });
      }
      const manifest = { exportContractVersion: 1, ...context, runId: run.id,
        finalRunId: publication.finalRunId || run.id, resources, totalBytes,
        maxChunkBytes: RESULT_EXPORT_CHUNK_BYTES, expiresAt: new Date(now + RESULT_EXPORT_TTL_MS).toISOString() };
      manifest.revision = revisionOf(manifest);
      const destination = cachePath(manifest.revision);
      const existing = await readJsonStrict(join(destination, 'manifest.json')).catch(() => null);
      if (existing && Date.parse(existing.expiresAt) > now && revisionOf(existing) === manifest.revision) {
        await authorize?.(); return existing;
      }
      if (cache.bytes + totalBytes > CACHE_BYTES || cache.count >= 64) fail('RESULT_EXPORT_CACHE_FULL', 507, 'Export cache budget is full');
      await writeJsonAtomic(join(staging, 'manifest.json'), manifest);
      await authorize?.();
      await rename(staging, destination);
      return manifest;
    } finally {
      // Only this validated generated staging child is removed, never the published snapshot.
      await rm(staging, { recursive: true, force: true });
    }
  });
}

/** Fixed-size transfer; the immutable bytes and digest survive server restart. */
export async function readMessageResultExportChunk(context, resourceId, query, { authorize } = {}) {
  await authorize?.();
  const revision = query.revision;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) ||
      typeof query.offset !== 'string' || !/^(0|[1-9][0-9]*)$/.test(query.offset) ||
      typeof query.length !== 'string' || !/^[1-9][0-9]*$/.test(query.length)) fail('RESULT_EXPORT_INVALID', 400, 'Invalid chunk request');
  const offset = Number(query.offset); const length = Number(query.length);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length > RESULT_EXPORT_CHUNK_BYTES) fail('RESULT_EXPORT_INVALID', 400, 'Chunk request exceeds limits');
  const directory = cachePath(revision);
  if (!(await lstat(directory).catch(() => null))?.isDirectory()) fail('RESULT_EXPORT_EXPIRED', 410, 'Download snapshot is unavailable');
  const manifest = await readJsonStrict(join(directory, 'manifest.json'));
  if (manifest.exportContractVersion !== 1 || manifest.revision !== revision || revisionOf(manifest) !== revision ||
      ['instanceId', 'sessionId', 'requestId'].some(key => manifest[key] !== context[key])) fail('RESULT_EXPORT_CHANGED', 409, 'Export identity differs');
  if (!Number.isFinite(Date.parse(manifest.expiresAt)) || Date.parse(manifest.expiresAt) <= Date.now()) fail('RESULT_EXPORT_EXPIRED', 410, 'Download snapshot expired');
  const { run, publication } = await retained(context, false);
  await authorize?.();
  if (manifest.runId !== run.id || manifest.finalRunId !== (publication.finalRunId || run.id)) fail('RESULT_EXPORT_CHANGED', 409, 'Result publication changed');
  const index = manifest.resources.findIndex(value => value.resourceId === resourceId);
  const resource = manifest.resources[index];
  if (!resource?.available) fail('RESULT_EXPORT_RESOURCE_UNAVAILABLE', 404, 'Result resource is not downloadable');
  if (!Number.isSafeInteger(resource.sizeBytes) || resource.sizeBytes < 0 || offset > resource.sizeBytes) fail('RESULT_EXPORT_INVALID', 400, 'Invalid resource offset');
  const path = join(directory, `${index}.bin`);
  const fileInfo = await lstat(path);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== resource.sizeBytes) fail('RESULT_EXPORT_CHANGED', 409, 'Cached resource differs');
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(length, resource.sizeBytes - offset));
    let read = 0;
    while (read < buffer.length) {
      const result = await file.read(buffer, read, buffer.length - read, offset + read);
      if (!result.bytesRead) fail('RESULT_EXPORT_CHANGED', 409, 'Cached resource ended early');
      read += result.bytesRead;
    }
    await authorize?.();
    return { exportContractVersion: 1, ...context, runId: manifest.runId, finalRunId: manifest.finalRunId,
      revision, resourceId, offset, nextOffset: offset + buffer.length, eof: offset + buffer.length === resource.sizeBytes,
      sizeBytes: resource.sizeBytes, sha256: resource.sha256, chunkSha256: digest(buffer), dataBase64: buffer.toString('base64') };
  } finally { await file.close(); }
}
