-- Android v2 account joins keep the phone in account_devices and the target
-- computer's trusted credential in the instance-local devices store. Persist
-- the link needed by the Accounts-side TURN quota check.
alter table account_join_intents
  add column if not exists account_device_id text
  references account_devices(device_id) on delete set null;

-- Completed v2 joins created before this column was introduced already keep
-- the account-level device on their redeemed grant. Recover that link before
-- new TURN reservations start requiring it.
update account_join_intents as intents
set account_device_id = grants.account_device_id
from (
  select distinct on (intent_id) intent_id, account_device_id
  from account_join_grants
  where redeemed_at is not null
  order by intent_id, redeemed_at desc, created_at desc
) as grants
where intents.status = 'completed'
  and intents.account_device_id is null
  and intents.intent_id = grants.intent_id;

create index if not exists account_join_intents_completed_device_idx
  on account_join_intents (account_id, instance_id, device_id, status)
  where account_device_id is not null;

-- Existing leases used device_id as their quota identity. Keep that behavior
-- when upgrading; new v2 leases may use the canonical account phone id.
alter table account_connection_leases
  add column if not exists quota_device_id text;

update account_connection_leases
set quota_device_id = device_id
where quota_device_id is null;
