// A persisted pending deletion is an admission fence, not a sign-out flag.
export function assertAccountNotDeleting(draft, accountId) {
  const account = (draft.accounts || []).find(item => item.accountId === accountId);
  if (account?.deletionRequestedAt || account?.deletionJobId) {
    throw Object.assign(new Error('Account deletion is pending or completed; existing account authority cannot be restored.'),
      { code: 'account_deletion_pending', statusCode: 410 });
  }
}
