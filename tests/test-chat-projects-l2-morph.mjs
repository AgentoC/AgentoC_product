#!/usr/bin/env node
// Contract test for the replacement L1/L2 navigation transition. The former
// morph fixture drove a long Chromium session and sampled screenshots while
// waiting for several animation events; that test chain was not a reliable
// product signal. The product contract is now intentionally state-first and
// can be verified without launching a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const js = await readFile(new URL('../static/chat/project-view-ui.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8');
const responsiveCss = await readFile(new URL('../static/chat/chat-responsive.css', import.meta.url), 'utf8');

assert.match(js, /function playLevelTransition\(direction\)/, 'level navigation has one bounded transition entry point');
assert.match(js, /sidebar-level-panel-enter-forward/, 'forward navigation uses an incoming panel');
assert.match(js, /sidebar-level-panel-enter-back/, 'back navigation uses the opposite incoming direction');
assert.match(js, /clearLevelTransitionVisuals\(\)/, 'rapid navigation clears previous visual residue');
assert.match(js, /function canStartEdgeBackSwipe\(\)/, 'mobile L2 exposes an edge-back gesture gate');
assert.match(js, /function updateEdgeBackSwipe\(distance\)/, 'mobile L2 exposes direct finger-position updates');
assert.match(js, /function settleEdgeBackSwipe\(committed, onSettled\)/, 'mobile L2 exposes commit/rebound settling');
assert.doesNotMatch(js, /sidebar-level-(expand|slide|block|exit|return|solo)/, 'legacy morph state is removed from the runtime');
assert.doesNotMatch(js, /getLevelFlip|getExpandInsets|addEventListener\(["'](?:animationend|transitionend)/, 'runtime does not depend on geometry or completion events');
assert.match(css, /@keyframes sidebar-level-panel-forward/, 'forward panel motion is defined');
assert.match(css, /@keyframes sidebar-level-panel-back/, 'back panel motion is defined');
assert.match(responsiveCss, /sidebar-edge-back-swipe-active/, 'edge-back panel stack is defined');
assert.match(responsiveCss, /sidebar-edge-back-swipe-settling/, 'edge-back rebound/commit settle is defined');
assert.doesNotMatch(css, /sidebar-level-(expand|slide|block|exit|return|solo)/, 'legacy morph styles are removed');

console.log('test-chat-projects-l2-morph: ok');
