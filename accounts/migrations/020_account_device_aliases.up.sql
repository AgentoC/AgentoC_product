-- Persist names chosen for computer devices in both owner-auth flows:
-- browser Google binding stores `owner_auth_transactions.alias`, while an
-- Android QR claim carries the name through `account_join_intents.computer_alias`.
alter table owner_auth_transactions
  add column if not exists alias text;

alter table account_join_intents
  add column if not exists computer_alias text;
