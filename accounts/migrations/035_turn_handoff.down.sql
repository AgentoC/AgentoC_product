-- Dropping a used handoff fence can permit a stale generation to reappear.
do $$ begin
  if exists(select 1 from account_connection_leases where handoff_from is not null) then
    raise exception 'turn_handoff_rollback_unsafe';
  end if;
end; $$;
alter table account_connection_leases
  drop column if exists handoff_from,
  drop column if exists handoff_deadline,
  drop column if exists handoff_committed_at;
