// OpenHands Agent Server service adapter.
//
// Agent Canvas is only a UI/agent-server launcher.  This adapter targets the
// Agent Server HTTP + WebSocket contract directly, so it remains separate from
// the process-jsonl runner used by local CLI harnesses.

import { inferProviderFileChange } from '../provider-tool-normalization.mjs';

export const OPENHANDS_SERVICE_RUNTIME_FAMILY = 'openhands-agent-server';
export const OPENHANDS_AGENT_SERVER_API_VERSION = 'v1';
export const OPENHANDS_SERVICE_REQUEST_TIMEOUT_MS = 30_000;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireConversationId(value) {
  const id = clean(value);
  if (!id) throw new Error('OpenHands conversation id is required');
  return encodeURIComponent(id);
}

export function normalizeOpenHandsServiceHost(host) {
  const value = clean(host).replace(/\/+$/, '');
  if (!value) throw new Error('OpenHands Agent Server host is required');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OpenHands Agent Server host must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('OpenHands Agent Server host must use http or https');
  }
  return value;
}

export function buildOpenHandsAgent({
  model,
  apiKey,
  baseUrl,
  // Agent Server 1.42.x and 1.58.2 expose the native OpenHands implementation as
  // `Agent`; CodeActAgent was the pre-Agent-Server discriminator.
  agentKind = 'Agent',
  agentContext,
} = {}) {
  const llm = { model: clean(model) };
  if (!llm.model) throw new Error('OpenHands Agent Server model is required');
  if (clean(apiKey)) llm.api_key = clean(apiKey);
  if (clean(baseUrl)) llm.base_url = clean(baseUrl);
  return {
    kind: clean(agentKind) || 'Agent',
    llm,
    ...(agentContext && typeof agentContext === 'object' ? { agent_context: agentContext } : {}),
  };
}

export function buildOpenHandsCreateConversationPayload({
  agent,
  workingDir,
  initialMessage,
  maxIterations = 500,
  stuckDetection = true,
  userId = null,
} = {}) {
  if (!agent || typeof agent !== 'object') throw new Error('OpenHands agent is required');
  const cwd = clean(workingDir);
  if (!cwd) throw new Error('OpenHands working directory is required');
  const payload = {
    agent,
    max_iterations: Number.isInteger(maxIterations) && maxIterations > 0 ? maxIterations : 500,
    stuck_detection: stuckDetection !== false,
    workspace: { kind: 'LocalWorkspace', working_dir: cwd },
    user_id: clean(userId) || null,
  };
  const message = clean(initialMessage);
  if (message) {
    payload.initial_message = {
      role: 'user',
      content: [{ type: 'text', text: message }],
    };
  }
  return payload;
}

export function buildOpenHandsUserEvent(message, { run = false } = {}) {
  const text = clean(message);
  if (!text) throw new Error('OpenHands user message is required');
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    run: run === true,
  };
}

export function buildOpenHandsServiceUrl(host, conversationId, suffix = '') {
  const base = normalizeOpenHandsServiceHost(host);
  const id = requireConversationId(conversationId);
  return `${base}/api/conversations/${id}${suffix}`;
}

export function buildOpenHandsEventsWebSocketUrl(host, conversationId, apiKey = '') {
  const base = new URL(normalizeOpenHandsServiceHost(host));
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${base.pathname.replace(/\/$/, '')}/sockets/events/${encodeURIComponent(clean(conversationId))}`;
  if (clean(apiKey)) base.searchParams.set('session_api_key', clean(apiKey));
  return base.toString();
}

export function normalizeOpenHandsExecutionStatus(value) {
  const status = clean(value).toLowerCase();
  if (['finished', 'completed'].includes(status)) return 'completed';
  if (['error', 'stuck'].includes(status)) return 'failed';
  if (['paused', 'waiting_for_confirmation'].includes(status)) return 'waiting';
  if (status === 'deleting') return 'cancelled';
  if (status === 'running') return 'running';
  return 'idle';
}

function eventText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && part.type === 'text')
    .map((part) => clean(part.text))
    .filter(Boolean)
    .join('');
}

function eventMetadata(event) {
  return {
    ...(clean(event?.id) ? { id: clean(event.id) } : {}),
    ...(clean(event?.timestamp) ? { timestamp: event.timestamp } : {}),
  };
}

/**
 * Convert one Agent Server event into zero or more stable Harness Contract
 * events. Unknown event kinds are deliberately ignored: callers can persist
 * the raw event separately without presenting an invented meaning to users.
 */
export function bridgeOpenHandsServiceEvent(event, { toolCalls = null } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
  const meta = eventMetadata(event);
  switch (clean(event.kind)) {
    case 'MessageEvent': {
      const role = clean(event.llm_message?.role).toLowerCase();
      const content = eventText(event.llm_message?.content);
      return role === 'assistant' && content
        ? [{ type: 'assistant.message', content, ...meta }]
        : [];
    }
    case 'StreamingDeltaEvent': {
      const result = [];
      if (clean(event.content)) result.push({ type: 'assistant.delta', content: event.content, ...meta });
      if (clean(event.reasoning_content)) result.push({ type: 'reasoning.delta', content: event.reasoning_content, ...meta });
      return result;
    }
    case 'ActionEvent': {
      const action = event.action && typeof event.action === 'object' ? event.action : {};
      const toolName = clean(event.tool_name) || clean(action.kind) || 'tool';
      const toolCallId = clean(event.tool_call_id);
      if (toolCallId && toolCalls instanceof Map) toolCalls.set(toolCallId, { toolName, input: action });
      return [{
        type: 'tool.started',
        toolName,
        input: action,
        toolCallId,
        ...meta,
      }];
    }
    case 'ObservationEvent': {
      const observation = event.observation && typeof event.observation === 'object'
        ? event.observation : {};
      const toolCallId = clean(event.action_id);
      const known = toolCallId && toolCalls instanceof Map ? toolCalls.get(toolCallId) : null;
      const toolName = known?.toolName || clean(observation.kind) || 'tool';
      const error = clean(observation.error || observation.message);
      const result = [{
        type: 'tool.completed',
        toolName,
        output: observation,
        exitCode: error ? 1 : 0,
        toolCallId,
        ...meta,
      }];
      const change = !error ? inferProviderFileChange({ toolName, toolInput: known?.input }) : null;
      if (change) result.push({
        type: 'file.changed',
        toolCallId,
        filePath: change.filePath,
        changeType: change.changeType,
        ...meta,
        ...(meta.id ? { id: `${meta.id}:file-change` } : {}),
      });
      if (toolCallId && toolCalls instanceof Map) toolCalls.delete(toolCallId);
      return result;
    }
    case 'AgentErrorEvent':
    case 'ConversationErrorEvent':
    case 'ServerErrorEvent':
      return [{ type: 'run.failed', content: clean(event.error || event.detail || event.message) || 'OpenHands reported an error', ...meta }];
    case 'ConversationStateUpdateEvent': {
      const status = clean(event.key).toLowerCase() === 'execution_status'
        ? normalizeOpenHandsExecutionStatus(event.value)
        : '';
      if (status === 'completed') return [{ type: 'run.completed', ...meta }];
      if (status === 'failed') return [{ type: 'run.failed', content: `OpenHands status: ${event.value}`, ...meta }];
      if (status === 'waiting') return [{ type: 'run.waiting', content: `OpenHands status: ${event.value}`, ...meta }];
      if (status === 'running') return [{ type: 'turn.started', content: 'OpenHands is running', ...meta }];
      return [];
    }
    case 'PauseEvent':
      return [{ type: 'run.waiting', content: 'OpenHands paused', ...meta }];
    case 'ConfirmationRequestEvent':
      return [{
        type: 'tool.approval_required',
        approvalId: clean(event.action_id) || clean(event.id),
        toolName: clean(event.action?.tool_name) || clean(event.action?.action?.kind) || 'tool',
        title: 'OpenHands requires confirmation',
        reason: clean(event.risk_assessment),
        ...meta,
      }];
    case 'FinishEvent':
      return [{ type: event.success === false ? 'run.failed' : 'run.completed', content: clean(event.message), ...meta }];
    default:
      return [];
  }
}

function assertResponse(response, body) {
  if (response.ok) return;
  const detail = typeof body === 'string' ? body : body?.detail || body?.message || response.statusText;
  const error = new Error(`OpenHands Agent Server request failed (${response.status}): ${detail || 'unknown error'}`);
  error.statusCode = response.status;
  error.body = body;
  throw error;
}

export class OpenHandsServiceClient {
  constructor({
    host,
    apiKey = '',
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = OPENHANDS_SERVICE_REQUEST_TIMEOUT_MS,
  } = {}) {
    this.host = normalizeOpenHandsServiceHost(host);
    this.apiKey = clean(apiKey);
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0
      ? Number(requestTimeoutMs)
      : OPENHANDS_SERVICE_REQUEST_TIMEOUT_MS;
    if (typeof this.fetchImpl !== 'function') throw new Error('OpenHands service client requires fetch');
  }

  async request(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json' };
    // Agent Server's session auth contract is deliberately not Bearer auth.
    // The official TypeScript client uses this header for every /api request.
    if (this.apiKey) headers['X-Session-API-Key'] = this.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.requestTimeoutMs)
      : null;
    try {
      const response = await this.fetchImpl(`${this.host}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = await response.text();
      let parsed = text;
      try { parsed = text ? JSON.parse(text) : null; } catch {}
      assertResponse(response, parsed);
      return parsed;
    } catch (error) {
      if (controller?.signal.aborted) {
        throw Object.assign(new Error(`OpenHands Agent Server request timed out after ${this.requestTimeoutMs}ms`), {
          code: 'OPENHANDS_REQUEST_TIMEOUT',
          cause: error,
        });
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  createConversation(payload) {
    return this.request('/api/conversations', { method: 'POST', body: payload });
  }

  getConversation(conversationId) {
    return this.request(new URL(buildOpenHandsServiceUrl(this.host, conversationId)).pathname);
  }

  sendUserMessage(conversationId, message) {
    return this.request(new URL(buildOpenHandsServiceUrl(this.host, conversationId, '/events')).pathname, {
      method: 'POST', body: buildOpenHandsUserEvent(message),
    });
  }

  runConversation(conversationId) {
    return this.request(new URL(buildOpenHandsServiceUrl(this.host, conversationId, '/run')).pathname, {
      method: 'POST', body: {},
    });
  }

  interruptConversation(conversationId) {
    return this.request(new URL(buildOpenHandsServiceUrl(this.host, conversationId, '/interrupt')).pathname, {
      method: 'POST', body: {},
    });
  }

  respondToConfirmation(conversationId, { accept, reason = '' } = {}) {
    return this.request(new URL(buildOpenHandsServiceUrl(this.host, conversationId, '/events/respond_to_confirmation')).pathname, {
      method: 'POST', body: { accept: accept === true, ...(clean(reason) ? { reason: clean(reason) } : {}) },
    });
  }

  pauseConversation(conversationId) {
    return this.request(new URL(buildOpenHandsServiceUrl(this.host, conversationId, '/pause')).pathname, {
      method: 'POST', body: {},
    });
  }

  connectEvents(conversationId, { onEvent, onError, onClose } = {}) {
    if (typeof this.WebSocketImpl !== 'function') throw new Error('OpenHands service client requires WebSocket');
    const socket = new this.WebSocketImpl(buildOpenHandsEventsWebSocketUrl(this.host, conversationId, this.apiKey));
    socket.onmessage = (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        onEvent?.(JSON.parse(raw));
      } catch (error) {
        onError?.(error);
      }
    };
    socket.onerror = (error) => onError?.(error);
    socket.onclose = (event) => onClose?.(event);
    return socket;
  }
}
