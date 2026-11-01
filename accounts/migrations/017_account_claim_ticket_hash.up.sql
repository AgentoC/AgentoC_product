alter table account_join_intents
  add column if not exists account_claim_token_hash text;

create index if not exists account_join_intents_claim_ticket_idx
  on account_join_intents (instance_id, account_claim_token_hash, expires_at);
