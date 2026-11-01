import { isPrivilegeRoutingEnabled } from './approved-action-policy.mjs';

export function hasPendingRuntimeApproval(state) {
  if (!(state?.pendingApprovals instanceof Map)) return false;
  return Array.from(state.pendingApprovals.values()).some((entry) => entry?.state !== 'responded');
}

export function hasPendingPrivilegedBatch(state) {
  if (!state || !isPrivilegeRoutingEnabled(state)) return false;
  // Two phases of the privileged pause, both exempt from idle-kill:
  //   1. accumulating — the gate is held while ops collect in privilegedTurnOps.
  //   2. open — the quiescence-debounce drain (see design §13.6) has surfaced the
  //      batch and the run sits in waiting_user until the user resolves the
  //      popups (can be minutes), long after the accumulator was emptied.
  if (state.privilegedBatchOpen === true) return true;
  return Array.isArray(state.privilegedTurnOps) && state.privilegedTurnOps.length > 0;
}

export function hasPendingApprovedAction(state) {
  const expiresAt = Date.parse(state?.approvedActionPending?.expiresAt || '');
  if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) return false;
  return Boolean(
    state?.approvedActionPending?.batchId
    && state?.actionPause?.kind === 'approved_action'
    && state?.actionPause?.state === 'waiting_user',
  );
}
