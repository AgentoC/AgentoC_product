import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

const unavailable = () => Object.assign(new Error('review_provider_owner_unavailable'), { code: 'review_provider_owner_unavailable' });

/** Only the existing broker may refresh. This client never starts a process. */
export function refreshReviewProviderThroughBroker(socketPath, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '', settled = false;
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(unavailable()); else resolve();
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.on('error', () => finish(true));
    socket.on('close', () => { if (!settled) finish(true); });
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'account/read', params: { refreshToken: true } }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 128 * 1024) return finish(true);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(true); }
        if (message.id !== 1) continue;
        return finish(message.error || message.result?.account?.type !== 'chatgpt');
      }
    });
  });
}

/** Read access-only projections from the protected canonical native home. */
export function createReviewProviderAccessReader({
  authFile, brokerSocket, expectedAccountId,
  readAuth = async () => JSON.parse((await readFile(authFile, 'utf8')).replace(/^\uFEFF/, '')),
  refreshOwner = () => refreshReviewProviderThroughBroker(brokerSocket),
  now = Date.now, refreshAheadMs = 60_000,
}) {
  if (typeof expectedAccountId !== 'string' || !expectedAccountId || /[\r\n]/.test(expectedAccountId)) {
    throw new Error('An operator-bound account ID is required');
  }
  let renewal = null;
  function access(auth) {
    const token = auth?.tokens?.access_token;
    if (auth?.tokens?.account_id !== expectedAccountId || typeof token !== 'string' || !token || token.length > 32_768) throw unavailable();
    let claims;
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw unavailable(); }
    if (!Number.isFinite(claims.exp) || claims.exp <= 0) throw unavailable();
    return { accessToken: token, accountId: expectedAccountId, expiresAt: claims.exp * 1000 };
  }
  return async ({ signal } = {}) => {
    signal?.throwIfAborted();
    try {
      let snapshot = access(await readAuth());
      if (snapshot.expiresAt - now() <= refreshAheadMs) {
        if (!renewal) {
          renewal = Promise.resolve().then(refreshOwner).finally(() => { renewal = null; });
        }
        // Caller cancellation cannot create another refresh owner or interrupt
        // a rotation already admitted by the canonical broker.
        await renewal;
        snapshot = access(await readAuth());
        if (snapshot.expiresAt <= now()) throw unavailable();
      }
      signal?.throwIfAborted();
      return { accessToken: snapshot.accessToken, accountId: snapshot.accountId };
    } catch { throw unavailable(); }
  };
}
