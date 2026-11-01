#!/usr/bin/env node
import { createInterface } from 'readline';
import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { hashPasswordAsync } from './lib/auth.mjs';
import { AUTH_FILE } from './lib/config.mjs';

const authFile = AUTH_FILE;
const authDir = dirname(authFile);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

const username = (await ask('Username: ')).trim();
const password = (await ask('Password: ')).trim();
rl.close();

if (!username || !password) {
  console.error('Error: username and password cannot be empty.');
  process.exit(1);
}

await mkdir(authDir, { recursive: true });

let existing = {};
if (await pathExists(authFile)) {
  try { existing = JSON.parse(await readFile(authFile, 'utf8')); } catch {}
}

existing.username = username;
existing.passwordHash = await hashPasswordAsync(password);

await writeFile(authFile, JSON.stringify(existing, null, 2), 'utf8');
console.log(`Password set for user "${username}".`);
