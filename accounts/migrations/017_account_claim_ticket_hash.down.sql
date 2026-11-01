drop index if exists account_join_intents_claim_ticket_idx;
alter table account_join_intents drop column if exists account_claim_token_hash;
