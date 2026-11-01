-- Provider credential presence is account-scoped metadata only (see
-- ACCOUNT_SYNC_SCOPES in lib/account-sync.mjs). The secret itself never leaves
-- the bound computer; the catalog row only records which computer holds the
-- credential and its version, so account-bound clients can discover it.
alter table account_sync_catalog
  drop constraint if exists account_sync_catalog_scope_check;

alter table account_sync_catalog
  add constraint account_sync_catalog_scope_check
  check (scope in ('provider', 'agent-profile', 'provider-credential', 'harness-installation'));
