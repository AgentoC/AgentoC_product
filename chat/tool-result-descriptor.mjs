import { createHash } from 'node:crypto';

export const TOOL_RESULT_DESCRIPTOR_SCHEMA_VERSION = 1;
export const DEFAULT_TOOL_RESULT_PREVIEW_CHARS = 2400;
export const DEFAULT_TOOL_RESULT_RANGE_MAX_BYTES = 64 * 1024;

function text(value, maxChars = 1200) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function positiveInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value || '', 'utf8').digest('hex')}`;
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : '', 'utf8');
}

function previewHeadTail(value, maxChars) {
  const normalized = typeof value === 'string' ? value : '';
  if (!normalized || normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  const marker = '\n[... tool output preview truncated ...]\n';
  if (maxChars <= marker.length + 2) {
    return { text: `${normalized.slice(0, Math.max(0, maxChars - 3))}...`, truncated: true };
  }
  const remaining = maxChars - marker.length;
  const head = Math.max(1, Math.floor(remaining * 0.6));
  const tail = Math.max(1, remaining - head);
  return {
    text: `${normalized.slice(0, head).trimEnd()}${marker}${normalized.slice(-tail).trimStart()}`,
    truncated: true,
  };
}

function sourceRefs(event) {
  const ref = {};
  if (positiveInt(event?.seq) !== null && event.seq > 0) ref.seq = event.seq;
  if (text(event?.runId, 180)) ref.runId = text(event.runId, 180);
  if (text(event?.id, 180)) ref.eventId = text(event.id, 180);
  if (text(event?.toolExecutionId || event?.toolCallId, 180)) {
    ref.toolExecutionId = text(event.toolExecutionId || event.toolCallId, 180);
  }
  return Object.keys(ref).length > 0 ? [ref] : [];
}

function normalizeRawOutputRef(event, options) {
  const supplied = event?.rawOutputRef && typeof event.rawOutputRef === 'object'
    ? event.rawOutputRef
    : null;
  const ref = text(supplied?.ref || event?.bodyRef || event?.runSpoolRef || event?.outputRef, 500);
  if (!ref) return null;
  const kind = text(supplied?.kind, 80)
    || (event?.bodyRef ? 'history_body' : event?.runSpoolRef ? 'run_spool' : 'asset');
  return {
    kind,
    ref,
    ...(text(options?.sessionId || supplied?.sessionId, 240)
      ? { sessionId: text(options?.sessionId || supplied.sessionId, 240) }
      : {}),
    ...(positiveInt(event?.seq) !== null ? { seq: event.seq } : {}),
    ...(text(supplied?.sha256 || event?.bodySha256 || event?.outputSha256 || event?.sha256, 120)
      ? { sha256: text(supplied?.sha256 || event?.bodySha256 || event?.outputSha256 || event?.sha256, 120) }
      : {}),
    ...(positiveInt(supplied?.bytes) !== null ? { bytes: supplied.bytes } : {}),
  };
}

function normalizeOutcome(event, output) {
  const state = text(event?.outcome || event?.status, 80).toLowerCase();
  if (['succeeded', 'success', 'passed', 'completed'].includes(state)) return 'succeeded';
  if (['failed', 'failure', 'error'].includes(state)) return 'failed';
  if (['cancelled', 'canceled', 'aborted'].includes(state)) return 'cancelled';
  if (Number.isInteger(event?.exitCode)) return event.exitCode === 0 ? 'succeeded' : 'failed';
  if (/\b(error|failed|failure|exception)\b/i.test(output)) return 'failed';
  return 'unknown';
}

function normalizeRanges(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 32)
    .map((range) => {
      const startByte = positiveInt(range?.startByte);
      const endByte = positiveInt(range?.endByte);
      if (startByte === null || endByte === null || endByte <= startByte) return null;
      return {
        startByte,
        endByte,
        ...(text(range?.label, 180) ? { label: text(range.label, 180) } : {}),
        ...(text(range?.source, 80) ? { source: text(range.source, 80) } : {}),
      };
    })
    .filter(Boolean);
}

function normalizeArtifacts(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 32)
    .map((artifact) => {
      const assetId = text(artifact?.assetId || artifact?.id, 200);
      if (!assetId) return null;
      return {
        assetId,
        ...(text(artifact?.name || artifact?.originalName, 300)
          ? { name: text(artifact.name || artifact.originalName, 300) }
          : {}),
        ...(text(artifact?.mimeType, 160) ? { mimeType: text(artifact.mimeType, 160) } : {}),
      };
    })
    .filter(Boolean);
}

export function createToolResultDescriptor(event, options = {}) {
  if (!event || typeof event !== 'object' || event.type !== 'tool_result') return null;
  const output = typeof event.output === 'string'
    ? event.output
    : (typeof event.bodyPreview === 'string' ? event.bodyPreview : '');
  const configuredPreviewChars = Number.isInteger(options.previewChars) && options.previewChars > 0
    ? options.previewChars
    : DEFAULT_TOOL_RESULT_PREVIEW_CHARS;
  const preview = previewHeadTail(output, configuredPreviewChars);
  const rawOutputRef = normalizeRawOutputRef(event, options);
  const outputBytes = positiveInt(event.bodyBytes)
    ?? (!rawOutputRef ? byteLength(output) : 0);
  const suppliedSha256 = text(
    event.outputSha256 || event.bodySha256 || event.sha256 || rawOutputRef?.sha256,
    120,
  );
  const outputSha256 = suppliedSha256 || (!rawOutputRef && output ? digest(output) : '');
  const toolExecutionId = text(
    event.toolExecutionId || event.toolCallId || event.callId || event.id,
    200,
  );
  if (!toolExecutionId) return null;
  const command = text(event.command || event.commandRef || event.toolInput, 4000);
  const commandDigest = text(event.commandDigest, 120) || (command ? digest(command) : '');
  return {
    schemaVersion: TOOL_RESULT_DESCRIPTOR_SCHEMA_VERSION,
    toolExecutionId,
    toolName: text(event.toolName || event.name, 240) || 'unknown',
    ...(commandDigest ? { commandDigest } : {}),
    ...(text(event.startedAt || event.startTime, 80) ? { startedAt: text(event.startedAt || event.startTime, 80) } : {}),
    ...(text(event.completedAt || event.endTime || event.timestamp, 80)
      ? { completedAt: text(event.completedAt || event.endTime || event.timestamp, 80) }
      : {}),
    outcome: normalizeOutcome(event, output),
    ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}),
    ...(rawOutputRef
      ? {
          rawOutputRef: {
            ...rawOutputRef,
            ...(outputSha256 && !rawOutputRef.sha256 ? { sha256: outputSha256 } : {}),
            ...(outputBytes > 0 && rawOutputRef.bytes === undefined ? { bytes: outputBytes } : {}),
          },
        }
      : {}),
    preview: {
      strategy: text(event.previewStrategy, 80) || 'head_tail',
      text: preview.text,
      truncated: preview.truncated || event.bodyAvailable === true,
    },
    ...(outputSha256 ? { outputSha256 } : {}),
    ...(outputBytes > 0 ? { outputBytes } : {}),
    importantRanges: normalizeRanges(event.importantRanges),
    artifacts: normalizeArtifacts(event.artifacts || event.publishedResultAssets),
    evidenceRefs: sourceRefs(event),
  };
}

export function buildToolResultDescriptors(events = [], options = {}) {
  return (Array.isArray(events) ? events : [])
    .map((event) => createToolResultDescriptor(event, options))
    .filter(Boolean);
}

export function formatToolResultDescriptor(descriptor, { includePreview = true } = {}) {
  if (!descriptor || typeof descriptor !== 'object') return '';
  const lines = [
    `[Tool result: ${text(descriptor.toolName, 240) || 'unknown'}]`,
    `execution=${text(descriptor.toolExecutionId, 200) || 'unknown'} outcome=${text(descriptor.outcome, 80) || 'unknown'}`,
  ];
  if (Number.isInteger(descriptor.exitCode)) lines[1] += ` exit=${descriptor.exitCode}`;
  if (descriptor.commandDigest) lines.push(`commandDigest=${descriptor.commandDigest}`);
  if (descriptor.rawOutputRef?.ref) {
    lines.push(`rawRef=${descriptor.rawOutputRef.kind || 'output'}:${descriptor.rawOutputRef.ref}`);
  }
  if (includePreview && descriptor.preview?.text) lines.push(descriptor.preview.text);
  return lines.join('\n');
}

export async function readToolResultRange({
  descriptor,
  readRaw,
  startByte = 0,
  endByte = null,
  maxBytes = DEFAULT_TOOL_RESULT_RANGE_MAX_BYTES,
  expectedSha256 = '',
} = {}) {
  if (!descriptor?.rawOutputRef?.ref || typeof readRaw !== 'function') {
    const error = new Error('tool result raw output is not readable');
    error.code = 'TOOL_RESULT_RAW_REF_UNAVAILABLE';
    throw error;
  }
  const start = positiveInt(startByte);
  if (start === null) throw new Error('tool result range startByte must be a non-negative integer');
  const limit = Number.isInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, DEFAULT_TOOL_RESULT_RANGE_MAX_BYTES)
    : DEFAULT_TOOL_RESULT_RANGE_MAX_BYTES;
  const raw = await readRaw(descriptor.rawOutputRef);
  const value = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
  const buffer = Buffer.from(value, 'utf8');
  const actualSha256 = digest(value);
  const expected = text(expectedSha256, 120) || text(descriptor.outputSha256, 120)
    || text(descriptor.rawOutputRef.sha256, 120);
  if (expected && expected !== actualSha256) {
    const error = new Error('tool result raw output digest mismatch');
    error.code = 'TOOL_RESULT_RAW_DIGEST_MISMATCH';
    error.expectedSha256 = expected;
    error.actualSha256 = actualSha256;
    throw error;
  }
  const requestedEnd = endByte === null ? start + limit : positiveInt(endByte);
  if (requestedEnd === null || requestedEnd <= start) throw new Error('tool result range endByte is invalid');
  const boundedEnd = Math.min(requestedEnd, start + limit, buffer.length);
  return {
    toolExecutionId: descriptor.toolExecutionId,
    rawOutputRef: descriptor.rawOutputRef,
    startByte: start,
    endByte: boundedEnd,
    totalBytes: buffer.length,
    sha256: actualSha256,
    text: buffer.subarray(start, boundedEnd).toString('utf8'),
    truncated: boundedEnd < buffer.length,
  };
}

export async function readHistoryToolResultRange({
  sessionId,
  descriptor,
  startByte = 0,
  endByte = null,
  maxBytes = DEFAULT_TOOL_RESULT_RANGE_MAX_BYTES,
} = {}) {
  const normalizedSessionId = text(sessionId || descriptor?.rawOutputRef?.sessionId, 240);
  const seq = positiveInt(descriptor?.rawOutputRef?.seq)
    ?? positiveInt(descriptor?.evidenceRefs?.[0]?.seq);
  if (!normalizedSessionId || seq === null) {
    const error = new Error('history tool result ref is missing session or event sequence');
    error.code = 'TOOL_RESULT_HISTORY_REF_INVALID';
    throw error;
  }
  const { readEventBody } = await import('./history.mjs');
  const body = await readEventBody(normalizedSessionId, seq);
  if (!body?.value) {
    const error = new Error('history tool result body is unavailable');
    error.code = 'TOOL_RESULT_HISTORY_BODY_UNAVAILABLE';
    throw error;
  }
  return readToolResultRange({
    descriptor,
    readRaw: async () => body.value,
    startByte,
    endByte,
    maxBytes,
  });
}
