#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { listCodexAppServerModels } from '../chat/codex-app-server-client.mjs';

// Operator-owned service startup only. Uses the normal managed command and
// provider-scoped broker lock; never materializes or logs an OAuth credential.
const home = process.argv[2];
try {
  if (process.argv.length !== 3 || !/^\/state\/provider-homes\/by-provider\/[a-f0-9]{32}\/codex$/.test(home || '')) {
    throw new Error('invalid review provider home');
  }
  if (await realpath(home) !== home) throw new Error('unexpected provider path');
  const models = await listCodexAppServerModels({ codexHomeDir: home, cwd: '/app', timeoutMs: 20_000 });
  if (!Array.isArray(models) || !models.some(model => model.id === 'gpt-5.6-luna')) {
    throw new Error('review model unavailable');
  }
  console.log(JSON.stringify({ event: 'review_provider_broker_ready', model: 'gpt-5.6-luna' }));
} catch {
  console.error('review_provider_warmup_failed');
  process.exitCode = 1;
}
