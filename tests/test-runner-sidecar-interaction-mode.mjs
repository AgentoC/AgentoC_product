#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const source = await readFile(join(repoRoot, 'chat', 'runner-sidecar.mjs'), 'utf8');

assert.match(
  source,
  /interactionMode:\s*manifest\.options\?\.interactionMode/,
  'runner sidecar should propagate manifest interactionMode into runtime invocation',
);
assert.match(
  source,
  /codexResume:\s*manifest\.options\?\.codexResume\s*===\s*true/,
  'runner sidecar should propagate explicit Codex resume into runtime invocation',
);
assert.match(
  source,
  /developerInstructions:\s*manifest\.developerInstructions/,
  'runner sidecar should propagate renderer developer instructions into runtime invocation',
);
assert.match(
  source,
  /systemPrefix:\s*manifest\.systemPrefix/,
  'runner sidecar should propagate renderer system prefixes into runtime invocation',
);
assert.match(
  source,
  /developerInstructions:\s*state\.developerInstructions/,
  'runner sidecar should pass renderer developer instructions into Codex app-server thread setup',
);
assert.match(
  source,
  /buildCodexAppServerTurnSteerMessage/,
  'runner sidecar should support Codex app-server turn steering',
);
assert.match(
  source,
  /buildCodexAppServerTurnInterruptMessage/,
  'runner sidecar should support Codex app-server turn interruption',
);

console.log('test-runner-sidecar-interaction-mode: ok');
