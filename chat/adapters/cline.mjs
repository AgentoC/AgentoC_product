import {
  fileChangeEvent,
  messageEvent,
  reasoningEvent,
  statusEvent,
  textDeltaEvent,
  toolResultEvent,
  toolUseEvent,
  usageEvent,
} from '../normalizer.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';
import { inferProviderFileChange, serializeProviderToolValue } from '../provider-tool-normalization.mjs';

export const CLINE_RUNTIME_FAMILY = 'cline-json';

function text(value) {
  return typeof value === 'string' ? value : '';
}

function clean(value) {
  return text(value).trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function providerFields(providerSessionId) {
  return {
    provider: 'cline',
    runtimeFamily: CLINE_RUNTIME_FAMILY,
    ...(providerSessionId ? { providerSessionId } : {}),
  };
}

function readText(event) {
  const candidates = [
    event?.text,
    event?.delta,
    event?.content,
    event?.message,
    event?.data?.text,
    event?.data?.delta,
    event?.data?.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = candidate.text || candidate.delta || candidate.content;
      if (typeof nested === 'string' && nested) return nested;
    }
  }
  return '';
}

function readReasoning(event) {
  const candidates = [
    event?.reasoning,
    event?.data?.reasoning,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = candidate.reasoning || candidate.text || candidate.content;
      if (typeof nested === 'string' && nested) return nested;
    }
  }
  return '';
}

function readToolOutput(event) {
  const candidates = [
    event?.output,
    event?.result,
    event?.toolOutput,
    event?.tool_output,
    event?.data?.output,
    event?.data?.result,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = candidate.output || candidate.result || candidate.content || candidate.text;
      if (typeof nested === 'string' && nested) return nested;
      return serializeProviderToolValue(candidate);
    }
  }
  return '';
}

function readToolInput(event) {
  const value = event?.input
    ?? event?.toolInput
    ?? event?.tool_input
    ?? event?.parameters
    ?? event?.arguments
    ?? event?.data?.input
    ?? event?.data?.arguments;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function readToolName(event) {
  return clean(
    event?.toolName
      || event?.tool_name
      || event?.name
      || event?.data?.toolName
      || event?.data?.tool_name,
  ) || 'tool';
}

function readUsage(event, providerSessionId = '') {
  const source = event?.usage && typeof event.usage === 'object' ? event.usage : event;
  const inputTokens = number(source?.inputTokens ?? source?.input_tokens ?? source?.totalInputTokens ?? source?.total_input_tokens);
  const outputTokens = number(source?.outputTokens ?? source?.output_tokens ?? source?.totalOutputTokens ?? source?.total_output_tokens);
  const cachedInputTokens = number(source?.cachedInputTokens
    ?? source?.cacheReadTokens
    ?? source?.cacheReadInputTokens
    ?? source?.cache_read_tokens
    ?? source?.cache_read_input_tokens
    ?? source?.totalCacheReadTokens
    ?? source?.total_cache_read_tokens);
  const reasoningTokens = number(source?.reasoningTokens ?? source?.reasoning_tokens);
  const contextTokens = number(source?.contextTokens ?? source?.context_tokens ?? source?.totalTokens ?? source?.total_tokens);
  return usageEvent({
    ...providerFields(providerSessionId),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    contextSource: 'cline-json',
  });
}

function unwrapAgentEvent(payload) {
  if (!payload || typeof payload !== 'object') return { event: null, envelope: null };
  const envelope = payload.type === 'agent_event'
    && payload.payload && typeof payload.payload === 'object'
    ? payload.payload
    : payload;
  const event = envelope?.event && typeof envelope.event === 'object'
    ? envelope.event
    : envelope;
  if (!event || typeof event !== 'object') return { event: null, envelope };
  return {
    envelope,
    event: {
      ...event,
      sessionId: event.sessionId
        || event.session_id
        || envelope.sessionId
        || envelope.session_id
        || payload.sessionId
        || payload.session_id,
    },
  };
}

function readError(event) {
  const value = event?.error ?? event?.message ?? event?.data?.error ?? event?.data?.message;
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return clean(value.message || value.error || JSON.stringify(value));
  return '';
}

export function createClineAdapter() {
  let providerSessionId = '';
  let textBuffer = '';
  const toolCalls = new Map();

  return {
    adapterCompatibility: getHarnessAdapterCompatibility('cline'),
    capabilities: getProviderCapabilities(CLINE_RUNTIME_FAMILY),

    parseLine(line) {
      let payload;
      try { payload = JSON.parse(String(line || '').trim()); } catch { return []; }
      const { event, envelope } = unwrapAgentEvent(payload);
      if (!event || typeof event !== 'object') return [];

      providerSessionId = clean(
        event.sessionId
          || event.session_id
          || envelope?.sessionId
          || envelope?.session_id
          || payload.sessionId
          || payload.session_id
          || providerSessionId,
      );
      const fields = providerFields(providerSessionId);
      const contentType = clean(event.contentType || event.content_type || event.data?.contentType).toLowerCase();
      const events = [];

      switch (clean(event.type).toLowerCase()) {
        case 'content_start': {
          if (contentType === 'text') {
            textBuffer = '';
            const value = readText(event);
            if (value) {
              textBuffer += value;
              events.push(textDeltaEvent(0, value, fields));
            }
          } else if (contentType === 'reasoning') {
            const value = readReasoning(event);
            if (value) events.push(reasoningEvent(value, {
              ...fields,
              providerBlockId: clean(event.id) || 'thinking:0',
              blockIndex: 0,
              providerLifecycle: 'delta',
              reasoningLifecycle: 'delta',
              operationLifecycle: 'delta',
              state: 'running',
            }));
          } else if (contentType === 'tool') {
            const toolCallId = clean(event.toolCallId || event.tool_call_id || event.id);
            const toolName = readToolName(event);
            const toolInput = readToolInput(event);
            if (!toolCallId || !toolCalls.has(toolCallId)) {
              if (toolCallId) toolCalls.set(toolCallId, { toolName, toolInput });
              events.push(toolUseEvent(readToolName(event), readToolInput(event), {
                ...fields,
                ...(toolCallId ? { providerToolUseId: toolCallId } : {}),
                operationLifecycle: 'started',
              }));
            }
          }
          break;
        }
        case 'content_update': {
          const value = readText(event);
          if (contentType === 'reasoning') {
            const reasoning = readReasoning(event) || value;
            if (reasoning) events.push(reasoningEvent(reasoning, {
              ...fields,
              providerBlockId: clean(event.id) || 'thinking:0',
              blockIndex: 0,
              providerLifecycle: 'delta',
              reasoningLifecycle: 'delta',
              operationLifecycle: 'delta',
              state: 'running',
            }));
          } else if (contentType === 'tool') {
            const toolCallId = clean(event.toolCallId || event.tool_call_id || event.id);
            const toolName = readToolName(event);
            const toolInput = readToolInput(event);
            const known = toolCallId ? toolCalls.get(toolCallId) : null;
            if (!toolCallId || !known || (!known.toolInput && toolInput)) {
              if (toolCallId) toolCalls.set(toolCallId, { toolName: known?.toolName || toolName, toolInput });
              events.push(toolUseEvent(toolName, toolInput, {
                ...fields,
                ...(toolCallId ? { providerToolUseId: toolCallId } : {}),
                operationLifecycle: 'started',
              }));
            }
          } else if (value) {
            textBuffer += value;
            events.push(textDeltaEvent(0, value, fields));
          }
          break;
        }
        case 'content_end': {
          const value = contentType === 'reasoning' ? readReasoning(event) : readText(event);
          if (contentType === 'tool') {
            const toolCallId = clean(event.toolCallId || event.tool_call_id || event.id);
            const failed = Boolean(event.error || event.status === 'error' || event.status === 'failed');
            const known = toolCallId ? toolCalls.get(toolCallId) : null;
            const toolName = readToolName(event) === 'tool' ? (known?.toolName || 'tool') : readToolName(event);
            events.push(toolResultEvent(
              toolName,
              readToolOutput(event) || readText(event) || readError(event),
              failed ? 1 : 0,
              {
                ...fields,
                ...(toolCallId ? { providerToolUseId: toolCallId } : {}),
                operationLifecycle: failed ? 'failed' : 'completed',
              },
            ));
            if (!failed) {
              const change = inferProviderFileChange({ toolName, toolInput: known?.toolInput || readToolInput(event) });
              if (change) events.push(fileChangeEvent(change.filePath, change.changeType, {}, {
                ...fields,
                ...(toolCallId ? { providerToolUseId: toolCallId } : {}),
                operationLifecycle: 'completed',
              }));
            }
            if (toolCallId) toolCalls.delete(toolCallId);
          } else if (contentType === 'reasoning') {
            if (value) events.push(reasoningEvent(value, {
              ...fields,
              providerBlockId: clean(event.id) || 'thinking:0',
              blockIndex: 0,
              providerLifecycle: 'completed',
              reasoningLifecycle: 'completed',
              state: 'completed',
            }));
          } else if (value || textBuffer) {
            // Cline's content_end is the durable boundary. Updates are kept as
            // ephemeral deltas; emit one final assistant message for replay.
            events.push(messageEvent('assistant', value || textBuffer, undefined, fields));
            textBuffer = '';
          }
          break;
        }
        case 'iteration_start':
          events.push(statusEvent('thinking', { ...fields, providerLifecycle: 'iteration_started' }));
          break;
        case 'iteration_end':
          events.push(statusEvent('iteration completed', { ...fields, providerLifecycle: 'iteration_completed' }));
          break;
        case 'usage':
          events.push(readUsage(event, providerSessionId));
          break;
        case 'done':
        case 'completed':
          events.push(statusEvent('completed', { ...fields, providerLifecycle: 'completed' }));
          break;
        case 'error': {
          const error = readError(event) || 'Cline run failed';
          events.push(statusEvent(`error: ${error}`, { ...fields, providerLifecycle: 'error' }));
          break;
        }
        default:
          break;
      }
      return events.filter(Boolean);
    },

    flush() {
      const buffered = textBuffer;
      textBuffer = '';
      toolCalls.clear();
      return buffered
        ? [messageEvent('assistant', buffered, undefined, providerFields(providerSessionId))]
        : [];
    },
  };
}

export function buildClineArgs(prompt, {
  provider = '',
  model = '',
  resume = '',
  riskMode = '',
} = {}) {
  const task = typeof prompt === 'string' ? prompt.trim() : '';
  if (!task) throw new Error('Cline requires a non-empty prompt');
  const args = riskMode === 'conservative-auto'
    ? ['--json', '--auto-approve', 'false']
    : ['--json', '--yolo'];
  if (clean(resume)) args.push('--id', clean(resume));
  if (clean(provider)) args.push('--provider', clean(provider));
  if (clean(model)) args.push('--model', clean(model).split('@')[0]);
  args.push(task);
  return args;
}
