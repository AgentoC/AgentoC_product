do $$ begin
  raise exception 'Retain authority completion sequence 033 and roll back application code only';
end $$;
