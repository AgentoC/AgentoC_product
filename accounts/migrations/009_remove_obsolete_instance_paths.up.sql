-- Remove transport routing metadata. Connection bootstrap is now the only
-- source of transport authority; account bindings store identity only.
alter table instance_bindings drop column if exists public_endpoint;
alter table instance_bindings drop column if exists relay_route;
