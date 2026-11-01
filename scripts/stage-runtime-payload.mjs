#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scanRuntimePayload } from './verify-runtime-payload.mjs';

const exec = promisify(execFile);
const manifestPath = new URL('../packaging/runtime-payload.json', import.meta.url);
function safeName(name) {
  if (!name || /[\\:\0]/.test(name) || isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe runtime manifest path');
  }
  return name;
}
export function selectedBy(profile, name) {
  return (profile.files.includes(name) || profile.prefixes.some((prefix) => name.startsWith(prefix)))
    && !profile.exclude.some((excluded) => name === excluded || (excluded.endsWith('/') && name.startsWith(excluded)));
}
export async function stageRuntimePayload({ source, destination, profile: profileName, manifest = manifestPath }) {
  source = await realpath(resolve(source));
  destination = resolve(destination);
  const git = async (...args) => (await exec('git', ['--no-optional-locks', ...args],
    { cwd: source, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout;
  const head = (await git('rev-parse', 'HEAD')).trim();
  if (await git('status', '--porcelain=v1', '--untracked-files=all')) {
    throw new Error('Runtime payload requires a clean checkout; preserve local work and build from a frozen checkout');
  }
  const manifestBytes = await readFile(manifest);
  const spec = JSON.parse(manifestBytes.toString('utf8'));
  const profile = spec.profiles[profileName];
  if (spec.schemaVersion !== 1 || !profile) throw new Error('Unknown runtime payload profile');
  const tree = new Map((await git('ls-tree', '-r', '-z', 'HEAD')).split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    return [entry.slice(tab + 1), { mode, type, oid }];
  }));
  const tracked = [...tree.keys()];
  const selected = tracked.filter((name) => selectedBy(profile, name));
  for (const required of profile.required) {
    if (!selected.includes(required)) throw new Error(`Required runtime input missing: ${required}`);
  }
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error('Runtime destination must not be a symlink/reparse point');
  destination = await realpath(destination);
  const sourceRelative = relative(destination, source);
  if (!sourceRelative || (!sourceRelative.startsWith('..') && !isAbsolute(sourceRelative))) {
    throw new Error('Runtime destination must not contain its source checkout');
  }
  if ((await readdir(destination)).length) throw new Error('Runtime destination must be empty');
  const files = [];
  const targets = new Set();
  for (const name of selected.sort()) {
    safeName(name);
    const targetName = safeName(profile.rename[name] || name);
    if (targets.has(targetName.toLowerCase())) throw new Error(`Runtime target collision: ${targetName}`);
    targets.add(targetName.toLowerCase());
    let cursor = source;
    for (const component of name.split('/')) {
      cursor = join(cursor, component);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Runtime input symlink/reparse point: ${name}`);
    }
    const input = join(source, name);
    const committed = tree.get(name);
    if (committed.type !== 'blob' || !['100644', '100755'].includes(committed.mode)) {
      throw new Error(`Runtime input must be a committed regular file: ${name}`);
    }
    if (!(await lstat(input)).isFile()) throw new Error(`Runtime input is not a file: ${name}`);
    const bytes = await readFile(input);
    const blobOid = (value) => createHash(committed.oid.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${value.length}\0`).update(value).digest('hex');
    // status alone can miss assume-unchanged/skip-worktree edits. Verify actual
    // bytes against the frozen commit, allowing Git's ordinary CRLF checkout.
    const normalized = bytes.includes(0) ? bytes : Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
    if (blobOid(bytes) !== committed.oid && blobOid(normalized) !== committed.oid) {
      throw new Error(`Runtime input differs from frozen commit: ${name}`);
    }
    const target = join(destination, targetName);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(input, target);
    const copied = await readFile(target);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (createHash('sha256').update(copied).digest('hex') !== sha256) throw new Error(`Input changed while staging: ${name}`);
    files.push({ path: targetName, sha256, bytes: copied.length });
  }
  if ((await git('rev-parse', 'HEAD')).trim() !== head
    || await git('status', '--porcelain=v1', '--untracked-files=all')) {
    throw new Error('Source changed while staging; discard this candidate');
  }
  const scan = await scanRuntimePayload(destination);
  if (!scan.ok) throw new Error(`Runtime payload secret/state check failed: ${JSON.stringify(scan.findings)}`);
  const result = { schemaVersion: 1, profile: profileName, sourceRevision: head,
    allowlistSha256: createHash('sha256').update(manifestBytes).digest('hex'), files };
  await writeFile(join(destination, '.agentoc-source-commit'), `${head}\n`, { flag: 'wx' });
  await writeFile(join(destination, 'runtime-payload-manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--source') options.source = value;
    else if (key === '--destination') options.destination = value;
    else if (key === '--profile') options.profile = value;
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!options.source || !options.destination || !options.profile) throw new Error('Usage: stage-runtime-payload.mjs --source <clean-git-checkout> --destination <empty-dir> --profile <desktop|accounts>');
  const result = await stageRuntimePayload(options);
  console.log(JSON.stringify({ profile: result.profile, sourceRevision: result.sourceRevision, files: result.files.length }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
