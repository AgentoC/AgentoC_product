#!/usr/bin/env node

import { runExternalCodexOAuthCommand } from '../lib/external-codex-oauth-command.mjs';

try {
  process.exitCode = await runExternalCodexOAuthCommand(process.argv.slice(2));
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
