drop index if exists account_join_intents_rendezvous_idx;
alter table if exists account_join_intents
  drop column if exists rendezvous_result,
  drop column if exists rendezvous_grant,
  drop column if exists rendezvous_device_signature,
  drop column if exists rendezvous_nonce,
  drop column if exists rendezvous_request_id;
