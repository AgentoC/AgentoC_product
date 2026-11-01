-- 设备管理：devices 表补 unbound_at（解绑后保留条目），并为账号维度查询加索引。
alter table devices add column if not exists unbound_at timestamptz;

create index if not exists instance_bindings_account_idx on instance_bindings (account_id);
create index if not exists devices_account_idx on devices (account_id);
create index if not exists binding_history_account_idx on binding_history (account_id, occurred_at desc);
