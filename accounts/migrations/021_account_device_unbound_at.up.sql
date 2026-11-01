-- Normal account logout unbinds the current session but keeps the
-- installation identity reusable. Permanent device removal still uses
-- revoked_at and remains irreversible for that adev_.
alter table account_devices
  add column if not exists unbound_at timestamptz;
