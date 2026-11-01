-- Short-lived, purpose-bound identity confirmation; never an account session.
create table if not exists account_deletion_confirmation_clock (
  singleton boolean primary key default true check (singleton),
  last_observed_at bigint not null check (last_observed_at between 0 and 8640000000000000)
);
insert into account_deletion_confirmation_clock values(true,0) on conflict do nothing;

create table if not exists account_deletion_confirmations (
  request_id uuid primary key,
  confirmation_id uuid not null unique,
  receipt_secret_hash text not null check (receipt_secret_hash ~ '^[a-f0-9]{64}$'),
  confirmation_secret_hash text not null check (confirmation_secret_hash ~ '^[a-f0-9]{64}$'),
  nonce text not null unique check (length(nonce)=43),
  channel text not null check (channel in ('web','native')),
  expected_account_hash text check (expected_account_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at>created_at and expires_at<=created_at+interval '5 minutes'),
  verified_at timestamptz,
  account_id text references accounts(account_id) on delete cascade,
  verified_subject_hash text check (verified_subject_hash ~ '^[a-f0-9]{64}$'),
  check ((verified_at is null and account_id is null and verified_subject_hash is null)
    or (verified_at is not null and account_id is not null and verified_subject_hash is not null))
);
create index if not exists account_deletion_confirmations_expiry on account_deletion_confirmations(expires_at);

create or replace function guard_account_deletion_confirmation_clock()
returns trigger language plpgsql set search_path from current as $$ begin
  if NEW.last_observed_at<OLD.last_observed_at then
    raise exception 'account_deletion_clock_regression' using errcode='23514';
  end if;
  return NEW;
end; $$;
drop trigger if exists account_deletion_clock_monotonic on account_deletion_confirmation_clock;
create trigger account_deletion_clock_monotonic before update on account_deletion_confirmation_clock
  for each row execute function guard_account_deletion_confirmation_clock();

create or replace function guard_account_deletion_confirmation()
returns trigger language plpgsql set search_path from current as $$ begin
  if NEW.account_id is not null and exists(select 1 from account_deletion_fences where account_id=NEW.account_id) then
    raise exception 'account_deletion_pending' using errcode='23514';
  end if;
  if TG_OP='UPDATE' then
    if NEW.request_id is distinct from OLD.request_id or NEW.receipt_secret_hash is distinct from OLD.receipt_secret_hash
      or NEW.channel is distinct from OLD.channel or NEW.expected_account_hash is distinct from OLD.expected_account_hash then
      raise exception 'account_deletion_confirmation_identity_changed' using errcode='23514';
    end if;
    if NEW.confirmation_id=OLD.confirmation_id then
      if (NEW.confirmation_secret_hash,NEW.nonce,NEW.created_at,NEW.expires_at)
        is distinct from (OLD.confirmation_secret_hash,OLD.nonce,OLD.created_at,OLD.expires_at)
        or (OLD.verified_at is not null and (NEW.verified_at,NEW.account_id,NEW.verified_subject_hash)
          is distinct from (OLD.verified_at,OLD.account_id,OLD.verified_subject_hash)) then
        raise exception 'account_deletion_confirmation_rebound' using errcode='23514';
      end if;
    elsif extract(epoch from OLD.expires_at)*1000 >
      (select last_observed_at from account_deletion_confirmation_clock where singleton=true)
      or NEW.verified_at is not null then
      raise exception 'account_deletion_confirmation_not_expired' using errcode='23514';
    end if;
  end if;
  return NEW;
end; $$;
drop trigger if exists account_deletion_confirmation_identity on account_deletion_confirmations;
create trigger account_deletion_confirmation_identity before insert or update on account_deletion_confirmations
  for each row execute function guard_account_deletion_confirmation();
