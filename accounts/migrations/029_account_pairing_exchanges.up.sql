create table if not exists account_pairing_exchanges (
  invitation_id text primary key,
  instance_id text not null,
  account_id text not null,
  status text not null,
  expires_at bigint not null,
  payload jsonb not null
);
create index if not exists account_pairing_instance_idx on account_pairing_exchanges(instance_id, status);
create index if not exists account_pairing_expiry_idx on account_pairing_exchanges(expires_at);
