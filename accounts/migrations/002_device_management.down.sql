drop index if exists binding_history_account_idx;
drop index if exists devices_account_idx;
drop index if exists instance_bindings_account_idx;
alter table devices drop column if exists unbound_at;
