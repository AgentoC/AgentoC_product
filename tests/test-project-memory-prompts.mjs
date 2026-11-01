#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  parseProjectMemoryConsolidation,
  parseProjectMemoryExtraction,
  renderProjectMemoryMarkdown,
} from '../chat/project-memory-prompts.mjs';

const extracted = parseProjectMemoryExtraction(`
<hide>{
  "sessionSummary":"Implemented workspace binding.",
  "taskStatus":"completed",
  "candidates":[
    {"kind":"decision","statement":"Use workspace B.","confidence":"verified","sourceEventStart":4,"sourceEventEnd":8},
    {"kind":"decision","statement":"Use workspace B.","confidence":"verified","sourceEventStart":4,"sourceEventEnd":8}
  ]
}</hide>`);
assert.equal(extracted.candidates.length, 1, 'duplicate candidate statements are collapsed');
assert.equal(extracted.candidates[0].sourceEventStart, 4);

const curated = parseProjectMemoryConsolidation(`
<hide>{
  "sections": {
    "Important Decisions": [{"text":"Workspace B is the current execution root.","candidateIds":["candidate-b"],"state":"active"}],
    "Known Problems": [{"text":"Older workspace A references are obsolete.","candidateIds":["candidate-a"],"state":"superseded"}]
  },
  "summary":"Use workspace B; older workspace A references are obsolete.",
  "resolutions":[
    {"candidateId":"candidate-a","state":"superseded"},
    {"candidateId":"candidate-b","state":"active"},
    {"candidateId":"invented","state":"active"}
  ]
}</hide>`, { candidateIds: ['candidate-a', 'candidate-b'] });
assert.match(curated.summary, /^v1\n/);
assert.equal(curated.resolutions.length, 2, 'invented candidate IDs are rejected');
const markdown = renderProjectMemoryMarkdown(curated.sections);
assert.match(markdown, /## Important Decisions/);
assert.doesNotMatch(markdown, /invented/);
assert.doesNotMatch(markdown, /Older workspace A references are obsolete/);

const contestedMarkdown = renderProjectMemoryMarkdown({
  'Current State': [
    { text: 'Workspace location is contested.', state: 'contested' },
    { text: 'Invalidated location.', state: 'invalidated' },
  ],
});
assert.match(contestedMarkdown, /\[Contested\] Workspace location is contested/);
assert.doesNotMatch(contestedMarkdown, /Invalidated location/);

assert.throws(
  () => parseProjectMemoryConsolidation('<hide>{"sections":{},"summary":""}</hide>', { candidateIds: [] }),
  /empty summary/,
);
assert.throws(() => parseProjectMemoryExtraction('not json'), /invalid JSON/);

console.log('test-project-memory-prompts: ok');
