-- Older application code is compatible with the additive table. Keep the
-- original authorization evidence during code rollback and later re-upgrade.
do $$ begin
  raise exception 'Authority completion evidence cannot be downgraded; retain migration 031 and roll back application code only';
end $$;
