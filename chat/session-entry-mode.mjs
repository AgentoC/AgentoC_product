export const SESSION_ENTRY_MODE_READ = 'read';
export const SESSION_ENTRY_MODE_RESUME = 'resume';

export function normalizeSessionEntryMode(value, { allowDefault = false } = {}) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === SESSION_ENTRY_MODE_READ) {
    return SESSION_ENTRY_MODE_READ;
  }
  if (allowDefault && normalized === SESSION_ENTRY_MODE_RESUME) {
    return SESSION_ENTRY_MODE_RESUME;
  }
  return '';
}

export function resolveSessionEntryMode(value) {
  return normalizeSessionEntryMode(value) || SESSION_ENTRY_MODE_RESUME;
}
