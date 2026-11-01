#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const uiSource = readFileSync(join(repoRoot, 'static/chat/ui.js'), 'utf8');
const messagesCss = readFileSync(join(repoRoot, 'static/chat/chat-messages.css'), 'utf8');

assert.match(uiSource, /const dots = document\.createElement\("span"\)/, 'the activity line should create a dot group');
assert.match(uiSource, /dots\.className = "mobile-live-activity-line__dots"/, 'the activity line should use the legacy dot-group marker');
assert.match(uiSource, /for \(let index = 0; index < 3; index \+= 1\)/, 'the activity line should render exactly three dots');
assert.match(uiSource, /dot\.className = "mobile-live-activity-line__dot"/, 'each activity dot should use the shared dot class');
assert.doesNotMatch(uiSource, /mobile-live-activity-line__track/, 'the activity line should no longer use the execution track');
assert.doesNotMatch(uiSource, /mobile-live-activity-line__tool-icon/, 'the activity line should no longer swap tool icons into the marker');
assert.match(messagesCss, /@property --mobile-live-dot-axis-offset/, 'the dot motion should animate a registered distance property');
assert.match(messagesCss, /@keyframes mobile-live-dot-sequence-a/, 'the first dot should have a staged sequence');
assert.match(messagesCss, /@keyframes mobile-live-dot-sequence-b/, 'the second dot should have a staged sequence');
assert.match(messagesCss, /@keyframes mobile-live-dot-sequence-c/, 'the third dot should have a staged sequence');
assert.match(messagesCss, /animation: mobile-live-dots-rotate 7\.2s linear infinite/, 'the dot group should rotate at the legacy cadence');
assert.match(messagesCss, /\.mobile-live-activity-line__dot:nth-child\(1\)[\s\S]*?animation-name: mobile-live-dot-sequence-a/, 'the first dot should use sequence A');
assert.match(messagesCss, /\.mobile-live-activity-line__dot:nth-child\(2\)[\s\S]*?animation-name: mobile-live-dot-sequence-b/, 'the second dot should use sequence B');
assert.match(messagesCss, /\.mobile-live-activity-line__dot:nth-child\(3\)[\s\S]*?animation-name: mobile-live-dot-sequence-c/, 'the third dot should use sequence C');
assert.doesNotMatch(messagesCss, /mobile-live-execution-travel|mobile-live-execution-breathe/, 'the execution track motion should be retired');

console.log('test-chat-mobile-live-dots: ok');
