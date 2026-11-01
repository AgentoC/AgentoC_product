import { createKeyedTaskQueue } from './fs-utils.mjs';
import { assertOutsideSessionMetaTransaction } from './session-meta-store.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sessionApiError } from './session-api-mutation-contract.mjs';

const requests = createKeyedTaskQueue();
const ownership = new AsyncLocalStorage();

/** Serialize preparation and ordinary ingress under the same SID/request key. */
export function withMessageRequestIdentity(sessionId, requestId, task) {
  // A long ingress can need metadata later. Never acquire its lock while
  // holding the metadata actor, including via an inherited active context.
  assertOutsideSessionMetaTransaction();
  const key = JSON.stringify([sessionId, typeof requestId === 'string' ? requestId.trim() : '']);
  const ancestors = ownership.getStore() || [];
  if (ancestors.some(owner => owner.active && owner.key === key))
    throw sessionApiError('MESSAGE_IDENTITY_LOCK_CONFLICT', 409, 'Nested use of the same message identity is unsupported');
  return requests(key, () => {
    const owner = { key, active: true };
    return ownership.run([...ancestors, owner], async () => {
      try { return await task(); } finally { owner.active = false; }
    });
  });
}
