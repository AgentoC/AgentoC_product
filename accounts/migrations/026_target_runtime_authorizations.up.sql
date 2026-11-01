-- Exact, short-lived Web -> target-runtime command bindings.  The JWT itself
-- is deliberately not persisted; claims and a hash are enough to rebuild a
-- deterministic retry and audit the authorization without storing a bearer.
create table if not exists target_runtime_authorizations (
  request_id text primary key,
  idempotency_key text not null,
  source_instance_id text not null,
  target_instance_id text not null,
  account_id text not null references accounts(account_id) on delete cascade,
  method text not null,
  path text not null,
  operation text not null,
  resource_id text not null,
  expected_revision bigint not null check (expected_revision >= 0),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  jti text not null,
  grant_hash text not null,
  claims jsonb not null,
  created_at timestamptz not null default now(),
  unique (source_instance_id, idempotency_key)
);

create index if not exists target_runtime_authorizations_expiry_idx
  on target_runtime_authorizations (expires_at);
