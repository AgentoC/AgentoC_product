// P2b (2026-08-01): Pre-compaction critical fact extraction.
// Before an LLM compaction worker runs, extract durable facts (exact numbers,
// hard constraints, decision reasoning, cross-task dependencies, implicit
// preferences) from the latest turn and persist them into the task-card memory.
// These facts are then injected into the compaction prompt as "protected facts"
// that the compactor worker must preserve.

import { runDetachedAssistantPrompt } from './session-detached-assistant.mjs';
import { extractTaggedBlock } from './session-text-parsing.mjs';
import { clipCompactionSection } from './session-context-compaction.mjs';
import { formatEventsForPrompt } from './summarizer.mjs';

const EXTRACTION_MAX_CHARS = 3000;
const EXTRACTED_FACT_MAX_CHARS = 240;

export function buildCriticalFactExtractionPrompt({ lastTurnText, existingMemory = [] }) {
  const memoryContext = existingMemory.length > 0
    ? `Existing durable memory:\n${existingMemory.map((m) => `- ${m}`).join('\n')}`
    : 'No existing durable memory.';

  return [
    'You are extracting critical facts that must survive context compaction.',
    'Compaction will condense older conversation into a summary — these facts go into durable memory first.',
    '',
    'Extract ONLY facts that meet these criteria:',
    '- Exact numeric values: port numbers, version strings, file paths, error codes, thresholds',
    '- Hard constraints: "never deploy to X", "must use Y library", "do not change Z"',
    '- Decision reasoning: WHY a specific approach was chosen over alternatives',
    '- Cross-task dependencies: "this depends on session X being done first"',
    '- Implicit preferences: coding style, naming conventions, tool choices',
    '',
    'Do NOT extract:',
    '- General task progress ("we are working on X")',
    '- Transient state ("currently reading file Y")',
    '- Tool call details or raw output',
    '- Facts already in the existing memory list',
    '',
    memoryContext,
    '',
    'Latest turn:',
    clipCompactionSection(lastTurnText, 2000),
    '',
    'Return exactly one tagged block:',
    '<critical_facts>',
    '- fact 1',
    '- fact 2',
    '</critical_facts>',
    '',
    'Each fact is a single line starting with "- ". Max 3 lines. Only facts not already in memory.',
    'If nothing qualifies, return an empty <critical_facts> block.',
    'Respond with ONLY the tagged block. No markdown, no explanation.',
  ].join('\n');
}

export function parseExtractedFacts(content) {
  const block = extractTaggedBlock(content, 'critical_facts');
  if (!block) return [];
  return block
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0 && line.length <= EXTRACTED_FACT_MAX_CHARS);
}

export async function extractCriticalFacts({ session, lastTurnEvents }) {
  if (!lastTurnEvents || lastTurnEvents.length === 0) return [];

  const lastTurnText = formatEventsForPrompt(lastTurnEvents, {
    userLimit: 1200,
    assistantLimit: 1800,
    maxEvents: 40,
    maxTotalChars: EXTRACTION_MAX_CHARS,
  });
  if (!lastTurnText.trim()) return [];

  const existingMemory = Array.isArray(session?.taskCard?.memory)
    ? session.taskCard.memory
    : [];

  const prompt = buildCriticalFactExtractionPrompt({
    lastTurnText,
    existingMemory,
  });

  try {
    const modelText = await runDetachedAssistantPrompt(session, prompt, {
      timeoutMs: 8000,
      effort: 'low',
      thinking: false,
      usageTracking: { operation: 'pre_compact_extraction' },
    });
    return parseExtractedFacts(modelText);
  } catch (error) {
    console.error(
      `[pre-compact-extraction] Failed for ${session?.id?.slice?.(0, 8) || 'unknown'}: ${error.message}`,
    );
    return [];
  }
}
