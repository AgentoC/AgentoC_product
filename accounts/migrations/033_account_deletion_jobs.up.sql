-- Independent of legacy snapshot rewrites. Never restore account authority by
-- removing these fences, including after cloud records have been erased.
create table if not exists account_deletion_jobs (
  job_id uuid primary key,
  request_id uuid not null unique,
  account_id text not null unique,
  confirmation_id uuid not null unique,
  receipt_secret_hash text not null check (receipt_secret_hash ~ '^[a-f0-9]{64}$'),
  plan_version integer not null default 1 check (plan_version=1),
  status text not null check (status in ('revoked', 'cleaning', 'waiting-for-devices', 'needs-owner', 'completed')),
  phase_index integer not null default 0 check (phase_index between 0 and 24),
  requested_at timestamptz not null,
  updated_at timestamptz not null,
  cloud_erased_at timestamptz,
  check ((cloud_erased_at is null and phase_index<24) or (cloud_erased_at is not null and phase_index=24))
);

create table if not exists account_deletion_fences (
  account_id text primary key,
  job_id uuid not null unique references account_deletion_jobs(job_id),
  requested_at timestamptz not null
);

create table if not exists account_deletion_targets (
  job_id uuid not null references account_deletion_jobs(job_id),
  instance_id text not null,
  public_key text not null,
  key_fingerprint text not null,
  acknowledged_at timestamptz,
  local_copies text check (local_copies in ('kept', 'deleted', 'requires-owner')),
  primary key(job_id, instance_id),
  check ((acknowledged_at is null) = (local_copies is null))
);

alter table accounts add column if not exists deletion_requested_at timestamptz;
alter table accounts add column if not exists deletion_job_id uuid;

create or replace function guard_account_deletion_fence()
returns trigger language plpgsql set search_path from current as $$
begin
  if TG_OP = 'INSERT' then
    if not exists(select 1 from account_deletion_jobs where job_id=NEW.job_id
      and account_id=NEW.account_id and requested_at=NEW.requested_at) then
      raise exception 'account_deletion_fence_identity_mismatch' using errcode = '23514';
    end if;
    return NEW;
  end if;
  raise exception 'account_deletion_fence_immutable' using errcode = '23514';
end;
$$;
drop trigger if exists account_deletion_fence_immutable on account_deletion_fences;
create trigger account_deletion_fence_immutable before insert or update or delete on account_deletion_fences
  for each row execute function guard_account_deletion_fence();

create or replace function guard_account_deletion_job_identity()
returns trigger language plpgsql set search_path from current as $$
begin
  if TG_OP = 'DELETE' or
    (NEW.job_id, NEW.request_id, NEW.account_id, NEW.confirmation_id, NEW.receipt_secret_hash, NEW.requested_at, NEW.plan_version)
    is distinct from
    (OLD.job_id, OLD.request_id, OLD.account_id, OLD.confirmation_id, OLD.receipt_secret_hash, OLD.requested_at, OLD.plan_version)
    or NEW.phase_index < OLD.phase_index
    or NEW.updated_at < OLD.updated_at
    or (OLD.cloud_erased_at is not null and NEW.cloud_erased_at is distinct from OLD.cloud_erased_at)
    or (OLD.cloud_erased_at is not null and NEW.status not in ('waiting-for-devices','needs-owner','completed'))
    or (OLD.status = 'completed' and NEW.status <> 'completed') then
    raise exception 'account_deletion_job_regression' using errcode = '23514';
  end if;
  return NEW;
end;
$$;
drop trigger if exists account_deletion_job_identity on account_deletion_jobs;
create trigger account_deletion_job_identity before update or delete on account_deletion_jobs
  for each row execute function guard_account_deletion_job_identity();

create or replace function guard_account_deletion_target()
returns trigger language plpgsql set search_path from current as $$
begin
  if TG_OP = 'INSERT' then
    if exists(select 1 from account_deletion_fences where job_id=NEW.job_id) then
      raise exception 'account_deletion_target_set_frozen' using errcode = '23514';
    end if;
    return NEW;
  end if;
  if TG_OP = 'DELETE' or (NEW.job_id,NEW.instance_id,NEW.public_key,NEW.key_fingerprint)
    is distinct from (OLD.job_id,OLD.instance_id,OLD.public_key,OLD.key_fingerprint)
    or (OLD.acknowledged_at is not null and (NEW.acknowledged_at is distinct from OLD.acknowledged_at
      or (NEW.local_copies is distinct from OLD.local_copies
        and not (OLD.local_copies='requires-owner' and NEW.local_copies in ('kept','deleted'))))) then
    raise exception 'account_deletion_target_regression' using errcode = '23514';
  end if;
  return NEW;
end;
$$;
drop trigger if exists account_deletion_target_immutable on account_deletion_targets;
create trigger account_deletion_target_immutable before insert or update or delete on account_deletion_targets
  for each row execute function guard_account_deletion_target();

-- Old snapshot writers omit the new columns. Restore the fence on each rewrite;
-- once cloud erasure is finished, reject resurrection of that original identity.
create or replace function guard_deleted_account_identity()
returns trigger language plpgsql set search_path from current as $$
declare fence account_deletion_fences%rowtype;
begin
  select * into fence from account_deletion_fences where account_id = NEW.account_id;
  if found then
    if exists(select 1 from account_deletion_jobs where job_id = fence.job_id and cloud_erased_at is not null) then
      raise exception 'account_deleted' using errcode = '23514';
    end if;
    NEW.deletion_requested_at := fence.requested_at;
    NEW.deletion_job_id := fence.job_id;
  elsif NEW.deletion_requested_at is not null or NEW.deletion_job_id is not null then
    raise exception 'account_deletion_fence_missing' using errcode = '23514';
  end if;
  return NEW;
end;
$$;
drop trigger if exists account_deletion_identity on accounts;
create trigger account_deletion_identity before insert or update on accounts
  for each row execute function guard_deleted_account_identity();

-- Preserve rewrites of revoked history, while rejecting active authority even
-- from a pre-feature writer or a delayed SQL transaction. Other accounts pass.
create or replace function guard_deleted_account_admission()
returns trigger language plpgsql set search_path from current as $$
declare row_data jsonb := to_jsonb(NEW); active boolean := true;
begin
  if not exists(select 1 from account_deletion_fences where account_id = row_data->>'account_id') then
    return NEW;
  end if;
  if TG_TABLE_NAME in ('instance_bindings','account_devices','account_device_keys','account_credentials') then
    active := row_data->>'revoked_at' is null;
  elsif TG_TABLE_NAME = 'devices' then
    active := row_data->>'unbound_at' is null;
  elsif TG_TABLE_NAME = 'account_connection_leases' then
    active := row_data->>'status' not in ('released','expired');
  end if;
  if active then raise exception 'account_deletion_pending' using errcode = '23514'; end if;
  return NEW;
end;
$$;

do $$
declare target text;
begin
  foreach target in array array[
    'instance_bindings','devices','account_devices','account_device_keys','account_credentials',
    'account_connection_leases','owner_auth_transactions','native_owner_auth_requests',
    'account_join_intents','account_join_grants','provider_refresh_meta','provider_refresh_leases',
    'target_runtime_authorizations','temporary_pairing_exchanges','temporary_control_exchanges','account_pairing_exchanges',
    'instance_authority_completions'
  ] loop
    execute format('drop trigger if exists account_deletion_admission on %I', target);
    execute format('create trigger account_deletion_admission before insert or update on %I for each row execute function guard_deleted_account_admission()', target);
  end loop;
end;
$$;
