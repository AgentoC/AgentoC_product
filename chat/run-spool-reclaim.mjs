// DS-14: offline read-only spool scanner + validated dedupe migration.
//
// History: writers used to store every structured spool record as both
// `json` (the object) and `line = JSON.stringify(json)` (the same text) —
// roughly doubled structured spool size. Runs.mjs now drops the duplicate at
// write time (normalizeSpoolRecord), but spools written before that change
// still carry both fields. This module:
//
//   - scans run spools read-only (streaming, never readFile's whole files):
//     structured records, raw-only records, duplicate-equivalent records
//     (line === JSON.stringify(json)), lineArtifact refs (and missing ones),
//     plain/gz/zst state, terminal age, bad/oversized lines;
//   - estimates reclaimable bytes (the serialized size of the dropped `line`
//     field per duplicate record);
//   - migrates a plain spool to a deduplicated copy in an out directory, only
//     when the run is terminal AND the written copy verifies: sha256 of the
//     written bytes matches what was written, record count is preserved, and
//     the trailing record is byte-identical to the original's. Unparseable
//     lines are copied verbatim so a migration is always lossless. The
//     original spool is never touched or deleted.
//
// CLI entrypoint: scripts/scan-run-spools.mjs. Default is dry-run.

import { createReadStream } from 'fs';
import { createHash } from 'crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { join } from 'path';
import { createGunzip, createZstdDecompress } from 'zlib';
import { formatBytes, TERMINAL_STATES } from './run-spool-archive.mjs';

const SPOOL_FILE = 'spool.jsonl';
const SPOOL_FILE_GZ = 'spool.jsonl.gz';
const SPOOL_FILE_ZST = 'spool.jsonl.zst';
const SPOOL_META_FILE = 'spool.jsonl.meta.json';
// Same cap as runs.mjs MAX_SPOOL_RECORD_CHARS: a single line beyond this is
// counted as oversized and skipped (never materialized).
const MAX_RECORD_CHARS = 2 * 1024 * 1024;
// Scan chunk size for the streaming read. Kept small so multi-byte UTF-8
// sequences straddling chunk boundaries are exercised in tests; the readline
// decoder handles them correctly regardless.
const SCAN_HIGH_WATER_MARK = 64 * 1024;

// True when the record carries both `json` and a `line` that is exactly its
// serialization — a pure duplicate that runs.mjs normalizeSpoolRecord now
// drops at write time (and that every reader ignores, preferring `json`).
export function isDuplicateLineRecord(record) {
  return !!record
    && typeof record.json === 'object'
    && typeof record.line === 'string'
    && record.line === JSON.stringify(record.json);
}

// The deduplicated form of the record (line field removed), or null when the
// record is not a duplicate. Never mutates the input.
export function dedupeRecord(record) {
  if (!isDuplicateLineRecord(record)) return null;
  const next = { ...record };
  delete next.line;
  return next;
}

// Yield { raw, record } per line of a (possibly compressed) spool file,
// counting what does not parse. UTF-8-safe: readline decodes the stream
// incrementally, so multi-byte characters straddling chunk boundaries stay
// intact. Unparseable and oversized lines yield record === null and are never
// skipped silently — callers decide (scan counts them, migration copies them).
export async function* iterateSpoolRecords(path, { highWaterMark = SCAN_HIGH_WATER_MARK } = {}) {
  // Compressed spools must be fed to the decompressor as raw Buffers — a utf8
  // string encoding on the read stream would corrupt the binary gzip/zstd
  // framing before decompression. readline's internal StringDecoder handles
  // the decompressed Buffer chunks, keeping multi-byte UTF-8 safe across
  // chunk boundaries (exercised by tests with tiny highWaterMarks).
  const compressed = path.endsWith('.gz') || path.endsWith('.zst');
  let input = createReadStream(path, { encoding: compressed ? undefined : 'utf8', highWaterMark });
  if (path.endsWith('.gz')) {
    input = input.pipe(createGunzip());
  } else if (path.endsWith('.zst')) {
    input = input.pipe(createZstdDecompress());
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    if (raw.length > MAX_RECORD_CHARS) {
      yield { raw, record: null, oversized: true };
      continue;
    }
    let record = null;
    try {
      record = JSON.parse(raw);
    } catch {
      // bad line: record stays null
    }
    yield { raw, record, oversized: false };
  }
}

function artifactExists(runDir, ref) {
  return stat(join(runDir, 'artifacts', `${ref}.txt`))
    .then(() => true)
    .catch(() => false);
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// Scan one run directory. Read-only: never opens anything for writing.
export async function scanRunSpool(runDir, options = {}) {
  const { highWaterMark } = options;
  const status = await readJsonOrNull(join(runDir, 'status.json')) || {};
  const state = String(status.state || '');
  const terminal = TERMINAL_STATES.has(state);

  const plain = join(runDir, SPOOL_FILE);
  const gz = join(runDir, SPOOL_FILE_GZ);
  const zst = join(runDir, SPOOL_FILE_ZST);
  const [plainStat, gzStat, zstStat] = await Promise.all([stat(plain).catch(() => null), stat(gz).catch(() => null), stat(zst).catch(() => null)]);
  const form = plainStat ? 'plain' : (gzStat ? 'gz' : (zstStat ? 'zst' : 'none'));
  const spoolPath = form === 'plain' ? plain : (form === 'gz' ? gz : zst);
  const spoolBytes = plainStat?.size ?? gzStat?.size ?? zstStat?.size ?? 0;

  const stats = {
    runId: join(runDir).split(/[\\/]/).pop(),
    state,
    terminal,
    terminalAgeMs: null,
    form,
    spoolBytes,
    totalRecords: 0,
    parseableRecords: 0,
    badLines: 0,
    oversizedLines: 0,
    structuredRecords: 0,
    rawOnlyRecords: 0,
    duplicateRecords: 0,
    duplicateBytes: 0,
    lineArtifactRefs: 0,
    missingArtifactRefs: 0,
    lastRecord: null,
  };

  if (form === 'none') return stats;

  const meta = await readJsonOrNull(join(runDir, SPOOL_META_FILE));
  const completedAt = status.completedAt || status.updatedAt || null;
  if (terminal) {
    const ageAnchor = Date.parse(completedAt || '');
    stats.terminalAgeMs = Math.max(0, Date.now() - (Number.isFinite(ageAnchor) ? ageAnchor : (plainStat?.mtimeMs ?? Date.now())));
  }

  const artifactRefs = [];
  for await (const { raw, record, oversized } of iterateSpoolRecords(spoolPath, { highWaterMark })) {
    stats.totalRecords += 1;
    if (oversized) {
      stats.oversizedLines += 1;
      continue;
    }
    if (!record) {
      stats.badLines += 1;
      continue;
    }
    stats.parseableRecords += 1;
    if (record.json && typeof record.json === 'object') {
      stats.structuredRecords += 1;
    } else {
      stats.rawOnlyRecords += 1;
    }
    if (isDuplicateLineRecord(record)) {
      stats.duplicateRecords += 1;
      const deduped = dedupeRecord(record);
      stats.duplicateBytes += Buffer.byteLength(JSON.stringify(record), 'utf8') - Buffer.byteLength(JSON.stringify(deduped), 'utf8');
    }
    if (typeof record.lineArtifact === 'string' && record.lineArtifact) {
      stats.lineArtifactRefs += 1;
      artifactRefs.push(record.lineArtifact);
    }
    stats.lastRecord = record;
  }

  if (artifactRefs.length > 0) {
    const present = await Promise.all(artifactRefs.map((ref) => artifactExists(runDir, ref)));
    stats.missingArtifactRefs = present.filter((ok) => !ok).length;
  }

  return stats;
}

// Scan every run_* directory under the chat-runs root. `limit` bounds the
// number of runs scanned; `onRun` (optional) receives each scan result.
export async function scanAllRunSpools({ root, limit = Infinity, onRun = null, highWaterMark } = {}) {
  const runsRoot = join(root, 'chat-runs');
  let names = [];
  try {
    names = await readdir(runsRoot);
  } catch {
    return { runsRoot, scanned: 0, error: `runs dir not readable: ${runsRoot}`, runs: [] };
  }
  names = names.filter((name) => name.startsWith('run_'));
  if (Number.isFinite(limit) && limit > 0) names = names.slice(0, limit);

  const runs = [];
  for (const name of names) {
    const runDir = join(runsRoot, name);
    try {
      const scan = await scanRunSpool(runDir, { highWaterMark });
      runs.push(scan);
      if (onRun) onRun(scan);
    } catch (error) {
      runs.push({
        runId: name,
        state: '',
        terminal: false,
        terminalAgeMs: null,
        form: 'none',
        spoolBytes: 0,
        totalRecords: 0,
        parseableRecords: 0,
        badLines: 0,
        oversizedLines: 0,
        structuredRecords: 0,
        rawOnlyRecords: 0,
        duplicateRecords: 0,
        duplicateBytes: 0,
        lineArtifactRefs: 0,
        missingArtifactRefs: 0,
        lastRecord: null,
        scanError: String(error?.message || error),
      });
    }
  }

  const totals = {
    runsScanned: runs.length,
    runsWithSpool: 0,
    plain: 0,
    gz: 0,
    zst: 0,
    terminalRuns: 0,
    totalRecords: 0,
    parseableRecords: 0,
    badLines: 0,
    oversizedLines: 0,
    structuredRecords: 0,
    rawOnlyRecords: 0,
    duplicateRecords: 0,
    duplicateBytes: 0,
    lineArtifactRefs: 0,
    missingArtifactRefs: 0,
    oldestTerminalAgeMs: null,
    oldestTerminalAgeRun: null,
  };
  for (const run of runs) {
    if (run.form !== 'none') {
      totals.runsWithSpool += 1;
      if (run.form === 'plain') totals.plain += 1;
      if (run.form === 'gz') totals.gz += 1;
      if (run.form === 'zst') totals.zst += 1;
    }
    if (run.terminal) totals.terminalRuns += 1;
    totals.totalRecords += run.totalRecords;
    totals.parseableRecords += run.parseableRecords;
    totals.badLines += run.badLines;
    totals.oversizedLines += run.oversizedLines;
    totals.structuredRecords += run.structuredRecords;
    totals.rawOnlyRecords += run.rawOnlyRecords;
    totals.duplicateRecords += run.duplicateRecords;
    totals.duplicateBytes += run.duplicateBytes;
    totals.lineArtifactRefs += run.lineArtifactRefs;
    totals.missingArtifactRefs += run.missingArtifactRefs;
    if (Number.isInteger(run.terminalAgeMs) && (totals.oldestTerminalAgeMs === null || run.terminalAgeMs > totals.oldestTerminalAgeMs)) {
      totals.oldestTerminalAgeMs = run.terminalAgeMs;
      totals.oldestTerminalAgeRun = run.runId;
    }
  }
  return { runsRoot, scanned: runs.length, runs, totals };
}

// Migrate one plain spool to a deduplicated copy under `outDir` (original
// untouched). Refuses when the run is not terminal (live spools are still
// appended to; deduping them mid-write would race the writer) or when the
// spool is already archived. After writing, the copy is re-read and verified:
// sha256 of the bytes matches, record count matches, and the trailing record
// is byte-identical to the original's. Unparseable lines are copied verbatim
// (lossless migration). Returns { ok, reasons, writtenPath, validation }.
export async function migrateRunSpool(runDir, { outDir, throttleMs = 0, onProgress = null } = {}) {
  const reasons = [];
  const status = await readJsonOrNull(join(runDir, 'status.json')) || {};
  const state = String(status.state || '');
  if (!TERMINAL_STATES.has(state)) {
    reasons.push(`run is not terminal (state=${state || 'unknown'})`);
    return { ok: false, reasons, writtenPath: null, validation: null };
  }

  const spoolPath = join(runDir, SPOOL_FILE);
  const spoolStat = await stat(spoolPath).catch(() => null);
  if (!spoolStat) {
    reasons.push('plain spool missing (already archived or never written)');
    return { ok: false, reasons, writtenPath: null, validation: null };
  }

  const runId = join(runDir).split(/[\\/]/).pop();
  const outPath = join(outDir, `${runId}.spool.jsonl`);
  const expectedHash = createHash('sha256');
  const written = [];
  const lastRaw = { value: null };

  for await (const { raw, record } of iterateSpoolRecords(spoolPath)) {
    const line = record ? dedupeRecord(record) || record : record;
    const serialized = record ? JSON.stringify(line) : raw;
    written.push(serialized);
    expectedHash.update(`${serialized}\n`, 'utf8');
    lastRaw.value = record ? serialized : raw;
    if (throttleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, throttleMs));
    }
    if (onProgress && written.length % 1000 === 0) onProgress(written.length);
  }

  if (written.length === 0) {
    reasons.push('spool has no lines to migrate');
    return { ok: false, reasons, writtenPath: null, validation: null };
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, `${written.join('\n')}\n`, 'utf8');
  const expected = expectedHash.digest('hex');

  // Verify pass: re-read the written copy and compare hash / count / trailing
  // (raw last line, parseable or not — bad lines are copied verbatim).
  const verifyHash = createHash('sha256');
  let verifiedCount = 0;
  let verifiedLast = null;
  for await (const { raw } of iterateSpoolRecords(outPath)) {
    verifyHash.update(`${raw}\n`, 'utf8');
    verifiedCount += 1;
    verifiedLast = raw;
  }
  const validation = {
    hashOk: verifyHash.digest('hex') === expected,
    countOk: verifiedCount === written.length,
    trailingOk: verifiedLast === lastRaw.value,
  };
  const ok = validation.hashOk && validation.countOk && validation.trailingOk;
  if (!ok) {
    reasons.push(
      `verification failed: hashOk=${validation.hashOk} countOk=${validation.countOk} trailingOk=${validation.trailingOk} `,
    );
    return { ok: false, reasons, writtenPath: outPath, validation };
  }
  return { ok: true, reasons: [], writtenPath: outPath, validation };
}

export { formatBytes };
