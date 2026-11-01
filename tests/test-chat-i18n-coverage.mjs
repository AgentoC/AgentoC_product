#!/usr/bin/env node
// i18n coverage regression: every t("...") key and data-i18n* attribute key
// referenced by the chat frontend must exist in BOTH translation tables
// (en and zh-CN). A missing key previously rendered as the raw dotted
// identifier in the project picker UI (e.g. "sidebar.project.create"),
// which is exactly the kind of internal-identifier leak users report.
import assert from 'assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const TABLE_RE = /^\s{4}["']?([A-Za-z-]+)["']?\s*:\s*\{/gm;
const KEY_RE = /^\s*"([A-Za-z0-9_.]+)"\s*:/gm;
// i18n accessor styles in use: t(...) (most modules), tr(...) (run-activity-ui,
// workbench-inspector). Template-literal
// keys (e.g. tr(`activity.label.${kind}`)) are dynamic and cannot be checked.
const CALL_RE = /\b(?:t|tr|translate)\(\s*["']([A-Za-z0-9_.]+)["']/g;
const ATTR_RE = /data-i18n(?:-placeholder|-title|-aria-label)?\s*=\s*["']([A-Za-z0-9_.]+)["']/g;

function collectUsedKeys() {
  const used = new Set();
  for (const name of readdirSync(join(repoRoot, 'static/chat'))) {
    if (!name.endsWith('.js')) continue;
    const src = readFileSync(join(repoRoot, 'static/chat', name), 'utf8');
    for (const m of src.matchAll(CALL_RE)) used.add(m[1]);
    for (const m of src.matchAll(ATTR_RE)) used.add(m[1]);
  }
  const html = readFileSync(join(repoRoot, 'templates/chat.html'), 'utf8');
  for (const m of html.matchAll(ATTR_RE)) used.add(m[1]);
  return used;
}

function parseTables(src) {
  const tables = {};
  const starts = [...src.matchAll(TABLE_RE)];
  for (let i = 0; i < starts.length; i++) {
    const name = starts[i][1];
    const start = starts[i].index + starts[i][0].length;
    const end = i + 1 < starts.length ? starts[i + 1].index : src.indexOf('};', start);
    const keys = new Set();
    for (const m of src.slice(start, end).matchAll(KEY_RE)) keys.add(m[1]);
    tables[name] = keys;
  }
  return tables;
}

const i18nSrc = readFileSync(join(repoRoot, 'static/chat/i18n.js'), 'utf8');
const tables = parseTables(i18nSrc);
assert.ok(tables.en, 'en translation table missing');
assert.ok(tables['zh-CN'], 'zh-CN translation table missing');

const used = collectUsedKeys();
const missing = [];
for (const tableName of Object.keys(tables)) {
  for (const key of used) {
    if (!tables[tableName].has(key)) missing.push(`${tableName}: ${key}`);
  }
}
assert.deepEqual(
  missing,
  [],
  `Keys used by the frontend but missing from i18n tables (they would render as raw identifiers):\n${missing.join('\n')}`
);

console.log('test-chat-i18n-coverage: ok');
