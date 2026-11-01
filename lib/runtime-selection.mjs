import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { UI_RUNTIME_SELECTION_FILE } from './config.mjs';
import { assertWorkbenchExecution } from './workbench-execution-policy.mjs';

let pendingWrite = Promise.resolve();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeReasoningKind(value) {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'toggle' || normalized === 'enum') {
    return normalized;
  }
  return 'none';
}

export function normalizeUiRuntimeSelection(value = {}) {
  return {
    selectedTool: trimString(value.selectedTool),
    selectedModel: trimString(value.selectedModel),
    selectedProviderProfile: trimString(value.selectedProviderProfile),
    selectedEffort: trimString(value.selectedEffort),
    selectedServiceTier: trimString(value.selectedServiceTier) === 'fast' ? 'fast' : 'standard',
    thinkingEnabled: value.thinkingEnabled === true,
    reasoningKind: normalizeReasoningKind(value.reasoningKind),
    updatedAt: trimString(value.updatedAt) || new Date().toISOString(),
  };
}

export async function loadUiRuntimeSelection(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath || UI_RUNTIME_SELECTION_FILE, 'utf8'));
    const normalized = normalizeUiRuntimeSelection(raw);
    return normalized.selectedTool ? normalized : null;
  } catch {
    return null;
  }
}

export async function saveUiRuntimeSelection(value = {}) {
  assertWorkbenchExecution({ agentType: value.selectedTool || '', ...(value.selectedModel ? { model: value.selectedModel } : {}) });
  const normalized = normalizeUiRuntimeSelection(value);
  if (!normalized.selectedTool) {
    throw new Error('selectedTool is required');
  }

  pendingWrite = pendingWrite.catch(() => {}).then(async () => {
    await mkdir(dirname(UI_RUNTIME_SELECTION_FILE), { recursive: true });
    const tempPath = `${UI_RUNTIME_SELECTION_FILE}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(tempPath, UI_RUNTIME_SELECTION_FILE);
  });

  await pendingWrite;
  return normalized;
}
