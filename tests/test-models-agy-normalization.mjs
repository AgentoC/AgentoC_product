#!/usr/bin/env node
import assert from 'node:assert/strict';
import { AGY_EFFORT_LEVELS, normalizeAgyModelCatalog } from '../lib/agy-manager.mjs';

const catalog = normalizeAgyModelCatalog([
  { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
  { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
  { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
]);

assert.deepEqual(catalog, [
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    reasoning: {
      kind: 'enum',
      label: 'Thinking',
      levels: ['low', 'medium', 'high'],
      default: 'medium',
    },
  },
  {
    id: 'claude-opus-4-6-thinking',
    label: 'Claude Opus 4.6 (Thinking)',
    reasoning: { kind: 'none', label: 'Thinking' },
  },
  {
    id: 'gpt-oss-120b-medium',
    label: 'GPT-OSS 120B (Medium)',
    reasoning: { kind: 'none', label: 'Thinking' },
  },
]);
assert.deepEqual([...AGY_EFFORT_LEVELS], ['low', 'medium', 'high']);
assert.equal(catalog[0].reasoning.kind, 'enum');
assert.equal(catalog[1].reasoning.kind, 'none');
assert.equal(catalog[2].reasoning.kind, 'none');

console.log('test-models-agy-normalization: ok');
