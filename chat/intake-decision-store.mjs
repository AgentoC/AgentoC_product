/** Private preparation record: current decision per intake, without raw material. */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CONFIG_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';

export function createIntakeDecisionStore(options = {}) {
  const databasePath = options.databasePath || join(CONFIG_DIR, 'intake-decisions.sqlite');
  const serialize = createSerialTaskQueue();

  async function withDatabase(effect) {
    await mkdir(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS intake_decisions (
        intake_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      return effect(db);
    } finally { db.close(); }
  }

  async function record(decision, now = new Date()) {
    if (!decision?.intakeId || !decision?.decisionId || !decision?.inputDigest) {
      throw new Error('Incomplete intake decision');
    }
    return serialize(() => withDatabase((db) => {
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
      db.prepare(`INSERT INTO intake_decisions
        (intake_id, decision_id, input_digest, decision_json, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(intake_id) DO UPDATE SET
          decision_id = excluded.decision_id,
          input_digest = excluded.input_digest,
          decision_json = excluded.decision_json,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`)
        .run(decision.intakeId, decision.decisionId, decision.inputDigest,
          JSON.stringify(decision), expiresAt, now.toISOString());
      return { decisionId: decision.decisionId, expiresAt };
    }));
  }

  async function get(intakeId, decisionId, now = new Date()) {
    return withDatabase((db) => {
      const row = db.prepare(`SELECT decision_json FROM intake_decisions
        WHERE intake_id = ? AND decision_id = ? AND expires_at > ?`)
        .get(intakeId, decisionId, now.toISOString());
      return row ? JSON.parse(row.decision_json) : null;
    });
  }

  return { record, get };
}

export const defaultIntakeDecisionStore = createIntakeDecisionStore();
