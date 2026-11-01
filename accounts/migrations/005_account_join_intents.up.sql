-- One-time, account-scoped new-device join intents.
-- Public keys are verification material; nonce values are never stored.
create table if not exists account_join_intents (
  intent_id text primary key,
  instance_id text not null,
  instance_public_key text not null,
  instance_key_fingerprint text not null,
  device_id text not null,
  device_public_key text not null,
  device_public_key_fingerprint text not null,
  device_alias text,
  platform text,
  nonce_hash text not null,
  issued_at timestamptz not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'pending',
  account_id text,
  completion_request_id text,
  completed_at timestamptz
);

create index if not exists account_join_intents_instance_device_idx
  on account_join_intents (instance_id, device_id);

create index if not exists account_join_intents_expiry_idx
  on account_join_intents (expires_at);
