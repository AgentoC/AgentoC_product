-- Independent of the legacy full DELETE/INSERT transaction writer. A browser
-- state belongs to the exact transaction nonce/bootstrap, never just its ID.
create table if not exists owner_auth_browser_states (
  transaction_id text not null,
  nonce text not null,
  bootstrap_hash text not null check (bootstrap_hash ~ '^[a-f0-9]{64}$'),
  state_hash text not null check (state_hash ~ '^[a-f0-9]{64}$'),
  primary key (transaction_id, nonce, bootstrap_hash)
);
