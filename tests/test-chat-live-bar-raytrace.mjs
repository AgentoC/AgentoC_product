#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ui = readFileSync(join(repoRoot, 'static', 'chat', 'live-status-ui.js'), 'utf8');
const css = readFileSync(join(repoRoot, 'static', 'chat', 'chat-live-status.css'), 'utf8');

assert.doesNotMatch(ui, /LIVE_BAR_ORB_RAYTRACE_SRC|live-bar__orb-raytrace|syncLiveBarOrbRaytrace/, 'the restored globe should not mount the Vault raytrace video');
assert.match(ui, /class:\s*"live-bar__orb-sphere"/);
assert.match(ui, /orbSvg\.append\(defs, backRing, sphere, frontRing\)/, 'the restored orb should paint the globe between the ring layers');
assert.doesNotMatch(css, /live-bar__orb-raytrace/, 'the restored globe should not reserve a video layer');
assert.match(css, /\.live-bar__orb-svg\s*\{[\s\S]*?display: block;/, 'the restored globe SVG should remain visible in the running state');

console.log('test-chat-live-bar-raytrace: ok (legacy raytrace retired)');
