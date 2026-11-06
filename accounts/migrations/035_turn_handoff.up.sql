-- Handoff metadata is additive; a rolling deployment must quiesce writers
-- that do not preserve these fields before enabling the handoff protocol.
alter table account_connection_leases
  add column if not exists handoff_from text,
  add column if not exists handoff_deadline timestamptz,
  add column if not exists handoff_committed_at timestamptz;
