alter table owner_auth_transactions
  drop column if exists poll_expires_at,
  drop column if exists poll_assertion,
  drop column if exists poll_redeemed_at,
  drop column if exists poll_request_id,
  drop column if exists delivery_mode;

-- Do not restore return_url NOT NULL here: a poll transaction may have been
-- created without a callback URL, and making rollback destructive is unsafe.
