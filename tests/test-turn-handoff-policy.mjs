import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTurnHandoff, commitTurnHandoff, abortTurnHandoff, expireTurnHandoffs } from '../accounts/turn-handoff-policy.mjs';
import { activeTurnConnectionState } from '../accounts/turn-lease-policy.mjs';

const now = Date.parse('2026-11-06T00:00:00Z');
const iso = n => new Date(n).toISOString();
const lease = id => ({ connectionId: id, accountId: 'a', instanceId: 'pc', deviceId: 'phone',
  quotaDeviceId: 'account-phone', deviceKind: 'phone', status: 'reserved', expiresAt: iso(now + 180_000) });
const prepare = (rows, next = lease('new'), at = now, deadline = iso(now + 90_000)) =>
  prepareTurnHandoff(rows, 'old', next, at, deadline);

test('preparation, authenticated commit and draining consume one phone quota', () => {
  const rows = [lease('old')]; const next = prepare(rows);
  assert.equal(next.handoffDeadline, iso(now + 60_000));
  assert.equal(rows[0].status, 'reserved');
  assert.deepEqual(activeTurnConnectionState({ turnConnectionLeases: rows }, 'a', now).activePhoneDeviceIds, ['account-phone']);
  commitTurnHandoff(rows, 'new', now + 10);
  assert.equal(rows[0].status, 'reserved');
  assert.throws(() => prepareTurnHandoff(rows, 'new', lease('third'), now + 20, iso(now + 70_000)), { code: 'turn_handoff_already_pending' });
});

test('rollback and expiry never revoke the old generation or admit replay', () => {
  const rows = [lease('old')]; prepare(rows);
  assert.equal(abortTurnHandoff(rows, 'new', now + 1), true);
  assert.equal(rows[0].status, 'reserved');
  assert.throws(() => commitTurnHandoff(rows, 'new', now + 2), { code: 'turn_handoff_commit_invalid' });
  assert.throws(() => prepare(rows), { code: 'turn_handoff_generation_exists' });
  prepare(rows, lease('newer'), now + 3);
  assert.equal(activeTurnConnectionState({ turnConnectionLeases: rows }, 'a', now + 60_003).leases.length, 1,
    'An expired standby is excluded even before the next cleanup mutation');
  expireTurnHandoffs(rows, now + 60_003);
  assert.equal(rows[2].releaseReason, 'handoff-expired');
  assert.equal(rows[0].status, 'reserved');
});

test('signed deadline, pair identity, and pending generation are fenced', () => {
  const rows = [lease('old')];
  assert.throws(() => prepare(rows, { ...lease('bad'), status: 'released' }), { code: 'turn_handoff_replacement_invalid' });
  assert.throws(() => prepare(rows, { ...lease('wrong'), deviceId: 'other' }), { code: 'turn_handoff_predecessor_invalid' });
  assert.throws(() => prepare(rows, lease('no-deadline'), now, ''), { code: 'turn_handoff_deadline_invalid' });
  assert.equal(prepare(rows, lease('new'), now, iso(now + 1_000)).handoffDeadline, iso(now + 1_000));
  assert.throws(() => prepare(rows, lease('other')), { code: 'turn_handoff_already_pending' });
  assert.throws(() => commitTurnHandoff(rows, 'new', now + 1_000), { code: 'turn_handoff_commit_invalid' });
  assert.equal(rows[0].status, 'reserved');
});
