// Claude Code's external OAuth owner state uses the same locked, atomic state
// machine as Codex, but lives in its own file and reason namespace.

import {
  emptyExternalCodexOwnershipState,
  getExternalCodexOwnershipRecord,
  loadExternalCodexOwnershipState,
  normalizeExternalCodexOwnershipState,
  observeExternalCodexOwnership,
  takeoverExternalCodexAccount,
} from './external-codex-ownership.mjs';
import { join } from 'path';

export const EXTERNAL_CLAUDE_OWNERSHIP_VERSION = 1;
export const EXTERNAL_CLAUDE_OWNERSHIP_FILE_NAME = 'external-claude-ownership.json';

export const emptyExternalClaudeOwnershipState = emptyExternalCodexOwnershipState;
export const normalizeExternalClaudeOwnershipState = normalizeExternalCodexOwnershipState;

export function externalClaudeOwnershipFile(configDir) {
  return join(configDir, 'native-provider-runtime', EXTERNAL_CLAUDE_OWNERSHIP_FILE_NAME);
}

export function getExternalClaudeOwnershipRecord(state, accountId) {
  return getExternalCodexOwnershipRecord(state, accountId);
}

export function loadExternalClaudeOwnershipState({ configDir, readFileImpl } = {}) {
  return loadExternalCodexOwnershipState({
    configDir,
    readFileImpl,
    ownershipFileName: EXTERNAL_CLAUDE_OWNERSHIP_FILE_NAME,
    reasonPrefix: 'external-claude',
  });
}

export function observeExternalClaudeOwnership(options = {}) {
  return observeExternalCodexOwnership({
    ...options,
    // Claude keeps the conservative legacy default because its external
    // credentials usually lack a stable account id.
    handoffPolicy: options.handoffPolicy ?? 'explicit',
    ownershipFileName: EXTERNAL_CLAUDE_OWNERSHIP_FILE_NAME,
    reasonPrefix: 'external-claude',
  });
}

export function takeoverExternalClaudeAccount(options = {}) {
  return takeoverExternalCodexAccount({
    ...options,
    ownershipFileName: EXTERNAL_CLAUDE_OWNERSHIP_FILE_NAME,
    reasonPrefix: 'external-claude',
  });
}
