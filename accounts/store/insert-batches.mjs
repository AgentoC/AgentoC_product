// Bounded parameterized inserts for the existing serialized snapshot writer.
// This reduces database round trips; it does not remove the transaction lock,
// change write ordering, or claim to implement account-scoped repositories.
const identifier = /^[a-z_][a-z0-9_]*$/;
const byteSize = (value) => value == null ? 4 : Buffer.isBuffer(value) ? value.length
  : Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

export async function insertRowsInBatches(client, table, columns, rows, toRow,
  { maxRows = 100, maxBytes = 256 * 1024, conflictKey = null } = {}) {
  if (!identifier.test(table) || !columns.length || columns.length > 64 || columns.some((name) => !identifier.test(name))
    || new Set(columns).size !== columns.length || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024
    || (conflictKey !== null && (!identifier.test(conflictKey) || !columns.includes(conflictKey)))) {
    throw new Error('Invalid bounded insert specification');
  }
  let batch = [], bytes = 0;
  async function flush() {
    if (!batch.length) return;
    const values = batch.flat();
    const tuples = batch.map((_, row) => `(${columns.map((_, column) => `$${row * columns.length + column + 1}`).join(', ')})`);
    const updates = columns.filter(column => column !== conflictKey);
    const conflict = conflictKey === null ? '' : ` on conflict (${conflictKey}) ` +
      (updates.length ? `do update set ${updates.map(column => `${column} = excluded.${column}`).join(', ')}` : 'do nothing');
    await client.query(`insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')}${conflict}`, values);
    batch = []; bytes = 0;
  }
  for (const item of rows) {
    const row = toRow(item);
    const values = columns.map((column) => row[column]);
    const size = values.reduce((total, value) => total + byteSize(value) + 16, 0);
    if (batch.length && (batch.length >= maxRows || bytes + size > maxBytes)) await flush();
    batch.push(values); bytes += size;
    // An individually large existing row is sent alone, preserving the prior
    // writer's supported row size instead of collecting more payload beside it.
    if (bytes >= maxBytes) await flush();
  }
  await flush();
}

/** Delta under the caller's transaction/lock; the caller manages dependent rows. */
export async function syncRowsByPrimaryKey(client, table, columns, rows, previousRows, toRow, key) {
  if (!identifier.test(table) || !identifier.test(key) || !columns.includes(key)
    || !columns.length || columns.length > 64 || columns.some(column => !identifier.test(column))
    || new Set(columns).size !== columns.length) throw new Error('Invalid row delta specification');
  function indexed(items) {
    const result = new Map();
    for (const item of items) {
      const row = toRow(item);
      if (typeof row[key] !== 'string' || result.has(row[key])) {
        const error = new Error('Duplicate or invalid row delta primary key');
        error.code = '23505';
        throw error;
      }
      result.set(row[key], { row, serialized: JSON.stringify(columns.map(column => row[column])) });
    }
    return result;
  }
  const before = indexed(previousRows), after = indexed(rows);
  const removed = [...before.keys()].filter(value => !after.has(value));
  for (let offset = 0; offset < removed.length; offset += 100) {
    await client.query(`delete from ${table} where ${key} = any($1::text[])`, [removed.slice(offset, offset + 100)]);
  }
  const changed = [...after.entries()].filter(([value, item]) => before.get(value)?.serialized !== item.serialized)
    .map(([, item]) => item.row);
  await insertRowsInBatches(client, table, columns, changed, row => row, { conflictKey: key });
}
