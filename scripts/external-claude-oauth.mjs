#!/usr/bin/env node

import { runExternalClaudeOAuthCommand } from '../lib/external-claude-oauth-command.mjs';

try {
  process.exitCode = await runExternalClaudeOAuthCommand(process.argv.slice(2));
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
