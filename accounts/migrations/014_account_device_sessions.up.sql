-- Android's account identity is independent from target computers.  Do not
-- overload devices: its primary key and instance_id model a target-local
-- authorization and cannot represent one phone controlling many computers.
-- A claim endpoint is signed by the target instance before it can be exposed
-- through the Accounts directory.  Earlier intent rows simply keep it null.
alter table account_join_intents
  add column if not exists public_endpoint text;

create table if not exists account_devices (
  device_id text primary key,
  account_id text not null references accounts(account_id) on delete cascade,
  alias text,
  platform text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists account_devices_account_idx
  on account_devices (account_id, revoked_at, last_seen_at);

create table if not exists account_device_keys (
  key_id text primary key,
  account_id text not null references accounts(account_id) on delete cascade,
  device_id text not null references account_devices(device_id) on delete cascade,
  public_key text not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (account_id, fingerprint)
);

create index if not exists account_device_keys_device_idx
  on account_device_keys (account_id, device_id, revoked_at);

-- credential_id is durable metadata, while token_hash is replaced at each
-- refresh.  The raw rac_ bearer value never enters the database or audit log.
create table if not exists account_credentials (
  credential_id text primary key,
  token_hash text not null unique,
  account_id text not null references accounts(account_id) on delete cascade,
  device_id text not null references account_devices(device_id) on delete cascade,
  key_id text not null references account_device_keys(key_id) on delete cascade,
  scope text not null default 'directory account_join',
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz
);

create index if not exists account_credentials_token_idx
  on account_credentials (token_hash, expires_at, revoked_at);

create table if not exists account_session_challenges (
  transaction_id text primary key,
  request_id text not null unique,
  device_id text not null,
  public_key text not null,
  public_key_fingerprint text not null,
  device_alias text,
  platform text,
  nonce text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists account_session_challenges_expiry_idx
  on account_session_challenges (expires_at, consumed_at);

create table if not exists account_credential_refreshes (
  credential_id text not null references account_credentials(credential_id) on delete cascade,
  request_id text not null,
  nonce_hash text not null,
  issued_at timestamptz not null,
  created_at timestamptz not null,
  primary key (credential_id, request_id),
  unique (credential_id, nonce_hash)
);

create index if not exists account_credential_refreshes_retention_idx
  on account_credential_refreshes (created_at);

create table if not exists account_join_grants (
  grant_hash text primary key,
  account_id text not null references accounts(account_id) on delete cascade,
  instance_id text not null,
  intent_id text not null references account_join_intents(intent_id) on delete cascade,
  -- device_id is the target-local rdev_ selected by the intent.  The same
  -- Android installation has a separate account_device_id (adev_) and may
  -- legitimately have a different rdev_ on each computer.
  device_id text not null,
  account_device_id text not null references account_devices(device_id) on delete cascade,
  key_fingerprint text not null,
  claim_instance boolean not null default false,
  public_endpoint text,
  request_id text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  unique (account_id, request_id)
);

create index if not exists account_join_grants_pending_idx
  on account_join_grants (intent_id, account_device_id, expires_at, redeemed_at);
