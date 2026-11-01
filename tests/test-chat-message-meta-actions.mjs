#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const cssSource = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const materialFinishSource = readFileSync(join(repoRoot, 'static', 'chat', 'chat-material-finish.css'), 'utf8');
const surfaceSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-surface-ui.js'), 'utf8');
const routerSource = readFileSync(join(repoRoot, 'chat', 'router-session-main-routes.mjs'), 'utf8');
const controlRouterSource = readFileSync(join(repoRoot, 'chat', 'router-control-routes.mjs'), 'utf8');
const managerSource = readFileSync(join(repoRoot, 'chat', 'session-manager.mjs'), 'utf8');

assert.match(uiSource, /function appendMessageMeta\(/, 'message rendering should append a shared metadata/actions row');
assert.match(uiSource, /appendMessageMeta\(div, evt, "assistant", \{\s*live:/, 'assistant messages should mark live metadata while a run is active');
assert.match(uiSource, /function isAssistantMessageLive\(target = null\)/, 'live assistant state should be evaluated for a specific message');
assert.match(uiSource, /const activeRunId = String\(activeRun\.runId \|\| ""\)\.trim\(\)/, 'live assistant state should read the current run id');
assert.match(uiSource, /const targetRunId = String\(target\?\.runId \|\| target\?\.dataset\?\.runId \|\| ""\)\.trim\(\)/, 'live assistant state should read the message run id');
assert.match(uiSource, /return targetRunId === activeRunId;/, 'historical assistant messages should not inherit live state from the session');
assert.match(uiSource, /isAssistantMessageLive\(evt\)/, 'assistant metadata should compare the event to the active run');
assert.match(uiSource, /function finalizeLiveMessageMetadata\(/, 'ui should expose a helper that reveals metadata after a run ends');
assert.match(uiSource, /function attachMessageLongPressMenu\(/, 'mobile user messages should use a long-press action menu');
assert.match(uiSource, /const MESSAGE_LONG_PRESS_DELAY_MS = 360;/, 'long press should fire before native mobile text callouts take over');
assert.match(uiSource, /document\.body\.appendChild\(menu\)/, 'long-press menu should be portaled outside the message bubble');
assert.doesNotMatch(uiSource, /bubble\.appendChild\(menu\)/, 'long-press menu should not become a nested bubble child');
assert.match(uiSource, /function setMessageActionIcon\(/, 'copy feedback should update the shared action icon');
assert.match(uiSource, /function requestMessageFork\(/, 'message actions should support historical forks');
assert.match(uiSource, /mode:\s*role === "user" \? "user-continue" : "assistant-continue"/, 'message forks should copy history without replaying user input');
assert.match(uiSource, /data-event-seq|dataset\.eventSeq/, 'message nodes should retain a stable event boundary for forks');
assert.match(uiSource, /function syncEditableMessageActions\(/, 'ui should recompute which committed user message is editable');
assert.match(uiSource, /nodes\[nodes\.length - 1\]/, 'only the latest committed user message should be marked editable');
assert.match(uiSource, /clearQueuedFollowUpsAfterMessageEdit/, 'editing the latest committed message should cancel later queued follow-ups');
assert.match(uiSource, /bubble\.querySelector\(":scope > \.msg-meta"\)/, 'pending status should anchor before the direct metadata row, not a nested timestamp');
assert.match(uiSource, /bubble\.insertBefore\(status, anchor\)/, 'pending status insertion should only use a direct child anchor');
assert.match(uiSource, /function getAttachmentArtifactFileId\(/, 'message attachments should derive the shared artifact file id');
assert.match(uiSource, /card\.dataset\.artifactFileId = artifactFileId;/, 'attachment cards should expose data-artifact-file-id for projection linking');

assert.match(cssSource, /\.msg-meta\s*\{[\s\S]*position:\s*absolute;[\s\S]*top:\s*100%;[\s\S]*padding-top:\s*4px;[\s\S]*opacity:\s*0;/, 'desktop message metadata should start at the message edge with an internal hover bridge');
assert.match(cssSource, /\.msg-user:hover \.msg-meta,[\s\S]*\.msg-assistant:hover \.msg-meta[\s\S]*opacity:\s*1;[\s\S]*visibility:\s*visible;[\s\S]*pointer-events:\s*auto;/, 'desktop metadata should appear on hover or focus without changing message height');
assert.match(cssSource, /@media \(hover: none\), \(pointer: coarse\), \(max-width: 720px\)[\s\S]*\.msg-timestamp\s*\{[\s\S]*display:\s*none !important;/, 'mobile should hide all timestamps');
assert.match(cssSource, /@media \(hover: none\), \(pointer: coarse\), \(max-width: 720px\)[\s\S]*\.msg-user \.msg-meta,[\s\S]*display:\s*none;/, 'mobile user messages should not show inline metadata');
assert.match(cssSource, /@media \(hover: none\), \(pointer: coarse\), \(max-width: 720px\)[\s\S]*\.msg-assistant \.msg-meta\s*\{[\s\S]*display:\s*flex;/, 'mobile completed assistant messages should show the copy affordance');
assert.match(cssSource, /\.msg-touch-menu\s*\{[\s\S]*position:\s*fixed;[\s\S]*backdrop-filter:\s*blur\(24px\)/, 'long-press menu should use an elevated viewport-anchored surface');
assert.match(cssSource, /\.msg-assistant \.msg-action-btn\s*\{[\s\S]*width:\s*32px;[\s\S]*height:\s*32px;/, 'mobile assistant actions should be compact and borderless');
assert.match(cssSource, /@media \(max-width:\s*767px\)[\s\S]*?\.msg-user-bubble\s*\{[\s\S]*?touch-action:\s*pan-y;[\s\S]*?-webkit-user-select:\s*none;[\s\S]*?-webkit-touch-callout:\s*none;/, 'mobile user bubbles should reserve long press for the custom menu while preserving vertical scroll');
assert.match(materialFinishSource, /\.msg-meta \.msg-action-btn\s*\{[\s\S]*?background:\s*transparent !important;[\s\S]*?box-shadow:\s*none !important;/, 'message action buttons should use the ChatGPT-style borderless transparent surface');
assert.match(materialFinishSource, /\.msg-touch-menu\s*\{[\s\S]*?padding:\s*0 !important;[\s\S]*?overflow:\s*hidden !important;[\s\S]*?border:\s*0 !important;[\s\S]*?border-radius:\s*13px !important;/, 'long-press menu should use the flat borderless OneUI menu container');
assert.match(materialFinishSource, /\.msg-touch-menu \.msg-action-btn \+ \.msg-action-btn\s*\{[\s\S]*?border-top:\s*none !important;/, 'long-press menu rows should remove dividers for seamless integration');
assert.match(materialFinishSource, /\.msg-touch-menu \.msg-action-btn:active\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--text\) 14%, transparent\)/, 'long-press menu rows should deepen background on active');

assert.match(surfaceSource, /action:\s*truncateFrom \? "truncate_from" : "delete"/, 'queued edit should call the truncate_from queue action');
assert.match(surfaceSource, /removeQueuedMessage\(session, item, \{ truncateFrom: true, row \}\)/, 'editing a queued message should remove it and every later queued item');
assert.match(routerSource, /truncateFrom:\s*queueAction === 'truncate_from'/, 'queue route should accept truncate_from');
assert.match(managerSource, /const truncateFrom = options\.truncateFrom === true;/, 'session manager should support truncating queued follow-ups from a request id');
assert.match(managerSource, /export async function forkSessionAt\(/, 'session manager should expose message-anchored historical forks');
assert.match(controlRouterSource, /action === 'fork-at'/, 'control routes should expose the historical fork endpoint');

console.log('test-chat-message-meta-actions: ok');
