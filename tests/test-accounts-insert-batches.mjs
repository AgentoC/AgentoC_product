import assert from 'node:assert/strict';
import { insertRowsInBatches } from '../accounts/store/insert-batches.mjs';

const queries = [];
const client = { query: async (sql, values) => queries.push({ sql, values }) };
const rows = Array.from({ length: 205 }, (_, n) => ({ id: `row_${n}`, payload: { n, text: "bound ' $1 中文" } }));
await insertRowsInBatches(client, 'qa_rows', ['id', 'payload'], rows, (x) => x);
assert.equal(queries.length, 3);
assert.deepEqual(queries.map((q) => q.values.length), [200, 200, 10]);
assert.deepEqual(queries.flatMap((q) => q.values), rows.flatMap((r) => [r.id, r.payload]));
assert.match(queries[0].sql, /\(\$1, \$2\), \(\$3, \$4\)/);
assert.match(queries[2].sql, /\(\$9, \$10\)$/);
assert.doesNotMatch(queries[0].sql, /中文|bound|row_/);
queries.length = 0;
await insertRowsInBatches(client, 'qa_rows', ['id', 'payload'], rows.slice(0, 4), (x) => x, { maxBytes: 100 });
assert.equal(queries.length, 4, 'Byte budget splits UTF-8/JSON rows independently of row count');
queries.length = 0;
await insertRowsInBatches(client, 'qa_rows', ['id', 'payload'], [{ id: 'large', payload: 'x'.repeat(1000) }, rows[0]], (x) => x, { maxBytes: 100 });
assert.equal(queries.length, 2); assert.equal(queries[0].values.length, 2);
queries.length = 0;
await insertRowsInBatches(client, 'qa_rows', ['id'], [], (x) => x);
assert.equal(queries.length, 0);
for (const table of ['qa;drop table accounts', 'public.accounts']) {
  await assert.rejects(insertRowsInBatches(client, table, ['id'], rows, (x) => x), /Invalid bounded insert/);
}
let calls = 0;
await assert.rejects(insertRowsInBatches({ query: async () => { if (++calls === 2) throw new Error('fixture database failure'); } },
  'qa_rows', ['id'], rows, (x) => x), /fixture database failure/);
assert.equal(calls, 2, 'Failed batch must not continue or replay later rows');
console.log('PASS bounded Accounts insert batches: exact parameter/row preservation, count/UTF-8 byte bounds, empty/large rows, identifiers and fail-fast publication');
