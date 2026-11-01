alter table account_join_intents
  add column if not exists rendezvous_request_id text unique,
  add column if not exists rendezvous_nonce text,
  add column if not exists rendezvous_grant text,
  add column if not exists rendezvous_device_signature text,
  add column if not exists rendezvous_result jsonb;

create index if not exists account_join_intents_rendezvous_idx
  on account_join_intents (rendezvous_request_id, expires_at, status);
