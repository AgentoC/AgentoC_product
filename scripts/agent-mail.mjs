#!/usr/bin/env node

import { runAgentMailCommand } from '../lib/agent-mail-command.mjs';

runAgentMailCommand(process.argv.slice(2)).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
