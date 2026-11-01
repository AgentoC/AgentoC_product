// P2b focused unit test: pre-compaction critical fact extraction
// Tests pure-logic functions (prompt building + fact parsing) without
// running a real detached assistant process.

import {
  buildCriticalFactExtractionPrompt,
  parseExtractedFacts,
} from '../chat/session-pre-compact-extraction.mjs';

// --- buildCriticalFactExtractionPrompt ---

function check(label, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`FAIL [${label}]: ${error.message}`);
    process.exit(1);
  }
}

// Basic prompt structure
check('prompt contains extraction criteria', () => {
  const prompt = buildCriticalFactExtractionPrompt({
    lastTurnText: 'USER: set port to 8080\nASSISTANT: ok',
    existingMemory: [],
  });
  if (!prompt.includes('critical facts that must survive')) {
    throw new Error('missing critical facts instruction');
  }
  if (!prompt.includes('port numbers')) {
    throw new Error('missing numeric value criteria');
  }
  if (!prompt.includes('Hard constraints')) {
    throw new Error('missing hard constraints criteria');
  }
});

// Prompt includes existing memory when present
check('prompt includes existing memory', () => {
  const prompt = buildCriticalFactExtractionPrompt({
    lastTurnText: 'USER: hello',
    existingMemory: ['port 8080', 'use postgres'],
  });
  if (!prompt.includes('existing memory')) {
    // The prompt says 'Existing durable memory:' or 'No existing durable memory.'
    throw new Error('missing memory section');
  }
  if (!prompt.includes('port 8080')) {
    throw new Error('existing memory not injected into prompt');
  }
});

// Prompt when no existing memory
check('prompt with no existing memory', () => {
  const prompt = buildCriticalFactExtractionPrompt({
    lastTurnText: 'USER: hello',
    existingMemory: [],
  });
  if (!prompt.includes('No existing durable memory')) {
    throw new Error('missing no-memory message');
  }
});

// --- parseExtractedFacts ---

// Empty block
check('parse empty critical_facts block', () => {
  const facts = parseExtractedFacts('<critical_facts>\n</critical_facts>');
  if (facts.length !== 0) {
    throw new Error(`expected 0 facts, got ${facts.length}`);
  }
});

// Single fact
check('parse single fact', () => {
  const facts = parseExtractedFacts('<critical_facts>\n- port 8080 is the api port\n</critical_facts>');
  if (facts.length !== 1) {
    throw new Error(`expected 1 fact, got ${facts.length}`);
  }
  if (facts[0] !== 'port 8080 is the api port') {
    throw new Error(`unexpected fact: "${facts[0]}"`);
  }
});

// Multiple facts with various bullet styles
check('parse multiple facts with various bullets', () => {
  const content = [
    '<critical_facts>',
    '- fact one: port 8080',
    '* fact two: use postgres',
    '• fact three: deploy only via deb',
    '</critical_facts>',
  ].join('\n');
  const facts = parseExtractedFacts(content);
  if (facts.length !== 3) {
    throw new Error(`expected 3 facts, got ${facts.length}: ${JSON.stringify(facts)}`);
  }
  if (facts[0] !== 'fact one: port 8080') throw new Error(`fact 0 mismatch: "${facts[0]}"`);
  if (facts[1] !== 'fact two: use postgres') throw new Error(`fact 1 mismatch: "${facts[1]}"`);
  if (facts[2] !== 'fact three: deploy only via deb') throw new Error(`fact 2 mismatch: "${facts[2]}"`);
});

// No tagged block at all
check('parse no tagged block', () => {
  const facts = parseExtractedFacts('just some random text');
  if (facts.length !== 0) {
    throw new Error(`expected 0 facts, got ${facts.length}`);
  }
});

// Lines exceeding max chars are filtered
check('parse filters overlong facts', () => {
  const longFact = 'x'.repeat(250); // > EXTRACTED_FACT_MAX_CHARS (240)
  const content = `<critical_facts>\n- ${longFact}\n- short fact\n</critical_facts>`;
  const facts = parseExtractedFacts(content);
  if (facts.length !== 1) {
    throw new Error(`expected 1 fact (long filtered), got ${facts.length}`);
  }
  if (facts[0] !== 'short fact') {
    throw new Error(`expected "short fact", got "${facts[0]}"`);
  }
});

// Empty lines within block are skipped
check('parse skips empty lines', () => {
  const content = [
    '<critical_facts>',
    '- fact one',
    '',
    '  ',
    '- fact two',
    '</critical_facts>',
  ].join('\n');
  const facts = parseExtractedFacts(content);
  if (facts.length !== 2) {
    throw new Error(`expected 2 facts (empty lines skipped), got ${facts.length}`);
  }
});

// Whitespace-only facts are filtered
check('parse filters whitespace-only lines', () => {
  const content = '<critical_facts>\n-   \n- real fact\n</critical_facts>';
  const facts = parseExtractedFacts(content);
  if (facts.length !== 1) {
    throw new Error(`expected 1 fact, got ${facts.length}`);
  }
});

console.log('test-session-pre-compact-extraction: ok');
process.exit(0);
