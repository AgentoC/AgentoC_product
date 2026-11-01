-- A signed rendezvous inbox poll proves a bound computer still holds its
-- instance key. Persist that activity separately from the immutable binding
-- timestamp so account directories do not report every computer as stale.
alter table instance_bindings
  add column if not exists last_seen_at timestamptz;

update instance_bindings
  set last_seen_at = bound_at
  where last_seen_at is null;
