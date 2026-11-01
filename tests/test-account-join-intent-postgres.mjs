#!/usr/bin/env node
import assert from 'node:assert/strict';

import { createPostgresStore } from '../accounts/store/postgres.mjs';

const rows = {
  accounts: [],
  owner_auth_transactions: [],
  owner_auth_browser_states: [],
  instance_bindings: [],
  devices: [],
  binding_history: [],
  native_owner_auth_requests: [],
  account_join_intents: [],
  account_entitlements: [],
  account_connection_leases: [],
  account_sync_catalog: [],
  account_devices: [],
  account_device_keys: [],
  account_credentials: [],
  account_session_challenges: [],
  account_credential_refreshes: [],
  account_join_grants: [],
  provider_refresh_leases: [],
  provider_refresh_meta: [],
  target_runtime_authorizations: [],
  temporary_pairing_exchanges: [],
  temporary_pairing_clock: [{ singleton: true, last_observed_at: 0 }],
  temporary_control_exchanges: [],
  temporary_control_clock: [{ singleton: true, last_observed_at: 0 }],
  account_pairing_exchanges: [],
};

let advisoryLockFailures = 0;
const queries = [];

function fakeClient() {
  return {
    async query(sql, values = []) {
      const normalized = sql.trim().toLowerCase();
      queries.push({ sql: normalized, values });
      if (['begin', 'commit', 'rollback'].includes(normalized)
        || normalized.startsWith('select set_config')
        || normalized === 'select 1') return { rows: [], rowCount: 0 };
      if (normalized.startsWith('select pg_advisory_xact_lock')) {
        if (advisoryLockFailures > 0) {
          advisoryLockFailures -= 1;
          const error = new Error('canceling statement due to lock timeout');
          error.code = '55P03';
          throw error;
        }
        return { rows: [], rowCount: 0 };
      }

      const select = /^select \* from ([a-z_]+)/.exec(normalized);
      if (select) return { rows: rows[select[1]].map((row) => ({ ...row })), rowCount: rows[select[1]].length };
      const clock = /^select last_observed_at from (temporary_pairing_clock|temporary_control_clock) where singleton = true$/.exec(normalized);
      if (clock) {
        return { rows: rows[clock[1]].map((row) => ({ ...row })) };
      }

      const deleteAll = /^delete from ([a-z_]+)$/.exec(normalized);
      if (deleteAll) {
        rows[deleteAll[1]].length = 0;
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('delete from accounts where')) return { rows: [], rowCount: 0 };
      if (normalized.startsWith('delete from owner_auth_browser_states s where not exists')) {
        rows.owner_auth_browser_states = rows.owner_auth_browser_states.filter(s => rows.owner_auth_transactions.some(t =>
          t.transaction_id === s.transaction_id && t.nonce === s.nonce && t.bootstrap_hash === s.bootstrap_hash));
        return { rows: [], rowCount: 0 };
      }
      if (normalized === 'delete from account_join_intents where intent_id = any($1::text[])') {
        rows.account_join_intents = rows.account_join_intents.filter(row => !values[0].includes(row.intent_id));
        return { rows: [], rowCount: values[0].length };
      }

      const insert = /^insert into ([a-z_]+) \(([^)]+)\) values/.exec(normalized);
      if (insert) {
        const columns = insert[2].split(',').map((column) => column.trim());
        assert.equal(values.length % columns.length, 0);
        for (let offset = 0; offset < values.length; offset += columns.length) {
          const row = Object.fromEntries(columns.map((column, index) => [column, values[offset + index]]));
          const existing = normalized.includes('on conflict (intent_id)')
            ? rows[insert[1]].findIndex(previous => previous.intent_id === row.intent_id) : -1;
          if (existing < 0) rows[insert[1]].push(row);
          else rows[insert[1]][existing] = row;
        }
        return { rows: [], rowCount: values.length / columns.length };
      }
      throw new Error(`Unexpected fake Postgres query: ${sql}`);
    },
    release() {},
  };
}

const pool = { connect: async () => fakeClient() };
const store = createPostgresStore({ pool });
const intent = {
  intentId: 'rji_pg_roundtrip',
  instanceId: 'inst_pg_roundtrip',
  instance: {
    instanceId: 'inst_pg_roundtrip',
    publicKey: '-----BEGIN PUBLIC KEY-----\ninstance\n-----END PUBLIC KEY-----',
    keyFingerprint: 'instance-fingerprint',
  },
  deviceId: 'rdev_pg_roundtrip',
  devicePublicKey: '-----BEGIN PUBLIC KEY-----\ndevice\n-----END PUBLIC KEY-----',
  devicePublicKeyFingerprint: 'device-fingerprint',
  deviceAlias: 'Pixel',
  computerAlias: 'Living room PC',
  platform: 'android',
  publicEndpoint: '',
  nonceHash: 'nonce-hash',
  issuedAt: '2026-08-14T12:00:00.000Z',
  createdAt: '2026-08-14T12:00:01.000Z',
  expiresAt: '2026-08-14T12:02:01.000Z',
  status: 'pending',
  accountId: '',
  accountDeviceId: '',
  completionRequestId: '',
  completedAt: '',
};

await store.mutate(async (draft) => {
  draft.accountJoinIntents.push(intent);
});
const snapshot = await store.mutate(async (draft) => draft);
assert.equal(snapshot.accountJoinIntents.length, 1);
assert.equal(snapshot.accountJoinIntents[0].intentId, intent.intentId);
assert.equal(snapshot.accountJoinIntents[0].computerAlias, intent.computerAlias);
assert.equal(rows.account_join_intents[0].nonce_hash, 'nonce-hash');
assert.equal(rows.account_join_intents[0].instance_public_key, intent.instance.publicKey);
assert.equal(rows.account_join_intents[0].computer_alias, 'Living room PC');
assert.equal(rows.account_join_intents[0].account_device_id, null);

assert.ok(
  queries.some((query) => query.sql.startsWith('select set_config')
    && query.values[0] === 'lock_timeout'
    && query.values[1] === '5000ms'),
  'mutations must configure a bounded PostgreSQL advisory-lock wait',
);
advisoryLockFailures = 1;
await assert.rejects(
  store.mutate(async () => {}),
  (error) => error?.code === '55P03',
  'a lock timeout must surface to the caller',
);
await store.mutate(async () => {});
console.log('test-account-join-intent-postgres: 9 assertions passed');

const exchange = { version: 1, invitationId: 'rti_mapping_fixture', instanceId: 'inst_mapping_fixture',
  accountId: 'acct_mapping_fixture', status: 'CLAIMED', claimExpiresAt: 1_800_000_120_000,
  accessExpiresAt: 1_800_000_600_000, sealedToken: { keyId: 'mapping', iv: 'iv', data: 'ciphertext', tag: 'tag' },
  nonces: [{ nonceHash: 'hash', expiresAt: 1_800_000_030_000 }],
  connection: { version: 1, request: { payload: { connectionRequestId: 'rtr_mapping_fixture' } },
    delivery: { payloadDigest: 'mapping-digest', expiresAt: 1_800_000_595_000,
      sealed: { keyId: 'mapping', iv: 'iv', data: 'encrypted-connection', tag: 'tag' } } } };
await store.mutate((draft) => { draft.temporaryPairingExchanges.push(exchange); draft.temporaryPairingClock = 1_800_000_000_000; });
const freshStore = createPostgresStore({ pool });
const restored = await freshStore.mutate((draft) => draft);
assert.deepEqual(restored.temporaryPairingExchanges, [exchange]);
assert.equal(restored.temporaryPairingClock, 1_800_000_000_000);
assert.equal(restored.accountJoinIntents[0].intentId, intent.intentId);
rows.temporary_pairing_exchanges[0].status = 'REGISTERED';
await assert.rejects(freshStore.mutate(() => {}), /does not match its payload/);
rows.temporary_pairing_exchanges[0].status = exchange.status;
const clockRow = rows.temporary_pairing_clock.pop();
await assert.rejects(freshStore.mutate(() => {}), /clock is missing or invalid/);
rows.temporary_pairing_clock.push(clockRow);
await freshStore.mutate(() => {});
console.log('temporary-pairing Postgres adapter: roundtrip, existing-data preservation, corruption and clock checks passed (fake SQL client)');
