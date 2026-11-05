import assert from 'node:assert/strict';
import { createClaudeBidiAdapter } from '../chat/adapters/claude-bidi.mjs';
import { createRunProjectionService } from '../chat/run-projection.mjs';

const command = 'sudo systemctl restart nginx';
const records = ['Bash', 'PowerShell'].map((tool, index) => {
  const request = {
    type: 'control_request', request_id: `approval-${index}`,
    request: { subtype: 'can_use_tool', tool_name: tool, input: { command } },
  };
  return { recordId: `record-${index}`, stream: 'stdout', line: JSON.stringify(request), json: request };
});

const service = createRunProjectionService({
  buildCodexContextMetricsPayload: () => null,
  clipPreview: (value) => String(value),
  createToolInvocation: async () => ({
    provider: 'claude', runtimeFamily: 'claude-stream-json-bidi', capabilities: [],
    adapter: createClaudeBidiAdapter(),
  }),
  materializeRunSpoolLine: async (_runId, record) => record.line,
  normalizeRunEvents: (_run, events) => events,
  readLatestCodexSessionMetrics: async () => null,
  readRunSpoolDelta: async () => ({ records, nextOffset: records.length, processedLineCount: records.length, skippedLineCount: 0 }),
  readRunSpoolRecords: async () => [],
  scanRunSpoolRecords: async () => [],
});

const result = await service.collectNormalizedRunEventDelta(
  { id: 'powershell-approval-run', sessionId: 'powershell-approval-session', runtimeFamily: 'claude-stream-json-bidi' },
  { tool: 'claude-bidi', options: { runtimeFamily: 'claude-stream-json-bidi' } },
);
const approvals = result.normalizedEvents.filter((event) => event.type === 'approval_request');
assert.deepEqual(approvals.map((event) => [event.kind, event.command]), [['command', command], ['command', command]]);
const counters = service.getApprovalSuppressionCounters();
assert.equal(counters.byRiskTier.danger.received, 2, 'both Bash and PowerShell commands must be classified as dangerous');
assert.equal(counters.byRiskTier.danger.presentedToOwner, 2);
console.log('test-run-projection-powershell-approval: ok');
