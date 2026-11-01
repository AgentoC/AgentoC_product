import { accessSync, constants, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function expandSessionFolder(folder) {
  const trimmed = trimString(folder);
  if (!trimmed || trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export function resolveRunnableSessionFolder(folder) {
  const requestedCwd = expandSessionFolder(folder);
  if (isRunnableDirectory(requestedCwd)) {
    return {
      cwd: requestedCwd,
      requestedCwd,
      repaired: false,
      reason: '',
    };
  }

  if (isRunnableDirectory(MANAGED_WORK_ROOT_DIR)) {
    return {
      cwd: MANAGED_WORK_ROOT_DIR,
      requestedCwd,
      repaired: true,
      reason: existsSync(requestedCwd)
        ? 'inaccessible-session-folder-fallback-managed-work-root'
        : 'missing-session-folder-fallback-managed-work-root',
    };
  }

  const fallbackHome = homedir();
  if (isRunnableDirectory(fallbackHome)) {
    return {
      cwd: fallbackHome,
      requestedCwd,
      repaired: true,
      reason: existsSync(requestedCwd)
        ? 'inaccessible-session-folder-fallback-home'
        : 'missing-session-folder-fallback-home',
    };
  }

  throw new Error(`Session folder does not exist on this host: ${requestedCwd}`);
}

function isRunnableDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function normalizeStoredSessionFolder(folder) {
  const trimmed = trimString(folder);
  if (!trimmed) {
    return { folder: trimmed, changed: false };
  }

  const expanded = expandSessionFolder(trimmed);
  if (expanded !== trimmed) {
    return { folder: expanded, changed: true };
  }

  return { folder: trimmed, changed: false };
}
