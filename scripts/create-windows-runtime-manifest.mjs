#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function createWindowsRuntimeManifest(payloadRoot) {
  const root = await realpath(resolve(payloadRoot));
  const vendor = join(root, 'vendor');
  const roots = ['Microsoft.WinGet.Client', 'PowerShell'];
  const files = [];
  const seen = new Set();
  async function visit(folder) {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Runtime directory must be a regular directory');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const absolute = join(folder, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new Error('Runtime links are not permitted');
      if (stats.isDirectory()) { await visit(absolute); continue; }
      if (!stats.isFile() || stats.nlink !== 1) throw new Error('Runtime inputs must be regular, single-link files');
      const name = relative(vendor, absolute).replaceAll('\\', '/');
      if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(name.toLowerCase())) {
        throw new Error('Runtime input path is invalid');
      }
      seen.add(name.toLowerCase());
      files.push({ path: name, size: stats.size, sha256: await fileHash(absolute) });
      if (files.length > 4096) throw new Error('Runtime file count exceeded');
    }
  }
  for (const name of roots) await visit(join(vendor, name));
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const required of ['PowerShell/pwsh.exe', 'Microsoft.WinGet.Client/Microsoft.WinGet.Client.psd1']) {
    if (!files.some((entry) => entry.path === required)) throw new Error('Required runtime input is missing');
  }
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, files })}\n`, 'utf8');
  const manifestPath = join(vendor, 'runtime-integrity.json');
  await writeFile(manifestPath, bytes, { flag: 'wx' });
  return { path: manifestPath, sha256: createHash('sha256').update(bytes).digest('hex'), files: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) throw new Error('Expected one absolute payload root');
  const result = await createWindowsRuntimeManifest(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
