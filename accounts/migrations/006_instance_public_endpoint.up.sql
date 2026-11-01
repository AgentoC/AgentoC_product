-- Public directory metadata for same-account instance discovery.
-- The endpoint is display/routing metadata only; takeover still requires the
-- target instance account-intent and a newly issued device credential.
alter table instance_bindings add column if not exists public_endpoint text;
