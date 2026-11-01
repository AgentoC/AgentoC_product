-- Harness installation presence is account-scoped metadata only. The binary
-- remains local to each bound computer; this allows UIs to show a globally
-- synced Provider when at least one computer still has its Harness installed.
alter table account_sync_catalog
  drop constraint if exists account_sync_catalog_scope_check;

alter table account_sync_catalog
  add constraint account_sync_catalog_scope_check
  check (scope in ('provider', 'agent-profile', 'harness-installation'));
