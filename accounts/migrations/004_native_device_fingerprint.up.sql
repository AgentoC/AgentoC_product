alter table devices add column if not exists device_public_key_fingerprint text;

create index if not exists devices_instance_fingerprint_idx
  on devices (instance_id, device_public_key_fingerprint);
