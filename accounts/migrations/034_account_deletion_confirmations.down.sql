-- Quiesce the feature first. Never discard an outstanding intent or a used
-- feature's clock/fence lifecycle to roll credentials back.
do $$ begin
  if exists(select 1 from account_deletion_confirmations) or exists(select 1 from account_deletion_jobs) then
    raise exception 'account_deletion_confirmation_rollback_unsafe';
  end if;
end; $$;
drop trigger account_deletion_confirmation_identity on account_deletion_confirmations;
drop trigger account_deletion_clock_monotonic on account_deletion_confirmation_clock;
drop function guard_account_deletion_confirmation();
drop function guard_account_deletion_confirmation_clock();
drop table account_deletion_confirmations;
drop table account_deletion_confirmation_clock;
