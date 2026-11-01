#!/usr/bin/env node
// High-risk batch assertions must use the RP ID and origin of the owner
// browser that requested them, rather than the server's 127.0.0.1 default.
import assert from 'assert/strict';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sessionManager = await readFile(join(repoRoot, 'chat', 'session-manager.mjs'), 'utf8');
const routes = await readFile(join(repoRoot, 'chat', 'router-session-main-routes.mjs'), 'utf8');

const creatorStart = sessionManager.indexOf('export async function createPrivilegedCategoryWebAuthnChallenge');
assert.ok(creatorStart >= 0, 'privileged category WebAuthn challenge creator exists');
const creatorSource = sessionManager.slice(creatorStart, sessionManager.indexOf('\n}\n', creatorStart) + 3);
assert.match(
  creatorSource,
  /createOwnerWebAuthnAssertionOptions\(options\.request \|\| \{\}/,
  'privileged challenge forwards its originating HTTP request to WebAuthn options',
);

const routeStart = routes.indexOf("parts[7] === 'webauthn-challenge' && runId");
assert.ok(routeStart >= 0, 'privileged category WebAuthn challenge route exists');
const routeSource = routes.slice(routeStart, routes.indexOf('\n    }\n', routeStart) + 7);
assert.match(
  routeSource,
  /createPrivilegedCategoryWebAuthnChallenge\([\s\S]*?request:\s*req/,
  'privileged challenge route forwards the owner browser request',
);

console.log('privileged-webauthn-request-context: ok');
