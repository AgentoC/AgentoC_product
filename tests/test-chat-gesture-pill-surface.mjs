#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const messagesCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');

assert.doesNotMatch(messagesCss, /\.gesture-pill\b/, 'gesture pill surface should be removed when gesture labels are no longer shown');

console.log('test-chat-gesture-pill-surface: ok (removed)');
