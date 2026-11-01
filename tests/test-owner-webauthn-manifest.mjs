#!/usr/bin/env node
// P2 (design §5.6): the WebAuthn challenge binds exactly one per-popup signed
// subset (computeBatchManifestHash). This test covers the challenge→proof
// manifestHash round-trip and proof consumption with/without a hash.
import assert from 'assert/strict';
import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { CONFIG_DIR } from '../lib/config.mjs';
import {
  createOwnerWebAuthnAssertionOptions,
  consumeOwnerWebAuthnProof,
} from '../lib/owner-webauthn.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}

const CREDENTIAL_ID = 'cred_manifest_test';
const MANIFEST_HASH = 'hash-' + 'a'.repeat(60);

// A registered credential must exist before assertion options can be issued.
const stateFile = join(CONFIG_DIR, 'owner-webauthn.json');
await mkdir(dirname(stateFile), { recursive: true });
await writeFile(stateFile, JSON.stringify({
  credentials: [{
    id: CREDENTIAL_ID,
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'fake-for-assertion-options-only' },
    signCount: 0,
    transports: ['internal'],
  }],
}, null, 2));

// --- challenge records the bound manifestHash ---
{
  const options = await createOwnerWebAuthnAssertionOptions({}, {
    purpose: 'privileged-batch',
    sessionId: 'sess_p2',
    requestId: 'req_p2',
    manifestHash: MANIFEST_HASH,
  });
  check('assertion options issued', options?.publicKey?.challenge?.length > 0);
  check('assertion options allowCredentials', Array.isArray(options.publicKey.allowCredentials)
    && options.publicKey.allowCredentials.length === 1
    && options.publicKey.allowCredentials[0].id === CREDENTIAL_ID);
  const challenge = options.publicKey.challenge;
  const challengeFile = join(CONFIG_DIR, 'owner-webauthn-challenges',
    `${createHash('sha256').update(challenge).digest('hex')}.json`);
  const { readFile } = await import('fs/promises');
  const record = JSON.parse(await readFile(challengeFile, 'utf8'));
  check('challenge record type assertion', record.type === 'assertion');
  check('challenge record manifestHash bound', record.manifestHash === MANIFEST_HASH);
  check('challenge record purpose', record.purpose === 'privileged-batch');
  check('challenge record 0600', (await (await import('fs/promises')).stat(challengeFile)).mode % 0o1000 === 0o600);
  check('challenge record owner', (await (await import('fs/promises')).stat(challengeFile)).uid === process.getuid());
}

// --- challenge without manifestHash stays hash-free (backward compat) ---
{
  const options = await createOwnerWebAuthnAssertionOptions({}, {
    purpose: 'legacy-assertion',
    sessionId: 'sess_legacy',
    requestId: 'req_legacy',
  });
  const challenge = options.publicKey.challenge;
  const challengeFile = join(CONFIG_DIR, 'owner-webauthn-challenges',
    `${createHash('sha256').update(challenge).digest('hex')}.json`);
  const { readFile } = await import('fs/promises');
  const record = JSON.parse(await readFile(challengeFile, 'utf8'));
  check('hash-free challenge has no manifestHash field', !('manifestHash' in record));
}

// --- proof consumption: matching hash accepted, mismatching rejected ---
{
  const proofDir = join(CONFIG_DIR, 'owner-webauthn-proofs');
  const token = 'proof_token_manifest_test';
  const proofFile = join(proofDir, `${createHash('sha256').update(token).digest('hex')}.json`);
  await mkdir(proofDir, { recursive: true });
  await writeFile(proofFile, JSON.stringify({
    token,
    purpose: 'privileged-batch',
    sessionId: 'sess_p2',
    requestId: 'req_p2',
    credentialId: CREDENTIAL_ID,
    manifestHash: MANIFEST_HASH,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }, null, 2));

  const ok = await consumeOwnerWebAuthnProof({
    token,
    purpose: 'privileged-batch',
    sessionId: 'sess_p2',
    requestId: 'req_p2',
    manifestHash: MANIFEST_HASH,
  });
  check('proof consumed with matching manifestHash', ok === true);
}

{
  const proofDir = join(CONFIG_DIR, 'owner-webauthn-proofs');
  const token = 'proof_token_mismatch';
  const proofFile = join(proofDir, `${createHash('sha256').update(token).digest('hex')}.json`);
  await writeFile(proofFile, JSON.stringify({
    token,
    purpose: 'privileged-batch',
    sessionId: 'sess_p2',
    requestId: 'req_p2',
    credentialId: CREDENTIAL_ID,
    manifestHash: MANIFEST_HASH,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, null, 2));

  const bad = await consumeOwnerWebAuthnProof({
    token,
    purpose: 'privileged-batch',
    sessionId: 'sess_p2',
    requestId: 'req_p2',
    manifestHash: 'hash-' + 'b'.repeat(60),
  });
  check('proof rejected on manifestHash mismatch', bad === false);

  // token is consumed (unlinked) even on mismatch — replay impossible
  const { readFile } = await import('fs/promises');
  const replayed = await readFile(proofFile, 'utf8').catch(() => null);
  check('mismatched proof consumed (no replay)', replayed === null);
}

// --- proof without manifestHash: consumption without hash stays compatible ---
{
  const proofDir = join(CONFIG_DIR, 'owner-webauthn-proofs');
  const token = 'proof_token_legacy';
  const proofFile = join(proofDir, `${createHash('sha256').update(token).digest('hex')}.json`);
  await writeFile(proofFile, JSON.stringify({
    token,
    purpose: 'legacy-assertion',
    sessionId: 'sess_legacy',
    requestId: 'req_legacy',
    credentialId: CREDENTIAL_ID,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, null, 2));

  const legacy = await consumeOwnerWebAuthnProof({
    token,
    purpose: 'legacy-assertion',
    sessionId: 'sess_legacy',
    requestId: 'req_legacy',
  });
  check('legacy proof consumed without manifestHash', legacy === true);
}

console.log(`owner-webauthn-manifest: ${passed} checks passed`);
