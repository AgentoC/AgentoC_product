-- Old application writers remain compatible with this additive migration.
-- Roll back application code only: dropping generations could revive a stale
-- signed policy after a later upgrade. Never restore an older authority table.
do $$ begin
  raise exception 'Authority revision tombstones cannot be downgraded; retain migration 030 and roll back application code only';
end $$;
