#!/usr/bin/env node
// Web-stability regression: the Workbench Inspector must NOT keep background-
// fetching session events while closed (the closed-component amplifier that
// drove one session to ~513 repeated /events?filter=all fetches / ~197MB and
// starved the event loop). When the inspector closes it must clear its fetch
// timer; it may only fetch when open.
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

const src = await readFile(new URL('../static/chat/workbench-inspector.js', import.meta.url), 'utf8');

assert.match(src, /function clearScheduledRefresh/, 'Inspector must expose a fetch-timer clearer');
assert.match(src, /function isInspectorOpen/, 'Inspector must track its open state');

// The close branch of setOpen must clear the scheduled fetch so a closed
// inspector stops polling for raw events.
assert.match(
  src,
  /else\s*\{\s*clearScheduledRefresh\(\)/,
  'Closing the Inspector must clear its fetch timer (no background event fetch while closed)',
);

console.log('test-chat-workbench-inspector-closed-fetch: ok');
