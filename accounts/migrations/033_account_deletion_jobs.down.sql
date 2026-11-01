-- Security rollback is not restoration of deleted authority. Once any request
-- exists, retain this schema/fence and roll forward instead.
do $$ begin
  if exists(select 1 from account_deletion_jobs) then
    raise exception 'account_deletion_rollback_would_remove_fences';
  end if;
end; $$;
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
  end loop;
end; $$;
drop trigger if exists account_deletion_identity on accounts;
drop trigger if exists account_deletion_job_identity on account_deletion_jobs;
drop trigger if exists account_deletion_target_immutable on account_deletion_targets;
drop trigger if exists account_deletion_fence_immutable on account_deletion_fences;
drop function if exists guard_deleted_account_admission();
drop function if exists guard_deleted_account_identity();
drop function if exists guard_account_deletion_job_identity();
drop function if exists guard_account_deletion_target();
drop function if exists guard_account_deletion_fence();
alter table accounts drop column if exists deletion_requested_at;
alter table accounts drop column if exists deletion_job_id;
drop table account_deletion_targets;
drop table account_deletion_fences;
drop table account_deletion_jobs;
