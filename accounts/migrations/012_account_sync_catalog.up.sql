-- Account-owned sync metadata only. Payloads remain on bound computers.
create table if not exists account_sync_catalog (
  account_id          text not null references accounts(account_id) on delete cascade,
  scope               text not null check (scope in ('provider', 'agent-profile')),
  content_key         text not null,
  version             jsonb not null,
  source_instance_id  text not null,
  deleted_at          timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (account_id, scope, content_key)
);

create index if not exists account_sync_catalog_source_idx
  on account_sync_catalog (account_id, source_instance_id);
