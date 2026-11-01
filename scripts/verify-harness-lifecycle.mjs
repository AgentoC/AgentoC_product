#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { verifyHarnessLifecycleMatrix } from '../chat/harness-verification.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

const outputPath = option('--out');
const report = await verifyHarnessLifecycleMatrix();
const serialized = `${JSON.stringify(report, null, 2)}\n`;

if (outputPath) {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialized, { mode: 0o600 });
  process.stdout.write(`${target}\n`);
} else {
  process.stdout.write(serialized);
}
