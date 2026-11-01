// Voluntary first-party content reports. No account, workbench, model or
// conversation credential is required or copied into the report repository.
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const CONTENT_REPORT_REASONS = Object.freeze([
  'unsafe', 'hate_or_harassment', 'sexual_content', 'privacy', 'deceptive', 'other',
]);
export const CONTENT_REPORT_STATUSES = Object.freeze(['received', 'in_review', 'closed']);
export const CONTENT_REPORT_BODY_LIMIT = 24 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPLICATION_ID = 0x41475250;
const KEYS = new Set(['schemaVersion', 'requestId', 'reason', 'details', 'includeContent', 'content', 'appVersion']);
function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}
export function validateContentReportId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure('content_report_id_invalid');
  return value;
}
export function normalizeContentReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !KEYS.has(key)) || input.schemaVersion !== 1
    || !CONTENT_REPORT_REASONS.includes(input.reason) || typeof input.includeContent !== 'boolean') {
    throw failure('content_report_invalid');
  }
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw failure('content_report_invalid');
    return value.trim();
  };
  const content = text(input.content, 4000);
  if (!input.includeContent && content) throw failure('content_report_content_not_selected');
  return { schemaVersion: 1, requestId: validateContentReportId(input.requestId), reason: input.reason,
    details: text(input.details, 1000), includeContent: input.includeContent, content,
    appVersion: text(input.appVersion, 64) };
}

// Separate bounded SQLite repository; never add user report bodies to the
// Accounts mutate(draft) snapshot or auth Postgres schema.
export async function createContentReportStore({ filePath, clock = Date.now,
  maxReports = 5000, maxPayloadBytes = 16 * 1024 * 1024, maxPerHour = 100,
  create = true, readOnly = false } = {}) {
  if (readOnly) create = false;
  if (!filePath || !isAbsolute(filePath) || filePath.includes('\0')) throw failure('content_report_store_path_invalid');
  for (const value of [maxReports, maxPayloadBytes, maxPerHour]) {
    if (!Number.isSafeInteger(value) || value < 1) throw failure('content_report_store_limits_invalid');
  }
  const file = resolve(filePath), parent = dirname(file);
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  const realParent = await realpath(parent);
  if ((process.platform === 'win32' ? realParent.toLowerCase() !== parent.toLowerCase() : realParent !== parent)
    || (await lstat(parent)).isSymbolicLink()) throw failure('content_report_store_path_invalid');
  try {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || (!create && stats.size === 0)) throw failure('content_report_store_path_invalid');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    try { const handle = await open(file, 'wx', 0o600); await handle.close(); }
    catch (created) { if (created.code !== 'EEXIST') throw created; }
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) throw failure('content_report_store_path_invalid');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { timeout: 500, readOnly });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const application = db.prepare('PRAGMA application_id').get().application_id;
    const fresh = version === 0 && application === 0
      && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
    if (!(version === 1 && application === APPLICATION_ID) && !(create && !readOnly && fresh)) {
      throw failure('content_report_schema_unsupported', 503);
    }
    db.exec('PRAGMA trusted_schema=OFF;');
    if (!readOnly) db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS content_reports (
        request_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
        payload_json TEXT, payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
        received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('received','in_review','closed'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS content_reports_received ON content_reports(received_at);
      PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
  } catch (error) { db.close(); throw error; }
  const select = db.prepare('SELECT * FROM content_reports WHERE request_id=?');
  const receipt = row => ({ contractVersion: 1, requestId: row.request_id,
    receipt: { id: `report_${row.request_id}`, status: row.status,
      receivedAt: new Date(row.received_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() } });
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    submit(input) {
      const value = normalizeContentReport(input), payload = JSON.stringify(value);
      const digest = createHash('sha256').update(payload).digest('hex');
      const bytes = Buffer.byteLength(payload);
      return transaction(() => {
        const previous = select.get(value.requestId);
        if (previous) {
          if (previous.payload_digest !== digest) throw failure('content_report_conflict', 409);
          // Redacted payloads cannot be restored by replaying an old POST.
          return receipt(previous);
        }
        const now = clock();
        const totals = db.prepare(`SELECT count(*) AS reports, coalesce(sum(payload_bytes),0) AS bytes,
          coalesce(sum(CASE WHEN received_at > ? THEN 1 ELSE 0 END),0) AS recent FROM content_reports`).get(now - 3600000);
        if (totals.reports >= maxReports || totals.bytes + bytes > maxPayloadBytes) throw failure('content_report_capacity', 503);
        if (totals.recent >= maxPerHour) throw failure('content_report_rate_limited', 429);
        db.prepare(`INSERT INTO content_reports(request_id,payload_digest,payload_json,payload_bytes,received_at,updated_at,status)
          VALUES(?,?,?,?,?,?,'received')`).run(value.requestId, digest, payload, bytes, now, now);
        return receipt(select.get(value.requestId));
      });
    },
    get(requestId) {
      const row = select.get(validateContentReportId(requestId));
      return row ? receipt(row) : null;
    },
    // Operator-only local API: never exposed through HTTP.
    list({ limit = 50 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw failure('content_report_limit_invalid');
      return db.prepare('SELECT * FROM content_reports ORDER BY received_at DESC, request_id LIMIT ?').all(limit).map(receipt);
    },
    readContent(requestId) {
      const row = select.get(validateContentReportId(requestId));
      return row?.payload_json ? JSON.parse(row.payload_json) : null;
    },
    setStatus(requestId, status, { eraseContent = false } = {}) {
      validateContentReportId(requestId);
      if (!CONTENT_REPORT_STATUSES.includes(status) || typeof eraseContent !== 'boolean'
        || (eraseContent && status !== 'closed')) throw failure('content_report_status_invalid');
      return transaction(() => {
        const row = select.get(requestId);
        if (!row) throw failure('content_report_not_found', 404);
        if (row.status === 'closed' && status !== 'closed') throw failure('content_report_status_conflict', 409);
        if (row.status === 'in_review' && status === 'received') throw failure('content_report_status_conflict', 409);
        db.prepare(`UPDATE content_reports SET status=?, updated_at=?,
          payload_json=CASE WHEN ? THEN NULL ELSE payload_json END,
          payload_bytes=CASE WHEN ? THEN 0 ELSE payload_bytes END WHERE request_id=?`)
          .run(status, clock(), Number(eraseContent), Number(eraseContent), requestId);
        return receipt(select.get(requestId));
      });
    },
    close() { db.close(); },
  };
}

export async function handleContentReportRoutes({ req, res, pathname, store } = {}) {
  const match = /^\/v1\/content-reports(?:\/([0-9a-f-]{36}))?$/.exec(pathname || '');
  if (!match) return false;
  const respond = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(body));
  };
  if (!store) { respond(503, { code: 'content_report_unavailable' }); return true; }
  if ((req.method !== 'POST' || match[1]) && (req.method !== 'GET' || !match[1])) {
    respond(405, { code: 'content_report_method_not_allowed' }); return true;
  }
  try {
    if (req.method === 'GET') {
      const value = store.get(match[1]);
      respond(value ? 200 : 404, value || { code: 'content_report_not_found' });
    } else {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw failure('content_report_json_required', 415);
      const declared = Number(req.headers?.['content-length']);
      if (Number.isFinite(declared) && declared > CONTENT_REPORT_BODY_LIMIT) throw failure('content_report_too_large', 413);
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > CONTENT_REPORT_BODY_LIMIT) throw failure('content_report_too_large', 413);
        chunks.push(data);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw failure('content_report_invalid'); }
      respond(201, store.submit(body));
    }
  } catch (error) {
    const known = typeof error.code === 'string' && error.code.startsWith('content_report_');
    respond(known ? error.statusCode || 400 : 503, { code: known ? error.code : 'content_report_unavailable' });
  }
  return true;
}
