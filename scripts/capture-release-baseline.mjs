#!/usr/bin/env node
// Capture hashes, not patch contents, credentials or user/runtime configuration.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readlink, writeFile } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
async function hashFile(path) {
  const before = await lstat(path);
  if (before.isSymbolicLink()) return { type: 'symlink', sha256: digest(await readlink(path)) };
  if (!before.isFile()) throw new Error('Baseline inputs must be regular files');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error('Baseline input changed while hashing');
  }
  return { type: 'file', bytes: after.size, sha256: hash.digest('hex') };
}

export async function captureBaseline({ repo = defaultRepo, artifacts = [] } = {}) {
  repo = resolve(repo);
  const git = async (...args) => (await exec('git', ['--no-optional-locks', ...args], {
    cwd: repo, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer',
  })).stdout;
  const snapshot = async () => {
    const [head, status, index, patch, changed, untracked] = await Promise.all([
      git('rev-parse', 'HEAD'), git('status', '--porcelain=v1', '-z'), git('ls-files', '--stage', '-z'),
      git('diff', '--no-ext-diff', '--binary', 'HEAD'), git('diff', '--name-only', '-z', 'HEAD'),
      git('ls-files', '--others', '--exclude-standard', '-z'),
    ]);
    const files = [...new Set(`${changed.toString()}${untracked.toString()}`.split('\0').filter(Boolean))].sort();
    const workingFiles = {};
    for (const file of files) {
      try { workingFiles[file] = await hashFile(join(repo, file)); }
      catch (error) {
        if (error.code === 'ENOENT') workingFiles[file] = { type: 'deleted' };
        else throw error;
      }
    }
    return { head: head.toString().trim(), dirty: status.length > 0,
      statusSha256: digest(status), indexSha256: digest(index), patchSha256: digest(patch), workingFiles };
  };
  const start = await snapshot();
  const lockedInputs = {};
  for (const file of ['package.json', 'package-lock.json', 'p2p/go.mod', 'p2p/go.sum',
    'android/gradle/libs.versions.toml', 'android/app/build.gradle.kts', 'AGENTS.md']) {
    try { lockedInputs[file] = await hashFile(join(repo, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const artifactHashes = [];
  for (const path of artifacts) artifactHashes.push({ path: resolve(path), ...await hashFile(resolve(path)) });
  const end = await snapshot();
  const stable = JSON.stringify(start) === JSON.stringify(end);
  return {
    schemaVersion: 1, capturedAt: new Date().toISOString(), repo,
    evidenceLevel: 'source-and-local-artifact-hashes', consistency: stable ? 'stable' : 'changed-during-capture',
    source: end, lockedInputs, artifacts: artifactHashes,
    platform: { os: process.platform, arch: arch(), release: release(), node: process.version },
    limitations: ['A stable dirty snapshot is not a clean release checkout.',
      'No installed-device or live TURN/Provider success is inferred from file hashes.'],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = { artifacts: [] };
  let output = '';
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--repo') options.repo = value;
    else if (key === '--output') output = value;
    else if (key === '--artifact') options.artifacts.push(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!output) throw new Error('Usage: capture-release-baseline.mjs --output <new-file> [--repo <dir>] [--artifact <file>]');
  const baseline = await captureBaseline(options);
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ output: path, head: baseline.source.head,
    dirty: baseline.source.dirty, consistency: baseline.consistency, artifacts: baseline.artifacts.length })}\n`);
  if (baseline.consistency !== 'stable') process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
