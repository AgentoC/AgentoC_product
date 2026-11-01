drop index if exists devices_instance_fingerprint_idx;
alter table devices drop column if exists device_public_key_fingerprint;
