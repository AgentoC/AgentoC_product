#!/usr/bin/env node
import assert from 'assert/strict';

import { analyzeClaudeOutput } from '../scripts/ce11-claude-transport-probe.mjs';

const valid = [
  { type: 'system', subtype: 'init', session_id: 'transport-test' },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CLAUDE_TRANSPORT_OK' } } },
  { type: 'assistant', message: { id: 'msg-final', content: [{ type: 'text', text: 'CLAUDE_TRANSPORT_OK' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'CLAUDE_TRANSPORT_OK', usage: { input_tokens: 2, output_tokens: 1 } },
].map((frame) => JSON.stringify(frame)).join('\n');
const validAnalysis = analyzeClaudeOutput(valid);
assert.equal(validAnalysis.pass, true);
assert.equal(validAnalysis.errorTypes.length, 0);
assert.equal(validAnalysis.resultFrameCount, 1);
assert.equal(validAnalysis.duplicateAssistantCount, 0);
assert.equal(validAnalysis.parseErrors.length, 0);
assert.equal(validAnalysis.exactReply, true);

const emptyResult = analyzeClaudeOutput(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
}));
assert.equal(emptyResult.pass, false);
assert.deepEqual(emptyResult.errorTypes, ['provider_response_invalid']);
assert.equal(emptyResult.terminalStatusKinds[0], 'error');

const apiError = analyzeClaudeOutput(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  terminal_reason: 'api_error',
  result: 'API Error: 402 Insufficient Balance',
}));
assert.equal(apiError.pass, false);
assert.equal(apiError.terminalReasons[0], 'api_error');
assert.equal(apiError.errorTypes[0], 'provider_error');

const malformedJson = analyzeClaudeOutput('not json\n' + valid);
assert.equal(malformedJson.pass, false);
assert.equal(malformedJson.parseErrors.length, 1);
assert.equal(malformedJson.resultFrameCount, 1);

console.log('test-ce11-claude-transport: ok');
