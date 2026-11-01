#!/usr/bin/env node

// Deterministic, syntax-light variant generation for static risk testing. It
// never executes a command; every output row keeps its parent case and variant
// kind so a failure can be traced back to the source sample.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--force') {
      out.force = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    out[key] = value;
    index += 1;
  }
  if (!out.input || !out.output) throw new Error('--input and --output are required');
  return out;
}

function readRows(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

function makeVariants(row) {
  const command = typeof row.command === 'string' ? row.command.trim() : '';
  if (!command || command.includes('{{') || command.includes('<PLACEHOLDER>')) return [];
  const normalizedRow = {
    ...row,
    source: row.source || row.sources || 'expanded',
    baseLabel: row.baseLabel || row.base_label || '',
  };
  if (!normalizedRow.expectedTier && ['safe', 'caution', 'danger'].includes(normalizedRow.baseLabel)) {
    normalizedRow.expectedTier = normalizedRow.baseLabel;
  }
  const variants = [];
  const add = (kind, value) => {
    if (!value || value === command || variants.some((item) => item.command === value)) return;
    variants.push({
      ...normalizedRow,
      caseId: `${normalizedRow.caseId || 'row'}:variant:${kind}`,
      parentCaseId: normalizedRow.caseId || '',
      variantKind: kind,
      command: value,
    });
  };

  if (!/^(?:env\s|[A-Za-z_][A-Za-z0-9_]*=)/.test(command)) {
    add('leading-env', `env FOO=bar ${command}`);
  }
  if (!/[;&|\n]/.test(command) && !/^command\s/.test(command)) {
    add('command-wrapper', `command ${command}`);
  }
  if (!/^(?:sudo|env\s+sudo|timeout\s|nohup\s)/.test(command)
    && !/[;&|\n]/.test(command)) {
    add('timeout-wrapper', `timeout 5 ${command}`);
  }
  const expandedWhitespace = command.replace(/\s+/g, '  ');
  add('whitespace', expandedWhitespace);
  return variants;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = resolve(options.output);
  let existing = false;
  try {
    await readFile(outputPath);
    existing = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && !options.force) throw new Error(`output exists: ${outputPath}; pass --force to replace it`);

  const rows = readRows(await readFile(resolve(options.input), 'utf8'));
  const limit = options.limit ? Number(options.limit) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(limit) || limit < 1) throw new Error('--limit must be a positive number');
  const variants = [];
  for (const row of rows) {
    if (variants.length >= limit) break;
    variants.push(...makeVariants(row).slice(0, Math.max(0, limit - variants.length)));
  }
  await writeFile(outputPath, `${variants.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o644 });
  console.log(JSON.stringify({ ok: true, input: resolve(options.input), output: outputPath, sourceRows: rows.length, variants: variants.length }));
}

main().catch((error) => {
  console.error(`risk-dataset-expand: ${error.message}`);
  process.exitCode = 1;
});
