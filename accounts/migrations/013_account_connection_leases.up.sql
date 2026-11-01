-- Registered devices are unlimited; subscription quotas apply only to active
-- connection endpoints. A lease is one phone-to-computer connection pair.
create table if not exists account_connection_leases (
  connection_id text primary key,
  account_id text not null references accounts(account_id) on delete cascade,
  instance_id text not null,
  device_id text not null,
  device_kind text not null default 'phone'
    check (device_kind in ('phone', 'computer')),
  plan text not null default 'free'
    check (plan in ('free', 'plus', 'pro')),
  status text not null default 'reserved'
    check (status in ('reserved', 'connected', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text
);

create index if not exists account_connection_leases_active_idx
  on account_connection_leases (account_id, status, expires_at);
create index if not exists account_connection_leases_pair_idx
  on account_connection_leases (account_id, instance_id, device_id, status);
