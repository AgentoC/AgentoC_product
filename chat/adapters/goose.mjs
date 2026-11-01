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
import {
  normalizeProviderToolInput,
  normalizeProviderToolLifecycle,
  serializeProviderToolValue,
} from '../provider-tool-normalization.mjs';

export const GOOSE_RUNTIME_FAMILY = 'goose-headless';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fields(extra = {}) {
  return { provider: 'goose', runtimeFamily: GOOSE_RUNTIME_FAMILY, ...extra };
}

function contentType(value) {
  return clean(value).replace(/[_-]/g, '').toLowerCase();
}

function toolCallValue(content) {
  const call = content?.toolCall || content?.tool_call || {};
  return call?.value && typeof call.value === 'object' ? call.value : call;
}

function toolResultValue(content) {
  const result = content?.toolResult || content?.tool_result || {};
  if (result?.value !== undefined) return result.value;
  if (result?.error !== undefined) return result.error;
  return result;
}

function readToolId(content) {
  return clean(content?.id || content?.toolCallId || content?.tool_call_id);
}

function readToolName(content) {
  const call = toolCallValue(content);
  return clean(call?.name || content?.name || content?.toolName || content?.tool_name) || 'tool';
}

function readToolArguments(content) {
  const call = toolCallValue(content);
  return normalizeProviderToolInput(call?.arguments ?? call?.input ?? content?.arguments ?? content?.input ?? '');
}

function isFailedStatus(value) {
  return ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(clean(value).toLowerCase());
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function fileChangeFromTool(toolName, input, providerToolUseId, lifecycle) {
  if (lifecycle !== 'completed' || !(input && typeof input === 'object')) return null;
  const normalized = clean(toolName).toLowerCase();
  const command = clean(input.command).toLowerCase();
  const isEdit = /(edit|write|replace|patch|text_editor)/.test(normalized)
    && !['view', 'read'].includes(command);
  if (!isEdit) return null;
  const filePath = clean(input.path || input.file_path || input.filename);
  if (!filePath) return null;
  const changeType = ['create', 'write'].includes(command) ? 'add'
    : (['delete', 'remove'].includes(command) ? 'delete' : 'edit');
  return fileChangeEvent(filePath, changeType, {}, fields({
    ...(providerToolUseId ? { providerToolUseId } : {}),
    operationLifecycle: 'completed',
  }));
}

export function createGooseAdapter() {
  const tools = new Map();
  let finalText = '';
  return {
    adapterCompatibility: getHarnessAdapterCompatibility('goose'),
    capabilities: getProviderCapabilities(GOOSE_RUNTIME_FAMILY),
    parseLine(line) {
      const source = String(line || '').trim();
      if (!source) return [];
      let payload;
      try { payload = JSON.parse(source); } catch { return []; }
      const type = clean(payload?.type).toLowerCase();

      if (type === 'message') {
        const message = payload.message && typeof payload.message === 'object' ? payload.message : {};
        const role = clean(message.role).toLowerCase();
        const parts = Array.isArray(message.content) ? message.content : [];
        const events = [];
        for (const content of parts) {
          const kind = contentType(content?.type);
          if (kind === 'text') {
            const text = typeof content.text === 'string' ? content.text : '';
            if (!text || role !== 'assistant') continue;
            finalText += text;
            events.push(textDeltaEvent(0, text, fields({ providerLifecycle: 'text_delta' })));
            continue;
          }
          if (kind === 'thinking' || kind === 'redactedthinking') {
            const thinking = typeof content.thinking === 'string'
              ? content.thinking
              : (typeof content.text === 'string' ? content.text : '');
            if (thinking) events.push(reasoningEvent(thinking, fields({
              providerBlockId: clean(content.id) || 'thinking:0',
              blockIndex: 0,
              providerLifecycle: 'delta',
              reasoningLifecycle: 'delta',
              operationLifecycle: 'delta',
              state: 'running',
            })));
            continue;
          }
          if (kind === 'toolrequest') {
            const providerToolUseId = readToolId(content);
            const toolName = readToolName(content);
            const input = readToolArguments(content);
            const status = clean(content?.toolCall?.status || content?.tool_call?.status);
            if (providerToolUseId) tools.set(providerToolUseId, { toolName, input });
            finalText = '';
            events.push(toolUseEvent(toolName, input, fields({
              ...(providerToolUseId ? { providerToolUseId } : {}),
              operationLifecycle: isFailedStatus(status) ? 'failed' : 'started',
            })));
            continue;
          }
          if (kind === 'toolresponse') {
            const providerToolUseId = readToolId(content);
            const known = providerToolUseId ? tools.get(providerToolUseId) : null;
            const result = content.toolResult || content.tool_result || {};
            const lifecycle = normalizeProviderToolLifecycle(result.status, { update: true });
            const failed = isFailedStatus(result.status) || result.error !== undefined;
            const terminalLifecycle = failed ? 'failed' : (lifecycle === 'delta' ? 'completed' : lifecycle);
            const toolName = known?.toolName || readToolName(content);
            events.push(toolResultEvent(
              toolName,
              serializeProviderToolValue(toolResultValue(content)),
              failed ? 1 : 0,
              fields({
                ...(providerToolUseId ? { providerToolUseId } : {}),
                operationLifecycle: terminalLifecycle,
              }),
            ));
            const fileChange = fileChangeFromTool(toolName, known?.input, providerToolUseId, terminalLifecycle);
            if (fileChange) events.push(fileChange);
            if (providerToolUseId) tools.delete(providerToolUseId);
          }
        }
        return events;
      }

      if (type === 'notification') {
        const message = clean(payload.message);
        return message ? [statusEvent(message, fields({ providerLifecycle: 'notification' }))] : [];
      }
      if (type === 'error') {
        const error = clean(payload.error) || 'Goose run failed';
        return [statusEvent(`error: ${error}`, fields({ providerLifecycle: 'error', runState: 'failed' }))];
      }
      if (type === 'complete') {
        const events = [];
        if (finalText.trim()) events.push(messageEvent('assistant', finalText, undefined, fields({ providerLifecycle: 'final_response' })));
        finalText = '';
        const inputTokens = finiteNumber(payload.input_tokens);
        const outputTokens = finiteNumber(payload.output_tokens);
        const cachedInputTokens = finiteNumber(payload.cache_read_input_tokens);
        const contextTokens = finiteNumber(payload.total_tokens);
        if ([inputTokens, outputTokens, cachedInputTokens, contextTokens].some(Number.isFinite)) {
          events.push(usageEvent({
            ...fields(),
            ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
            ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
            ...(Number.isFinite(cachedInputTokens) ? { cachedInputTokens } : {}),
            ...(Number.isFinite(contextTokens) ? { contextTokens } : {}),
            contextSource: 'goose-stream-json',
          }));
        }
        events.push(statusEvent('completed', fields({ providerLifecycle: 'completed', runState: 'completed' })));
        return events;
      }
      return [];
    },
    flush() {
      const events = finalText.trim()
        ? [messageEvent('assistant', finalText, undefined, fields({ providerLifecycle: 'final_response' }))]
        : [];
      finalText = '';
      tools.clear();
      return events;
    },
  };
}

export function buildGooseArgs(prompt, { model = '' } = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new Error('Goose requires a non-empty prompt');
  const args = ['run', '--text', text, '--output-format', 'stream-json', '--quiet', '--no-session'];
  const selectedModel = typeof model === 'string' ? model.trim().split('@')[0] : '';
  if (selectedModel) args.push('--model', selectedModel);
  return args;
}
