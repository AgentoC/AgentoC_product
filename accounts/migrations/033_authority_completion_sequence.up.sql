-- A compensated native request can retry under an unchanged computer binding
-- revision. Its new completion must still reject the old rollback proof.
alter table instance_authority_completions
  add column if not exists completion_sequence bigint generated always as identity;
