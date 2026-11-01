import {
  APPROVED_ACTION_CHANNEL,
  APPROVED_ACTION_SCHEMA_VERSION,
  APPROVED_ACTION_STATE,
  buildApprovedActionAuditEvent,
  buildApprovedActionBatch,
  isApprovedActionExpired,
  isApprovedActionManifestIntact,
  isTerminalApprovedActionState,
  transitionApprovedAction,
} from './approved-actions.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// Authorization proofs, signed grants, and per-use nonces live in the
// capability store. Canonical history carries only a non-sensitive recovery
// pointer and approval summary.
function publicAuthorization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safe = {};
  for (const field of ['source', 'approvedAt', 'selectionManifestHash', 'permissionMode', 'capabilityRef']) {
    const item = trimString(value[field]);
    if (item) safe[field] = item;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function eventForBatch(batch) {
  return {
    type: 'approved_action_batch_request',
    role: 'system',
    channel: APPROVED_ACTION_CHANNEL,
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    batchId: batch.batchId,
    requestKey: batch.requestKey,
    sessionId: batch.sessionId,
    runId: batch.runId,
    turnId: batch.turnId,
    state: APPROVED_ACTION_STATE.WAITING_USER,
    createdAt: batch.createdAt,
    actions: batch.actions.map((action) => ({
      ...action,
      authorization: publicAuthorization(action.authorization),
      state: APPROVED_ACTION_STATE.WAITING_USER,
      updatedAt: batch.createdAt,
    })),
  };
}

function eventForAction(action, previousState = '') {
  return {
    type: 'approved_action_state',
    role: 'system',
    channel: APPROVED_ACTION_CHANNEL,
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    actionId: action.actionId,
    batchId: action.batchId,
    sessionId: action.sessionId,
    runId: action.runId,
    turnId: action.turnId,
    state: action.state,
    previousState,
    authorization: publicAuthorization(action.authorization),
    resultRef: clone(action.resultRef),
    manifestHash: action.manifestHash,
    updatedAt: action.updatedAt,
  };
}

function eventForBatchResolution(batch, decisions = {}, selectionManifestHash = '', source = 'owner') {
  return {
    type: 'approved_action_batch_response',
    role: 'system',
    channel: APPROVED_ACTION_CHANNEL,
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    batchId: batch.batchId,
    sessionId: batch.sessionId,
    runId: batch.runId,
    turnId: batch.turnId,
    decisions: clone(decisions),
    ...(selectionManifestHash ? { selectionManifestHash } : {}),
    source,
    updatedAt: new Date().toISOString(),
  };
}

export function recoverApprovedActionBatches(events = []) {
  const batches = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.channel !== APPROVED_ACTION_CHANNEL) continue;
    if (event.type === 'approved_action_batch_request' && event.batchId) {
      const actions = Array.isArray(event.actions) ? event.actions : [];
      batches.set(event.batchId, {
        schemaVersion: event.schemaVersion || APPROVED_ACTION_SCHEMA_VERSION,
        channel: APPROVED_ACTION_CHANNEL,
        batchId: event.batchId,
        requestKey: trimString(event.requestKey),
        sessionId: trimString(event.sessionId),
        runId: trimString(event.runId),
        turnId: trimString(event.turnId),
        state: event.state || APPROVED_ACTION_STATE.WAITING_USER,
        createdAt: event.createdAt,
        actions: actions.map((action) => ({
          ...clone(action),
          authorization: publicAuthorization(action.authorization),
        })),
      });
      continue;
    }
    if (event.type !== 'approved_action_state' || !event.actionId) continue;
    const batch = batches.get(event.batchId);
    const action = batch?.actions?.find((candidate) => candidate.actionId === event.actionId);
    if (!action) continue;
    action.state = event.state;
    action.authorization = publicAuthorization(event.authorization);
    action.resultRef = clone(event.resultRef);
    action.updatedAt = event.updatedAt;
  }
  for (const batch of batches.values()) {
    batch.state = batch.actions.every((action) => isTerminalApprovedActionState(action.state))
      ? (batch.actions.some((action) => action.state === APPROVED_ACTION_STATE.FAILED) ? APPROVED_ACTION_STATE.FAILED : APPROVED_ACTION_STATE.COMPLETED)
      : batch.actions.some((action) => action.state === APPROVED_ACTION_STATE.EXECUTING) ? APPROVED_ACTION_STATE.EXECUTING : APPROVED_ACTION_STATE.WAITING_USER;
  }
  return [...batches.values()];
}

export function createApprovedActionStore({ readEvents, appendEvent, invalidate } = {}) {
  if (typeof readEvents !== 'function' || typeof appendEvent !== 'function') {
    const error = new Error('readEvents and appendEvent are required');
    error.code = 'APPROVED_ACTION_STORE_REQUIRED';
    throw error;
  }
  let queue = Promise.resolve();
  const serialize = (task) => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  async function readBatches() {
    return recoverApprovedActionBatches(await readEvents());
  }

  async function append(event) {
    const stored = await appendEvent(event);
    if (typeof invalidate === 'function') await invalidate(stored || event);
    return stored || event;
  }

  return Object.freeze({
    readBatches,
    async propose(actions, context = {}) {
      return serialize(async () => {
        const existing = (await readBatches()).find((batch) => batch.requestKey === context.requestKey);
        if (existing) return { duplicate: true, batch: clone(existing) };
        const batch = buildApprovedActionBatch(actions, context);
        const stored = await append(eventForBatch(batch));
        for (const action of batch.actions) {
          await append(buildApprovedActionAuditEvent({ ...action, batchId: batch.batchId }, 'proposed'));
          await append(buildApprovedActionAuditEvent({ ...action, batchId: batch.batchId }, 'classified'));
          await append(buildApprovedActionAuditEvent({ ...action, batchId: batch.batchId }, 'waiting_user'));
        }
        return { duplicate: false, batch: clone(recoverApprovedActionBatches([stored || eventForBatch(batch)])[0] || batch) };
      });
    },
    async get(batchId) {
      return (await readBatches()).find((batch) => batch.batchId === trimString(batchId)) || null;
    },
    async transition(actionId, nextState, patch = {}) {
      return serialize(async () => {
        const batches = await readBatches();
        for (const batch of batches) {
          const action = batch.actions.find((candidate) => candidate.actionId === trimString(actionId));
          if (!action) continue;
          if (!isApprovedActionManifestIntact(action)) {
            const error = new Error('approved action manifest does not match its record');
            error.code = 'APPROVED_ACTION_MANIFEST_MISMATCH';
            throw error;
          }
          if ([
            APPROVED_ACTION_STATE.PROPOSED,
            APPROVED_ACTION_STATE.CLASSIFIED,
            APPROVED_ACTION_STATE.WAITING_USER,
            APPROVED_ACTION_STATE.AUTHORIZED,
          ].includes(action.state)
            && isApprovedActionExpired(action)
            && nextState !== APPROVED_ACTION_STATE.EXPIRED) {
            const error = new Error('approved action has expired');
            error.code = 'APPROVED_ACTION_EXPIRED';
            throw error;
          }
          const next = transitionApprovedAction(action, nextState, patch);
          await append(eventForAction(next, action.state));
          await append(buildApprovedActionAuditEvent(next, nextState, {
            ...(patch.reason ? { reason: trimString(patch.reason) } : {}),
          }));
          return clone(next);
        }
        const error = new Error('approved action not found');
        error.code = 'APPROVED_ACTION_NOT_FOUND';
        throw error;
      });
    },
    async resolveBatch(batchId, decisions = {}, patch = {}) {
      return serialize(async () => {
        const normalizedBatchId = trimString(batchId);
        const batches = await readBatches();
        const batch = batches.find((candidate) => candidate.batchId === normalizedBatchId);
        if (!batch) {
          const error = new Error('approved action batch not found');
          error.code = 'APPROVED_ACTION_BATCH_NOT_FOUND';
          throw error;
        }
        const decisionMap = decisions && typeof decisions === 'object' && !Array.isArray(decisions)
          ? decisions
          : {};
        const pending = batch.actions.filter((action) => action.state === APPROVED_ACTION_STATE.WAITING_USER);
        if (pending.length === 0) {
          return { duplicate: true, batch: clone(batch), actions: clone(batch.actions) };
        }
        // The serialized store may have waited behind another writer after
        // the carrier checked its grant. Recheck at the durable decision point.
        patch.assertAuthorization?.();
        const expired = pending.filter((action) => isApprovedActionExpired(action));
        for (const action of expired) {
          if (!isApprovedActionManifestIntact(action)) {
            const error = new Error('approved action manifest does not match its record');
            error.code = 'APPROVED_ACTION_MANIFEST_MISMATCH';
            throw error;
          }
          const next = transitionApprovedAction(action, APPROVED_ACTION_STATE.EXPIRED, {
            resultRef: { reason: 'approval window expired' },
          });
          await append(eventForAction(next, action.state));
          await append(buildApprovedActionAuditEvent(next, APPROVED_ACTION_STATE.EXPIRED, { reason: 'approval window expired' }));
        }
        const activePending = pending.filter((action) => !expired.includes(action));
        for (const action of activePending) {
          patch.assertAuthorization?.();
          const decision = trimString(decisionMap[action.actionId]).toLowerCase();
          if (!['approve', 'deny'].includes(decision)) {
            const error = new Error(`decision is required for action ${action.actionId}`);
            error.code = 'APPROVED_ACTION_DECISION_INCOMPLETE';
            throw error;
          }
          if (!isApprovedActionManifestIntact(action)) {
            const error = new Error('approved action manifest does not match its record');
            error.code = 'APPROVED_ACTION_MANIFEST_MISMATCH';
            throw error;
          }
        }
        const resolvedActions = expired.map((action) => ({
          ...action,
          state: APPROVED_ACTION_STATE.EXPIRED,
          resultRef: { reason: 'approval window expired' },
        }));
        for (const action of activePending) {
          patch.assertAuthorization?.();
          const decision = trimString(decisionMap[action.actionId]).toLowerCase();
          const nextState = decision === 'approve'
            ? APPROVED_ACTION_STATE.AUTHORIZED
            : APPROVED_ACTION_STATE.DENIED;
          const authorizationForAction = patch.authorizationByActionId
            && typeof patch.authorizationByActionId === 'object'
            && !Array.isArray(patch.authorizationByActionId)
            ? patch.authorizationByActionId[action.actionId]
            : patch.authorization;
          const next = transitionApprovedAction(action, nextState, {
            authorization: decision === 'approve' ? publicAuthorization(authorizationForAction) : {
              source: trimString(patch.source) || 'owner',
              decision: 'deny',
              at: new Date().toISOString(),
            },
            ...(decision === 'deny' && patch.reason ? { resultRef: { reason: trimString(patch.reason) } } : {}),
          });
          await append(eventForAction(next, action.state));
          await append(buildApprovedActionAuditEvent(next, nextState, {
            source: trimString(patch.source) || 'owner',
            decision,
            ...(patch.selectionManifestHash ? { selectionManifestHash: patch.selectionManifestHash } : {}),
          }));
          resolvedActions.push(next);
        }
        await append(eventForBatchResolution(
          batch,
          decisionMap,
          trimString(patch.selectionManifestHash),
          trimString(patch.source) || 'owner',
        ));
        const recovered = await readBatches();
        const resolvedBatch = recovered.find((candidate) => candidate.batchId === normalizedBatchId) || {
          ...batch,
          actions: resolvedActions,
        };
        return { duplicate: false, batch: clone(resolvedBatch), actions: clone(resolvedActions) };
      });
    },
    async recover() {
      return readBatches();
    },
  });
}
