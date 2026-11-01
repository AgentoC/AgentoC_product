alter table if exists account_join_intents
  drop column if exists computer_alias;

alter table if exists owner_auth_transactions
  drop column if exists alias;
