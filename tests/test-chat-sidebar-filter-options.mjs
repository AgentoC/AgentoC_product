#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

// The source filter panel was removed from the sidebar (the funnel button now
// opens Settings). The session-category classification still powers session
// list grouping and the always-unfiltered list, so its contract stays covered.
// UI-only functions (renderSourceFilterOptions, syncSidebarFiltersVisibility,
// …) no longer exist and are intentionally not tested.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap-session-catalog.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const categoryFunctionSources = [
  'normalizeSourceId',
  'getEffectiveSessionSourceId',
  'isDelegatedSessionForFilter',
  'isRobotSessionForFilter',
  'getSessionSourceCategory',
].map((name) => extractFunctionSource(bootstrapSource, name)).join('\n\n');

{
  const context = {
    DEFAULT_APP_ID: 'chat',
    SOURCE_FILTER_CHAT_VALUE: 'chat_ui',
    SOURCE_FILTER_CHILD_VALUE: 'child',
    SOURCE_FILTER_BOT_VALUE: 'bot',
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${categoryFunctionSources}\nglobalThis.getSessionSourceCategory = getSessionSourceCategory;`,
    context,
    { filename: 'static/chat/bootstrap-session-catalog.js' },
  );

  assert.equal(context.getSessionSourceCategory({}), 'chat_ui', 'missing source should count as a normal chat');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'chat' }), 'chat_ui', 'default source should count as a normal chat');
  assert.equal(context.getSessionSourceCategory({ isDelegatedSession: true, sourceId: 'chat' }), 'child', 'delegated sessions should count as sub-sessions');
  assert.equal(context.getSessionSourceCategory({ parentSessionId: 'parent-1' }), 'child', 'sessions with parent ids should count as sub-sessions');
  assert.equal(context.getSessionSourceCategory({ delegatedFromSessionId: 'parent-1' }), 'child', 'legacy delegated metadata should count as sub-sessions');
  assert.equal(context.getSessionSourceCategory({ delegationDepth: 1 }), 'child', 'delegation depth should count as a sub-session');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'automation' }), 'bot', 'automation source should collapse into bots');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'agent-workflow' }), 'bot', 'non-default sources should count as bots');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'chat', isInternalSession: true }), 'bot', 'internal non-child sessions should count as bots');
}

console.log('test-chat-sidebar-filter-options: ok');
