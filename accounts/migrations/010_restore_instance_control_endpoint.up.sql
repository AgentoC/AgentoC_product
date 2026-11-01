-- Restore the public control-plane lookup used by same-account discovery.
-- This is not transport authority and does not restore relay_route.
alter table instance_bindings add column if not exists public_endpoint text;
