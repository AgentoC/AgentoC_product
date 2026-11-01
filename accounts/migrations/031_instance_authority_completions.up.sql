-- Preserve the generation actually authorized by an operation, independently
-- of old writers which rewrite the ordinary transaction/request tables.
create table if not exists instance_authority_completions (
  operation_kind text not null check (operation_kind in ('browser', 'native', 'account_join')),
  operation_id text not null,
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  instance_id text not null,
  account_id text not null references accounts(account_id) on delete cascade,
  key_fingerprint text not null,
  authority_revision bigint not null check (authority_revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (operation_kind, operation_id, source_digest)
);
create index if not exists instance_authority_completions_instance_idx
  on instance_authority_completions (instance_id);
