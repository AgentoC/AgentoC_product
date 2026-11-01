import { performance } from 'node:perf_hooks';
import { BINDING_AUTHORITY_TTL_MS } from './binding-authority.mjs';

function counter(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}
function failure(code = 'owner_auth_authority_required', statusCode = 403) {
  return Object.assign(new Error('Current binding authority is required'), { code, statusCode });
}

// Owns one computer identity. Only the verifier's result may enter query(), and
// only an already verified Accounts completion may enter acceptVerifiedCompletion.
export function createBindingAuthorityController({ instanceId, keyFingerprint, readState, writeState, query,
  clock = Date.now, monotonicNow = () => performance.now(), onInvalidate = () => {}, onActive = () => {},
  onVerifiedInactive = async () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, refreshAfterMs = 10_000 } = {}) {
  if (!instanceId || !/^[a-f0-9]{64}$/.test(keyFingerprint) || ![readState, writeState, query].every(fn => typeof fn === 'function')) {
    throw new TypeError('A fixed identity, durable state and verified status reader are required');
  }
  let state, initialization, tail = Promise.resolve(), stopped = false, storageHealthy = true, observedRevision = '0';
  const proofs = new Map(), pending = new Map(), rateLimits = new Map();
  const serialized = action => {
    const run = tail.then(action); tail = run.catch(() => {}); return run;
  };
  function notify(reason, accountId = '', revision = observedRevision) {
    try { Promise.resolve(onInvalidate({ reason, accountId, revision })).catch(() => {}); } catch {}
  }
  function discard(accountId, reason) {
    const proof = proofs.get(accountId);
    if (proof) { clearTimer(proof.timer); proofs.delete(accountId); }
    notify(reason, accountId);
  }
  function discardAll(reason) {
    for (const proof of proofs.values()) clearTimer(proof.timer);
    proofs.clear(); notify(reason);
  }
  async function initialize() {
    if (!initialization) initialization = (async () => {
      const retained = await readState();
      if (retained === null) state = { version: 1, instanceId, keyFingerprint, revision: '0', deniedAccounts: [] };
      else {
        if (!retained || typeof retained !== 'object' || Array.isArray(retained)
          || retained.version !== 1 || retained.instanceId !== instanceId || retained.keyFingerprint !== keyFingerprint
          || !counter(retained.revision) || !Array.isArray(retained.deniedAccounts) || retained.deniedAccounts.length > 32
          || retained.deniedAccounts.some(id => typeof id !== 'string' || !id || id.length > 160)
          || new Set(retained.deniedAccounts).size !== retained.deniedAccounts.length) {
          throw failure('owner_auth_authority_state_invalid', 503);
        }
        state = structuredClone(retained);
      }
      observedRevision = state.revision;
    })();
    await initialization;
    if (stopped) throw failure('owner_auth_authority_stopped', 503);
  }
  async function persist(next) {
    try {
      if (!storageHealthy || JSON.stringify(next) !== JSON.stringify(state)) await writeState(structuredClone(next));
      state = next; storageHealthy = true;
    } catch {
      storageHealthy = false; discardAll('persistence-failed');
      throw failure('owner_auth_authority_persistence_failed', 503);
    }
  }
  function advance(revision) {
    if (BigInt(revision) < BigInt(observedRevision)) throw failure('owner_auth_authority_superseded', 409);
    if (BigInt(revision) > BigInt(observedRevision)) {
      observedRevision = revision; discardAll('generation-changed');
    }
    return BigInt(revision) > BigInt(state.revision)
      ? { ...state, revision, deniedAccounts: [] } : structuredClone(state);
  }
  async function acceptVerifiedCompletion(completion, commit = async () => {}) {
    return serialized(async () => {
      await initialize();
      if (completion?.instanceId !== instanceId || completion?.keyFingerprint !== keyFingerprint
        || typeof completion.accountId !== 'string' || !completion.accountId || completion.accountId.length > 160
        || !counter(completion.revision) || completion.revision === '0' || typeof commit !== 'function') throw failure();
      const next = advance(completion.revision);
      if (next.deniedAccounts.includes(completion.accountId)) throw failure('owner_auth_authority_superseded', 409);
      await persist(next);
      // Keep local binding publication in the same queue as accepting the
      // revision, so an older completion cannot overwrite a newer binding.
      return commit();
    });
  }
  function usable(accountId, revision) {
    if (stopped || !storageHealthy || !state || !counter(revision) || revision === '0'
      || revision !== observedRevision || revision !== state.revision || state.deniedAccounts.includes(accountId)) return false;
    const proof = proofs.get(accountId);
    if (!proof || proof.revision !== revision) return false;
    if (monotonicNow() >= proof.deadline || clock() >= proof.expiresAt) { discard(accountId, 'authority-expired'); return false; }
    return true;
  }
  function refresh(accountId) {
    if (pending.has(accountId)) return pending.get(accountId);
    const run = (async () => {
      await initialize();
      if (typeof accountId !== 'string' || !accountId || accountId.length > 160) throw failure();
      const limit = rateLimits.get(accountId);
      if (limit && monotonicNow() < limit.until) throw limit.error;
      const startedMono = monotonicNow();
      let receipt;
      try {
        receipt = await query({ accountId });
        rateLimits.delete(accountId);
      } catch (error) {
        if (error?.statusCode === 429) {
          const retryAfter = Number(error.retryAfterMs);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 120_000) : 5_000;
          rateLimits.set(accountId, { until: monotonicNow() + delay, error });
        }
        throw error;
      }
      return serialized(async () => {
        await initialize();
        const now = clock(), mono = monotonicNow();
        if (receipt?.instanceId !== instanceId || receipt?.keyFingerprint !== keyFingerprint || receipt?.accountId !== accountId
          || !counter(receipt.revision) || !['active', 'revoked', 'missing', 'mismatch'].includes(receipt.state)
          || receipt.authorityProtocol !== 1 || (receipt.revision === '0' && receipt.state !== 'missing')
          || !Number.isSafeInteger(receipt.checkedAt) || receipt.checkedAt > now
          || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt <= now
          || receipt.expiresAt > receipt.checkedAt + BINDING_AUTHORITY_TTL_MS
          || mono >= startedMono + BINDING_AUTHORITY_TTL_MS) throw failure('owner_auth_authority_assertion_invalid', 502);
        const next = advance(receipt.revision);
        if (receipt.state !== 'active' && !next.deniedAccounts.includes(accountId)) next.deniedAccounts.push(accountId);
        if (next.deniedAccounts.length > 32) throw failure('owner_auth_authority_state_invalid', 503);
        await persist(next);
        if (receipt.state !== 'active' || next.deniedAccounts.includes(accountId)) {
          discard(accountId, 'binding-inactive');
          // Reconcile disposable local metadata only after durable, fresh signed
          // revocation. The completion queue fences cleanup against a new bind;
          // denial already applies even if cleanup fails. Mismatch is not revoke.
          if (['revoked', 'missing'].includes(receipt.state)) await onVerifiedInactive({ ...receipt });
          return { active: false, revision: next.revision };
        }
        const previous = proofs.get(accountId); if (previous) clearTimer(previous.timer);
        const proof = { revision: receipt.revision, expiresAt: receipt.expiresAt, checkedMono: startedMono,
          deadline: Math.min(startedMono + BINDING_AUTHORITY_TTL_MS, mono + receipt.expiresAt - now) };
        proof.timer = setTimer(() => {
          if (proofs.get(accountId) !== proof) return;
          discard(accountId, 'authority-expired');
        }, Math.max(0, proof.deadline - mono));
        proof.timer?.unref?.(); proofs.set(accountId, proof);
        if (!previous || previous.revision !== proof.revision) {
          try { Promise.resolve(onActive({ accountId, revision: proof.revision })).catch(() => {}); } catch {}
        }
        return { active: true, revision: receipt.revision, expiresAt: receipt.expiresAt };
      });
    })();
    pending.set(accountId, run);
    const finished = () => { if (pending.get(accountId) === run) pending.delete(accountId); };
    run.then(finished, finished); return run;
  }
  async function authorize({ accountId, revision } = {}) {
    await initialize();
    if (!counter(revision) || revision === '0' || typeof accountId !== 'string' || !accountId) throw failure('owner_auth_authority_upgrade_required', 401);
    if (BigInt(revision) < BigInt(observedRevision) || state.deniedAccounts.includes(accountId)) throw failure('owner_auth_authority_superseded', 401);
    if (usable(accountId, revision)) {
      if (monotonicNow() - proofs.get(accountId).checkedMono >= refreshAfterMs) void refresh(accountId).catch(() => {});
    } else await refresh(accountId);
    if (!usable(accountId, revision)) throw failure('owner_auth_authority_required', 401);
    return { accountId, revision, expiresAt: proofs.get(accountId).expiresAt };
  }
  return Object.freeze({ initialize, acceptVerifiedCompletion, refresh, authorize, allows: usable,
    invalidate: (reason = 'local-binding-cleared') => discardAll(reason),
    snapshot: () => serialized(async () => { await initialize(); return structuredClone(state); }),
    stop: () => { stopped = true; discardAll('controller-stopped'); } });
}
