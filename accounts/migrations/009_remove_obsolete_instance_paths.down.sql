alter table instance_bindings add column if not exists public_endpoint text;
alter table instance_bindings add column if not exists relay_route jsonb;
