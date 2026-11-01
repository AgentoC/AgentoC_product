// Durable ordering helpers for account-scoped AgY Run queues.

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function queuedTimestamp(run) {
  return Date.parse(trimString(run?.agyQueue?.queuedAt))
    || Date.parse(trimString(run?.createdAt))
    || Number.MAX_SAFE_INTEGER;
}

export function sortAgyQueuedRuns(entries = []) {
  return [...entries].sort((left, right) => (
    queuedTimestamp(left?.candidate) - queuedTimestamp(right?.candidate)
      || String(left?.candidate?.id || '').localeCompare(String(right?.candidate?.id || ''))
  ));
}
