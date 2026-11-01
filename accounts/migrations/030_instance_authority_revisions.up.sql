-- Keep remote-authority generations outside the legacy snapshot writer's
-- DELETE/INSERT tables. No FK: a deleted binding must retain its tombstone.
create table if not exists instance_authority_revisions (
  instance_id text primary key,
  revision bigint not null check (revision > 0),
  authority_state jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);

-- A legacy writer may rewrite the same row several times in one transaction.
-- Queue each instance once and compare only its final committed state.
create table if not exists instance_authority_pending (
  transaction_id bigint not null,
  instance_id text not null,
  primary key (transaction_id, instance_id)
);
create index if not exists binding_history_instance_authority_idx
  on binding_history (instance_id);

create or replace function refresh_instance_authority_revision(target_instance text)
returns void language plpgsql set search_path from current as $$
declare
  final_binding jsonb;
  final_events jsonb;
  final_state jsonb;
begin
  -- Lock before taking the final-state snapshots. Even an independent SQL
  -- transaction cannot overwrite this state after waiting on an old snapshot.
  insert into instance_authority_revisions (instance_id, revision, authority_state)
    values (target_instance, 1, '{"version":0}'::jsonb)
    on conflict do nothing;
  perform 1 from instance_authority_revisions
    where instance_id = target_instance for update;
  select jsonb_build_object(
    'accountId', account_id,
    'keyFingerprint', instance_key_fingerprint,
    'boundAtEpoch', extract(epoch from bound_at),
    'revokedAtEpoch', extract(epoch from revoked_at)
  ) into final_binding from instance_bindings where instance_id = target_instance;
  select jsonb_build_object(
    'bind', count(*) filter (where action = 'bind'),
    'unbind', count(*) filter (where action = 'unbind'),
    'rollback', count(*) filter (where action = 'bind_rollback')
  ) into final_events from binding_history where instance_id = target_instance;
  final_state := jsonb_build_object('version', 1, 'binding', final_binding, 'events', final_events);
  update instance_authority_revisions set
    revision = case when authority_state->>'version' = '0' then 1 else revision + 1 end,
    authority_state = final_state,
    updated_at = clock_timestamp()
  where instance_id = target_instance and authority_state is distinct from final_state;
end;
$$;

create or replace function queue_instance_authority_revision()
returns trigger language plpgsql set search_path from current as $$
begin
  if TG_OP <> 'INSERT' then
    insert into instance_authority_pending values (txid_current(), OLD.instance_id)
      on conflict do nothing;
  end if;
  if TG_OP <> 'DELETE' then
    insert into instance_authority_pending values (txid_current(), NEW.instance_id)
      on conflict do nothing;
  end if;
  return null;
end;
$$;

create or replace function flush_instance_authority_revision()
returns trigger language plpgsql set search_path from current as $$
begin
  perform refresh_instance_authority_revision(NEW.instance_id);
  delete from instance_authority_pending
    where transaction_id = NEW.transaction_id and instance_id = NEW.instance_id;
  return null;
end;
$$;

drop trigger if exists instance_authority_binding_changed on instance_bindings;
create trigger instance_authority_binding_changed
  after insert or update or delete on instance_bindings
  for each row execute function queue_instance_authority_revision();
drop trigger if exists instance_authority_history_changed on binding_history;
create trigger instance_authority_history_changed
  after insert or update or delete on binding_history
  for each row execute function queue_instance_authority_revision();
drop trigger if exists instance_authority_flush on instance_authority_pending;
create constraint trigger instance_authority_flush
  after insert on instance_authority_pending
  deferrable initially deferred
  for each row execute function flush_instance_authority_revision();

-- Existing bindings start a new locally unobserved revision. The client must
-- obtain a signed current policy; this does not restore an old authorization.
select refresh_instance_authority_revision(instance_id) from (
  select instance_id from instance_bindings
  union select instance_id from binding_history
) as existing_instances;
