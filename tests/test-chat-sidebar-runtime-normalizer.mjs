import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  if (start < 0) throw new Error(`${functionName} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${functionName} source was not closed`);
}

const bootstrapSource = await readFile(new URL('../static/chat/bootstrap.js', import.meta.url), 'utf8');
const iconsSource = await readFile(new URL('../static/chat/icons.js', import.meta.url), 'utf8');
const normalizerSource = extractFunctionSource(bootstrapSource, 'normalizeSidebarShellMarkup');
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-tabs"><button id="tabSessions">Sessions</button></div>
      <button id="closeSidebar">Back</button>
      <div id="workspacePicker"><button id="workspaceSummaryButton"><span id="workspaceSummaryText">Workspace: Default</span></button><div id="workspacePopover"></div></div>
      <div id="sidebarSearch"><input id="sessionSearchInput"></div>
      <div id="sessionList"></div>
      <div id="agentsPanel"></div>
      <div id="settingsPanel"></div>
      <div id="modelProvidersPanel"></div>
      <div id="harnessesPanel"></div>
      <button id="newSessionBtn">New Session</button>
    </aside>
    <script>${iconsSource}</script>
    <script>${normalizerSource}; window.__normalizeResult = normalizeSidebarShellMarkup(); window.__normalizeAgain = normalizeSidebarShellMarkup();</script>
  </body></html>`);

  const state = await page.evaluate(() => ({
    first: window.__normalizeResult,
    second: window.__normalizeAgain,
    appBars: document.querySelectorAll('#sidebarAppBar').length,
    order: Array.from(document.querySelectorAll('#sidebarPrimaryNav > *')).map((node) => node.id),
    searchParent: document.getElementById('sessionSearchInput')?.closest('#sidebarSearchModeHeader')?.id || '',
    newSessionParent: document.getElementById('newSessionBtn')?.parentElement?.id || '',
    hasFilter: Boolean(document.getElementById('sidebarFilterBtn')),
    filterParent: document.getElementById('sidebarFilterBtn')?.parentElement?.id || '',
    hasAccount: Boolean(document.getElementById('sidebarAccountBtn')),
    hasAgent: Boolean(document.getElementById('sidebarAgentBtn')),
    agentParent: document.getElementById('sidebarAgentBtn')?.parentElement?.id || '',
    agentIcon: Boolean(document.querySelector('#sidebarAgentBtn .sidebar-agent-icon svg')),
    hasSearchIcon: Boolean(document.querySelector('#sidebarSearchBtn svg')),
  }));

  assert.equal(state.first, true);
  assert.equal(state.second, false);
  assert.equal(state.appBars, 1);
  assert.deepEqual(state.order, ['workspacePicker', 'tabSessions']);
  assert.equal(state.searchParent, 'sidebarSearchModeHeader');
  assert.equal(state.newSessionParent, 'sidebarBottomActions');
  assert.equal(state.hasFilter, true);
  assert.equal(state.filterParent, 'sidebarBottomActions');
  assert.equal(state.hasAccount, true);
  assert.equal(state.hasAgent, true);
  assert.equal(state.agentParent, 'sidebarBottomActions');
  assert.equal(state.agentIcon, true);
  assert.equal(state.hasSearchIcon, true);
  console.log('test-chat-sidebar-runtime-normalizer: ok');
} finally {
  await browser.close();
}
