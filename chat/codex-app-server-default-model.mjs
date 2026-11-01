import { join } from 'node:path';

export async function prepareImplicitCodexAppServerModel({ codexHomeDir, readAuth, readPreferred } = {}) {
  const auth = codexHomeDir ? await readAuth(join(codexHomeDir, 'auth.json')) : null;
  const needsAccountCatalog = auth?.auth_mode === 'chatgpt' && auth.tokens
    && typeof auth.tokens === 'object' && !Array.isArray(auth.tokens);
  return needsAccountCatalog
    ? { model: '', needsAccountCatalog: true }
    : { model: await readPreferred({ homeDir: codexHomeDir }), needsAccountCatalog: false };
}

export function selectCodexAccountDefaultModel(models) {
  const empty = () => Object.assign(new Error('CODEX_ACCOUNT_MODEL_CATALOG_EMPTY'), { code: 'CODEX_ACCOUNT_MODEL_CATALOG_EMPTY' });
  if (!Array.isArray(models)) throw empty();
  const valid = models.filter((entry) => entry?.hidden !== true
    && typeof entry?.id === 'string' && entry.id.trim());
  const selected = valid.find((entry) => entry.isDefault === true) || valid[0];
  if (!selected) throw empty();
  return selected.id.trim();
}

// For callers that already own their catalog transport. Run startup instead
// prepares locally and negotiates over its authorized app-server below.
export async function resolveImplicitCodexAppServerModel({
  codexHomeDir,
  readAuth,
  listModels,
  readPreferred,
} = {}) {
  const choice = await prepareImplicitCodexAppServerModel({ codexHomeDir, readAuth, readPreferred });
  if (!choice.needsAccountCatalog) return choice.model;
  // The account and installed CLI version jointly determine the usable model
  // set. A stale config.toml can name a model that model/list no longer offers.
  let models;
  try {
    models = await listModels({ codexHomeDir, timeoutMs: 8_000 });
  } catch (error) {
    throw new Error('CODEX_ACCOUNT_MODEL_CATALOG_UNAVAILABLE', { cause: error });
  }
  return selectCodexAccountDefaultModel(models);
}

/** One bounded catalog exchange on the existing Run-owned stdio/proxy. No spawn. */
export function createCodexAccountModelCatalog({
  nextRequestId, sendRequest, beforeReady, onReady, onFailure,
  timeoutMs = 8_000, maxPages = 16, maxEntries = 1024,
  maxResponseBytes = 1024 * 1024, now = () => performance.now(),
} = {}) {
  let started = false;
  let settled = false;
  let requestId = null;
  let timer = null;
  let deadline = 0;
  let pages = 0;
  let entryCount = 0;
  const models = new Map();
  const cursors = new Set();
  const ownedRequestIds = new Set();
  const error = (code) => Object.assign(new Error(code), { code });
  const close = () => { settled = true; requestId = null; clearTimeout(timer); timer = null; };
  const fail = async (failure) => {
    if (settled) return;
    close();
    await onFailure(failure);
  };
  const failInBackground = (failure) => { void fail(failure).catch(() => {}); };
  const requestPage = (cursor = '') => {
    if (++pages > maxPages) throw error('CODEX_ACCOUNT_MODEL_CATALOG_LIMIT');
    requestId = nextRequestId();
    if (!(typeof requestId === 'number' || typeof requestId === 'string')) throw error('CODEX_STDIN_CLOSED');
    ownedRequestIds.add(requestId);
    if (!sendRequest({ id: requestId, cursor })) throw error('CODEX_STDIN_CLOSED');
  };
  return {
    start() {
      if (started || settled) return false;
      started = true;
      deadline = now() + timeoutMs;
      timer = setTimeout(() => failInBackground(error('CODEX_ACCOUNT_MODEL_CATALOG_TIMEOUT')), timeoutMs);
      timer.unref?.();
      try { requestPage(); } catch (failure) { failInBackground(failure); return false; }
      return true;
    },
    async consume(message) {
      if (!started || !ownedRequestIds.has(message?.id)) return false;
      // Swallow late owned RPC replies so the general startup error handler
      // cannot overwrite a timeout/cancellation or fail a later catalog page.
      if (settled || requestId === null || message.id !== requestId) return true;
      requestId = null;
      try {
        if (now() >= deadline) throw error('CODEX_ACCOUNT_MODEL_CATALOG_TIMEOUT');
        if (Buffer.byteLength(JSON.stringify(message), 'utf8') > maxResponseBytes) {
          throw error('CODEX_ACCOUNT_MODEL_CATALOG_LIMIT');
        }
        if (message.error) throw error('CODEX_ACCOUNT_MODEL_CATALOG_UNAVAILABLE');
        const result = message.result;
        if (!result || !Array.isArray(result.data)) throw error('CODEX_ACCOUNT_MODEL_CATALOG_INVALID');
        for (const entry of result.data) {
          if (++entryCount > maxEntries) throw error('CODEX_ACCOUNT_MODEL_CATALOG_LIMIT');
          const id = typeof entry?.model === 'string' && entry.model.trim()
            ? entry.model.trim() : typeof entry?.id === 'string' ? entry.id.trim() : '';
          if (!id || entry.hidden === true) continue;
          const prior = models.get(id);
          models.set(id, { id, isDefault: entry.isDefault === true || prior?.isDefault === true });
        }
        const cursor = result.nextCursor ?? result.next_cursor;
        if (cursor != null && typeof cursor !== 'string') throw error('CODEX_ACCOUNT_MODEL_CATALOG_INVALID');
        const next = cursor?.trim() || '';
        if (next) {
          if (cursors.has(next)) throw error('CODEX_ACCOUNT_MODEL_CATALOG_INVALID');
          cursors.add(next);
          requestPage(next);
          return true;
        }
        const model = selectCodexAccountDefaultModel([...models.values()]);
        // This may await fresh durable authorization, never another stdout reply.
        await beforeReady();
        if (settled) return true;
        if (now() >= deadline) throw error('CODEX_ACCOUNT_MODEL_CATALOG_TIMEOUT');
        onReady(model); // synchronous: no gap after the authorization fence
        close();
      } catch (failure) { await fail(failure); }
      return true;
    },
    cancel: close,
  };
}
