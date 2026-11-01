#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function secretKinds(text) {
  const kinds = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]{24,16384}?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)) kinds.push('private-key');
  if (/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/.test(text)) kinds.push('provider-secret');
  if (/"client_secret"\s*:\s*"[A-Za-z0-9_-]{24,}"/.test(text)) kinds.push('oauth-client-secret');
  return kinds;
}
function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export async function scanRuntimePayload(root) {
  root = await realpath(resolve(root));
  const findings = [];
  let files = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      const facts = await lstat(path);
      if (facts.isSymbolicLink()) {
        // npm .bin links are valid only inside this exact final payload.
        try { if (!within(root, await realpath(path))) findings.push({ path: name, kind: 'escaping-symlink' }); }
        catch { findings.push({ path: name, kind: 'broken-symlink' }); }
        continue;
      }
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!facts.isFile()) { findings.push({ path: name, kind: 'non-regular-file' }); continue; }
      files += 1;
      if (/(^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|auth\.json|auth-sessions\.json|trusted-devices\.json|turn-connection-leases\.json|[^/]*firebase-adminsdk[^/]*\.json|[^/]+\.(?:p12|pfx|jks|keystore))$/i.test(name)) {
        findings.push({ path: name, kind: 'credential-or-runtime-state-file' });
      }
      // Stream binaries as well: embedded text in an executable/archive is not
      // exempt. Nested compressed archives still require extracted-artifact QA.
      let overlap = '';
      const found = new Set();
      for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
        const text = overlap + chunk;
        for (const kind of secretKinds(text)) found.add(kind);
        overlap = text.slice(-32768);
      }
      for (const kind of found) findings.push({ path: name, kind });
    }
  };
  await walk(root);
  return { ok: findings.length === 0, files, findings };
}
async function main() {
  const [root, ...extra] = process.argv.slice(2);
  if (!root || extra.length) throw new Error('Usage: verify-runtime-payload.mjs <extracted-payload-directory>');
  const result = await scanRuntimePayload(root);
  // Never print matching values or excerpts, including on failure.
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
