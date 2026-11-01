#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const composerStoreSource = readFileSync(join(repoRoot, 'static', 'chat', 'composer-store.js'), 'utf8');
const composeSource = readFileSync(join(repoRoot, 'static', 'chat', 'compose.js'), 'utf8');
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const cssSource = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const i18nSource = readFileSync(join(repoRoot, 'static', 'chat', 'i18n.js'), 'utf8');

assert.match(
  composerStoreSource,
  /rawPendingSend\.stage === "checking"/,
  'composer store should preserve the checking stage instead of collapsing it back to sending',
);

assert.match(
  composerStoreSource,
  /pendingSend\.stage !== "processing" && pendingSend\.stage !== "checking"/,
  'composer store should treat checking as non-blocking composer state',
);

assert.match(
  composeSource,
  /function syncComposerSendButtonPendingState\(/,
  'composer flow should expose a send-button pending state helper',
);

assert.doesNotMatch(
  composeSource,
  /classList\.toggle\("is-sending"/,
  'composer flow should not show a spinner state on the send button while sending',
);

assert.match(
  composeSource,
  /function syncComposerSendAvailability\(/,
  'composer flow should expose a send-button availability sync (grey when empty)',
);

assert.doesNotMatch(
  composeSource,
  /classList\.toggle\("is-pending-send"/,
  'composer flow should not surface pending-send state on the input area',
);

assert.doesNotMatch(
  composeSource,
  /const shouldShowComposerPending = pendingForCurrentSession/,
  'composer footer should no longer render transport-stage sending copy',
);

assert.match(
  composeSource,
  /typeof syncComposerPendingTurnFeedback === "function"/,
  'composer flow should sync inline pending-turn feedback in the message stream',
);

assert.match(
  uiSource,
  /function syncComposerPendingTurnFeedback\(/,
  'ui should expose a pending-turn sync helper',
);

assert.match(
  uiSource,
  /function insertComposerLocalEcho\(/,
  'ui should expose an optimistic local-echo creation path for send feedback',
);

assert.match(
  uiSource,
  /localEcho:\s*true/,
  'ui should create an optimistic local echo bubble at send time (user-approved reversal of the pre-echo contract)',
);

assert.doesNotMatch(
  uiSource,
  /setUserMessageStatus\(localEchoNode/,
  'pending-turn sync should not attach inline status text to the uncommitted echo (user preference)',
);

assert.match(
  uiSource,
  /getSessionTaskFlowStage/,
  'ui should use the shared task-flow resolver for message-level pending state',
);

assert.match(
  cssSource,
  /\.msg-user-status\s*\{/,
  'chat message styles should include an inline user-turn status row',
);

assert.doesNotMatch(
  cssSource,
  /\.msg-user-local-echo \.msg-user-bubble\s*\{[\s\S]*?border-style:\s*dashed;/,
  'local echo user bubbles should not use a dashed just-sent treatment',
);

assert.doesNotMatch(
  cssSource,
  /\.msg-user-bubble\.msg-pending\s*\{[\s\S]*?opacity:/,
  'pending user bubbles should keep ordinary opacity',
);

assert.match(
  i18nSource,
  /"compose\.inline\.checking": "Sent, confirming route…"/,
  'english i18n should include concrete inline checking copy',
);

assert.match(
  i18nSource,
  /"compose\.inline\.checking": "已发送，正在确认处理方式…"/,
  'chinese i18n should include concrete inline checking copy',
);

assert.match(
  i18nSource,
  /"taskFlow\.checkingSlow": "仍在确认处理方式，超时后会自动继续当前会话。"/,
  'chinese i18n should explain prolonged routing checks without blocking the composer',
);

console.log('test-chat-pending-turn-feedback: ok');
