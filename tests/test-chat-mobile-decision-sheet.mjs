#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const responsiveCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-responsive.css'), 'utf8');
const messagesCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

// (2026-08-04) The in-stream approval card is removed; the Decision Sheet owns
// mobile approvals. These assertions now cover the plan card only.
assert.match(
  responsiveCss,
  /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.plan-card\s*\{[\s\S]*?border-radius:\s*var\(--radius-sheet-top,\s*24px\)\s*var\(--radius-sheet-top,\s*24px\)\s*18px\s*18px;[\s\S]*?box-shadow:\s*var\(--sheet-shadow,/,
  'mobile plan cards should use the shared sheet radius and shadow',
);

assert.match(
  responsiveCss,
  /\.plan-card__actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?-webkit-backdrop-filter:\s*blur\(14px\)\s*saturate\(130%\);[\s\S]*?backdrop-filter:\s*blur\(14px\)\s*saturate\(130%\);/,
  'mobile plan actions should remain a single readable frosted action rail',
);

assert.match(
  responsiveCss,
  /\.plan-card__action\s*\{[\s\S]*?min-height:\s*52px;[\s\S]*?background:\s*var\(--surface-soft,\s*var\(--bg-secondary\)\);/,
  'mobile plan buttons should keep readable decision touch targets and soft surfaces',
);

assert.match(
  messagesCss,
  /\.runtime-approval-card__prompt\s*\{[\s\S]*?background:\s*var\(--surface-soft,\s*var\(--bg-secondary\)\);/,
  'ask-user prompt blocks should use neutral soft surfaces',
);

assert.match(
  messagesCss,
  /\.runtime-approval-card__option\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*var\(--surface-raised,\s*var\(--bg\)\);/,
  'ask-user options should render as raised soft rows without hard outlines',
);

assert.match(
  uiSource,
  /function getApprovalPromptSections\(evt\)\s*\{[\s\S]*?Array\.isArray\(evt\?\.questions\)[\s\S]*?evt\?\.options\s*\|\|\s*evt\?\.choices/,
  'approval rendering should support questions plus top-level options or choices',
);

assert.match(
  uiSource,
  /function createPlanProposalAction\(labelKey,\s*handler,\s*planAction\s*=\s*""\)[\s\S]*?button\.dataset\.planAction\s*=\s*normalizedPlanAction;/,
  'plan action buttons should expose data-plan-action for mobile primary styling',
);

console.log('test-chat-mobile-decision-sheet: ok');
