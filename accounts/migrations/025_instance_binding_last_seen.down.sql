alter table instance_bindings
  drop column if exists last_seen_at;
