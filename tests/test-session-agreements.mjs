#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildSessionAgreementsPromptBlock,
  normalizeSessionAgreements,
} from '../chat/session-agreements.mjs';

const normalized = normalizeSessionAgreements([
  '  默认用自然段表达  ',
  '',
  '默认用自然段表达',
  'Agent 更像执行器，Manager 负责统一任务语义和边界。',
]);

assert.deepEqual(
  normalized,
  [
    '默认用自然段表达',
    'Agent 更像执行器，Manager 负责统一任务语义和边界。',
  ],
  'agreement normalization should trim, drop empties, and dedupe',
);

const block = buildSessionAgreementsPromptBlock(normalized);
assert.match(block, /active working agreements/);
assert.match(block, /默认用自然段表达/);
assert.match(block, /Agent 更像执行器/);

assert.equal(buildSessionAgreementsPromptBlock([]), '', 'empty agreement sets should not emit a prompt block');

console.log('test-session-agreements: ok');
