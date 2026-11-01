-- Native owner authentication request ids prevent cross-device request replay.
create table if not exists native_owner_auth_requests (
  request_id  text primary key,
  instance_id text not null,
  device_id   text not null,
  account_id  text not null,
  completed_at timestamptz not null,
  status text not null default 'completed',
  binding_created boolean not null default false,
  device_created boolean not null default false,
  previous_binding jsonb,
  previous_device jsonb,
  rolled_back_at timestamptz
);

alter table native_owner_auth_requests add column if not exists status text not null default 'completed';
alter table native_owner_auth_requests add column if not exists binding_created boolean not null default false;
alter table native_owner_auth_requests add column if not exists device_created boolean not null default false;
alter table native_owner_auth_requests add column if not exists previous_binding jsonb;
alter table native_owner_auth_requests add column if not exists previous_device jsonb;
alter table native_owner_auth_requests add column if not exists rolled_back_at timestamptz;

create index if not exists native_owner_auth_requests_instance_idx
  on native_owner_auth_requests (instance_id, device_id);
