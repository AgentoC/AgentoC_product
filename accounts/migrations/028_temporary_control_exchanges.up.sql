-- v2 full-control pairing is stored separately from v1 temporary sharing.
-- A v1 exchange must never be decoded as a workbench-control grant.
create table if not exists temporary_control_exchanges (
  invitation_id text primary key,
  instance_id text not null,
  account_id text not null,
  status text not null,
  claim_expires_at bigint not null,
  access_expires_at bigint,
  payload jsonb not null
);
create index if not exists temporary_control_instance_idx on temporary_control_exchanges(instance_id, status);
create index if not exists temporary_control_expiry_idx on temporary_control_exchanges(claim_expires_at, access_expires_at);

create table if not exists temporary_control_clock (
  singleton boolean primary key default true check (singleton),
  last_observed_at bigint not null
);
insert into temporary_control_clock(singleton, last_observed_at) values (true, 0) on conflict do nothing;
