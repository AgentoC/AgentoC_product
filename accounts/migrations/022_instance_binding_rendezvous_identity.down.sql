alter table instance_bindings
  drop column if exists instance_key_fingerprint,
  drop column if exists instance_public_key;
