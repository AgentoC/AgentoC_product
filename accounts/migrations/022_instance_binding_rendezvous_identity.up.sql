-- Bound computers must retain their public rendezvous identity after the
-- Accounts service reconstructs its in-memory snapshot from PostgreSQL.
alter table instance_bindings
  add column if not exists instance_public_key text,
  add column if not exists instance_key_fingerprint text;
