alter table account_sync_catalog
  drop constraint if exists account_sync_catalog_scope_check;

alter table account_sync_catalog
  add constraint account_sync_catalog_scope_check
  check (scope in ('provider', 'agent-profile', 'provider-credential', 'harness-installation'));

delete from account_sync_catalog where scope = 'runtime-policy';
