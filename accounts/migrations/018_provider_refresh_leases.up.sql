-- 跨设备 provider credential refresh lease 与中央 credential 版本元数据。
-- 这里只保存非敏感元数据：provider token 永远不进入 Accounts。
create table if not exists provider_refresh_meta (
  identity_key text primary key,
  account_id text not null references accounts(account_id) on delete cascade,
  provider_family text not null,
  account_key text not null,
  credential_instance_id text not null,
  credential_version bigint not null default 0,
  fencing_token bigint not null default 0,
  updated_at timestamptz,
  updated_by_instance_id text,
  last_uncertain_at timestamptz
);

create index if not exists provider_refresh_meta_account_idx
  on provider_refresh_meta (account_id, provider_family, account_key);

create table if not exists provider_refresh_leases (
  lease_id text primary key,
  identity_key text not null,
  account_id text not null references accounts(account_id) on delete cascade,
  provider_family text not null,
  account_key text not null,
  credential_instance_id text not null,
  holder_instance_id text not null,
  run_id text not null default '',
  fencing_token bigint not null,
  state text not null
    check (state in ('held', 'stolen', 'committed', 'failed', 'uncertain', 'released')),
  outcome text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_heartbeat_at timestamptz,
  closed_at timestamptz
);

create index if not exists provider_refresh_leases_identity_idx
  on provider_refresh_leases (identity_key, state, expires_at);
create index if not exists provider_refresh_leases_closed_idx
  on provider_refresh_leases (closed_at);
