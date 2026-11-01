-- Accounts 持久化模型：账号、owner-auth 事务、实例绑定、设备与绑定历史。
-- 迁移由 scripts/accounts-migrate.mjs 按序执行并记录到 schema_migrations。
create table if not exists accounts (
  account_id        text primary key,
  provider          text not null,
  provider_subject  text not null,
  email             text,
  name              text,
  created_at        timestamptz not null default now(),
  unique (provider, provider_subject)
);

create table if not exists owner_auth_transactions (
  transaction_id          text primary key,
  purpose                 text not null check (purpose in ('bind', 'login')),
  return_url              text not null,
  instance_id             text not null,
  instance_public_key     text not null,
  instance_key_fingerprint text not null,
  nonce                   text not null,
  bootstrap_hash          text not null,
  browser_started_at      timestamptz,
  desktop_started_at      timestamptz,
  desktop_state_hash      text,
  phone_ticket_hash       text,
  phone_started_at        timestamptz,
  phone_state_hash        text,
  completed_at            timestamptz,
  redeemed_at             timestamptz,
  grant_hash              text,
  account_id              text,
  created_at              timestamptz not null,
  expires_at              timestamptz not null
);

create index if not exists owner_auth_transactions_expires_at_idx
  on owner_auth_transactions (expires_at);

create table if not exists instance_bindings (
  instance_id   text primary key,
  account_id    text not null,
  provider      text not null,
  device_alias  text,
  bound_at      timestamptz not null default now(),
  revoked_at    timestamptz
);

create table if not exists devices (
  device_id     text primary key,
  instance_id   text not null,
  account_id    text not null,
  alias         text,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists binding_history (
  id          bigserial primary key,
  instance_id text not null,
  account_id  text not null,
  action      text not null,
  occurred_at timestamptz not null default now()
);

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);
