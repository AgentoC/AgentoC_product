-- Old application versions ignore this additive state. Retain it through code
-- rollback so restarting or upgrading does not invalidate a live browser flow.
do $$ begin
  raise exception 'Retain browser state migration 032 and roll back application code only';
end $$;
