-- Account-level runtime policy (currently the account permission policy) is
-- account-scoped metadata only: a small owner-controlled default that every
-- instance of the account applies locally. See ACCOUNT_SYNC_SCOPES in
-- lib/account-sync.mjs and the runtime-policy sync record normalizer.
alter table account_sync_catalog
  drop constraint if exists account_sync_catalog_scope_check;

alter table account_sync_catalog
  add constraint account_sync_catalog_scope_check
  check (scope in ('provider', 'agent-profile', 'provider-credential', 'harness-installation', 'runtime-policy'));
