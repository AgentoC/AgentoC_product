drop index if exists instance_bindings_account_active_idx;
drop index if exists devices_account_kind_idx;
alter table devices drop column if exists device_kind;
drop table if exists account_entitlements;
