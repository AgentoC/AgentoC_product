drop index if exists account_join_intents_completed_device_idx;
alter table if exists account_join_intents drop column if exists account_device_id;
alter table if exists account_connection_leases drop column if exists quota_device_id;
