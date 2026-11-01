/**
 * Structured session suggestion (DS-05)
 *
 * After a completed turn, a single model call returns an optional taskCard,
 * workflowState, nextAction, confidence and reason. This module owns the
 * suggestion schema, the strict fenced-JSON extraction, and the schema
 * validation: a result that does not match the schema is discarded entirely
 * instead of being partially applied.
 *
 * No provider in this codebase exposes native structured output yet, so the
 * strict fenced-JSON path is the universal one. The schema stays compatible
 * with the old task-card and workflow-state result shapes: every old field
 * name is accepted either directly or through the normalizers in
 * session-task-card.mjs / session-workflow-state.mjs. Hidden chain-of-thought
 * fields are rejected explicitly — "reason" is the only rationale field and
 * it is visible.
 */

import { clipText, normalizeSessionTaskCard } from './session-task-card.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';

export const SUGGESTION_SCHEMA_VERSION = 1;
export const SUGGESTION_MAX_NEXT_ACTION_CHARS = 200;
export const SUGGESTION_MAX_REASON_CHARS = 300;

// Keys a compliant model may emit. Anything else (including hidden
// chain-of-thought fields) makes the whole result invalid and discarded.
export const SUGGESTION_ALLOWED_KEYS = Object.freeze([
  'taskCard',
  'workflowState',
  'workflowPriority',
  'shouldSetWorkflowState',
  'nextAction',
  'confidence',
  'reason',
]);

// Hidden reasoning fields are never part of the schema; a model that emits
// one gets the whole result discarded (see parseMergedSuggestionResult).
export const SUGGESTION_HIDDEN_THINKING_KEYS = Object.freeze([
  'thinking',
  'chainOfThought',
  'chain_of_thought',
  'hiddenReasoning',
  'internalReasoning',
  'hiddenChainOfThought',
  'scratchpad',
  'scratch_pad',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// '' plus a small set of "keep active / no change" labels is a neutral
// workflow-state output; anything else that does not normalize to a valid
// state is an invalid result.
export function isNeutralWorkflowStateLabel(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === ''
    || normalized === 'active'
    || normalized === 'neutral'
    || normalized === 'unset'
    || normalized === 'none'
    || normalized === 'keep_active';
}

/**
 * Strict fenced-JSON extraction. Accepts a single ```json fenced block, or a
 * bare JSON object when no fence is present; anything else returns null and
 * the caller discards the result.
 */
export function extractStrictFencedJson(modelText) {
  const text = typeof modelText === 'string' ? modelText.trim() : '';
  if (!text) return null;
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch
    ? fencedMatch[1].trim()
    : (text.startsWith('{') ? text : '');
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate and normalize a merged suggestion result.
 *
 * @param {string} modelText Raw model output (fenced JSON expected).
 * @returns {{ok: true, suggestion: object}}
 *   | {{ok: false, discarded: true, reason: string, fields?: string[]}}
 */
export function parseMergedSuggestionResult(modelText) {
  const parsed = extractStrictFencedJson(modelText);
  if (!parsed) {
    return { ok: false, discarded: true, reason: 'no_json' };
  }

  const keys = Object.keys(parsed);
  const hiddenThinking = keys.filter((key) => SUGGESTION_HIDDEN_THINKING_KEYS.includes(key));
  if (hiddenThinking.length > 0) {
    return { ok: false, discarded: true, reason: 'hidden_thinking', fields: hiddenThinking };
  }
  const unknown = keys.filter((key) => !SUGGESTION_ALLOWED_KEYS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, discarded: true, reason: 'unknown_field', fields: unknown };
  }

  const suggestion = {};
  const invalid = (reason) => ({ ok: false, discarded: true, reason });

  if ('taskCard' in parsed) {
    if (parsed.taskCard === null) {
      // Explicit "keep the current card" — nothing to write.
    } else if (!isPlainObject(parsed.taskCard)) {
      return invalid('invalid_task_card');
    } else {
      const taskCard = normalizeSessionTaskCard(parsed.taskCard);
      if (!taskCard) return invalid('invalid_task_card');
      suggestion.taskCard = taskCard;
    }
  }

  if ('workflowState' in parsed) {
    if (typeof parsed.workflowState !== 'string') return invalid('invalid_workflow_state');
    const workflowState = normalizeSessionWorkflowState(parsed.workflowState);
    if (!workflowState && !isNeutralWorkflowStateLabel(parsed.workflowState)) {
      return invalid('invalid_workflow_state');
    }
    // Keep the empty/neutral string too: the runner needs it to distinguish
    // "keep current" from "explicitly clear" (old shouldClear semantics).
    suggestion.workflowState = workflowState;
  }

  if ('workflowPriority' in parsed) {
    if (typeof parsed.workflowPriority !== 'string') return invalid('invalid_workflow_priority');
    // Unknown labels normalize to '' and fall back to the state-derived
    // default priority in the runner — same tolerance as the old API.
    suggestion.workflowPriority = normalizeSessionWorkflowPriority(parsed.workflowPriority);
  }

  if ('shouldSetWorkflowState' in parsed) {
    if (typeof parsed.shouldSetWorkflowState !== 'boolean') return invalid('invalid_should_set_workflow_state');
    suggestion.shouldSetWorkflowState = parsed.shouldSetWorkflowState;
  }

  if ('nextAction' in parsed) {
    if (typeof parsed.nextAction !== 'string') return invalid('invalid_next_action');
    const nextAction = clipText(parsed.nextAction, SUGGESTION_MAX_NEXT_ACTION_CHARS);
    if (nextAction) suggestion.nextAction = nextAction;
  }

  if ('confidence' in parsed) {
    const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? parsed.confidence
      : null;
    if (confidence === null || confidence < 0 || confidence > 1) {
      return invalid('invalid_confidence');
    }
    suggestion.confidence = confidence;
  }

  if ('reason' in parsed) {
    if (typeof parsed.reason !== 'string') return invalid('invalid_reason');
    const reason = clipText(parsed.reason, SUGGESTION_MAX_REASON_CHARS);
    if (reason) suggestion.reason = reason;
  }

  const hasContent = Object.keys(suggestion).length > 0
    || 'shouldSetWorkflowState' in suggestion;
  if (!hasContent) {
    return invalid('empty');
  }

  return { ok: true, suggestion };
}
