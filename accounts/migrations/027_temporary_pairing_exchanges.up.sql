-- A separate authority lifecycle; this does not create account devices or credentials.
create table if not exists temporary_pairing_exchanges (
  invitation_id text primary key,
  instance_id text not null,
  account_id text not null references accounts(account_id) on delete cascade,
  status text not null check (status in ('REGISTERED', 'CLAIMED', 'COMPLETED', 'REVOKED', 'EXPIRED')),
  claim_expires_at bigint not null check (claim_expires_at >= 0),
  access_expires_at bigint not null check (access_expires_at >= claim_expires_at and access_expires_at <= 9007199254740991),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  check (payload ?& array['invitationId', 'instanceId', 'accountId', 'status', 'claimExpiresAt', 'accessExpiresAt', 'version']),
  check ((payload->>'claimExpiresAt')::bigint = claim_expires_at),
  check ((payload->>'accessExpiresAt')::bigint = access_expires_at),
  check (payload->>'invitationId' = invitation_id),
  check (payload->>'instanceId' = instance_id),
  check (payload->>'accountId' = account_id),
  check (payload->>'status' = status)
);
create index if not exists temporary_pairing_instance_idx on temporary_pairing_exchanges(instance_id, status);
create index if not exists temporary_pairing_expiry_idx on temporary_pairing_exchanges(access_expires_at);
create table if not exists temporary_pairing_clock (
  singleton boolean primary key default true check (singleton),
  last_observed_at bigint not null check (last_observed_at >= 0 and last_observed_at <= 9007199254740991)
);
insert into temporary_pairing_clock(singleton, last_observed_at) values (true, 0) on conflict do nothing;
