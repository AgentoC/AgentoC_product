-- Tiered account entitlements. Device registration/login is not quota-limited;
-- connection concurrency is enforced by account_connection_leases (migration
-- 013) when a device requests a TURN-first connection.
create table if not exists account_entitlements (
  account_id  text primary key references accounts(account_id) on delete cascade,
  plan        text not null default 'free'
              check (plan in ('free', 'plus', 'pro')),
  source      text not null default 'manual'
              check (source in ('manual', 'play_billing', 'grant')),
  expires_at  timestamptz,
  updated_at  timestamptz not null default now()
);

alter table devices add column if not exists device_kind text
  not null default 'phone'
  check (device_kind in ('phone', 'computer'));

-- Historical instance-bound device rows use the instance id as device id.
-- Native Android rows have a distinct device id and remain phones.
update devices
set device_kind = 'computer'
where device_id = instance_id
  and exists (
    select 1
    from instance_bindings binding
    where binding.instance_id = devices.instance_id
      and binding.account_id = devices.account_id
  );

create index if not exists devices_account_kind_idx
  on devices (account_id, device_kind) where unbound_at is null;
create index if not exists instance_bindings_account_active_idx
  on instance_bindings (account_id) where revoked_at is null;
