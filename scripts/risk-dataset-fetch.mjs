#!/usr/bin/env node

// Fetch a risk dataset only when the caller supplies an exact SHA-256. This
// keeps benchmark inputs reproducible and prevents a moving branch or mirror
// from silently changing a release result.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = join(ROOT, 'tests/fixtures/risk-datasets');
const MANIFEST_PATH = join(FIXTURE_ROOT, 'manifest.json');

function usage() {
  console.log(`Usage:
  node scripts/risk-dataset-fetch.mjs --verify
  node scripts/risk-dataset-fetch.mjs --url URL --sha256 HEX --output PATH [--force]

The fetch mode refuses URLs without an exact 64-character SHA-256 checksum.`);
}

function argsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--force' || token === '--verify' || token === '--help' || token === '-h') {
      result[token.slice(2) || 'help'] = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function countJsonLines(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    try {
      JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  }
  return lines.length;
}

async function verifyManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const results = [];
  for (const dataset of manifest.datasets || []) {
    const path = join(FIXTURE_ROOT, dataset.path);
    const content = await readFile(path);
    const actualSha256 = sha256(content);
    const records = countJsonLines(content);
    const ok = actualSha256 === dataset.sha256 && records === dataset.records;
    results.push({ id: dataset.id, path: dataset.path, records, actualSha256, ok });
    if (!ok) throw new Error(`manifest mismatch for ${dataset.id}`);
  }
  console.log(JSON.stringify({ ok: true, policyVersion: manifest.policyVersion, datasets: results }, null, 2));
}

async function fetchDataset(options) {
  const url = String(options.url || '').trim();
  const expectedSha256 = String(options.sha256 || '').trim().toLowerCase();
  const output = String(options.output || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('--url must be http(s)');
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('--sha256 must be an exact 64-character hex digest');
  if (!output) throw new Error('--output is required');

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  const actualSha256 = sha256(content);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  const outputPath = resolve(output);
  let existing = null;
  try {
    existing = await readFile(outputPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && !options.force) {
    if (sha256(existing) === expectedSha256) {
      console.log(JSON.stringify({ ok: true, unchanged: true, output: outputPath, sha256: actualSha256 }));
      return;
    }
    throw new Error(`output exists with a different checksum: ${outputPath}; pass --force to replace it`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.download-${process.pid}`;
  await writeFile(temporaryPath, content, { mode: 0o644 });
  await rename(temporaryPath, outputPath);
  console.log(JSON.stringify({ ok: true, output: outputPath, bytes: content.length, sha256: actualSha256 }));
}

try {
  const options = argsFrom(process.argv.slice(2));
  if (options.help) {
    usage();
  } else if (options.verify) {
    await verifyManifest();
  } else {
    await fetchDataset(options);
  }
} catch (error) {
  console.error(`risk-dataset-fetch: ${error.message}`);
  usage();
  process.exitCode = 1;
}
