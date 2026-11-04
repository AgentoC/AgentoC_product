// Run-local activity is a presentation hint; Broker state remains authoritative.
export function activeWindowsServiceRequest(run, now = Date.now()) {
  if (!Number.isFinite(now) || run?.cancelRequested === true ||
      ['completed', 'failed', 'cancelled'].includes(run?.state)) return null;
  const pending = run?.windowsServiceRequests;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return null;
  return Object.values(pending).filter(item => item && ['awaiting_device', 'executing'].includes(item.status) &&
    typeof item.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(item.requestId) &&
    Number.isSafeInteger(item.expiresMs) && item.expiresMs > now && Number.isSafeInteger(item.startedMs) && item.startedMs > 0)
    .sort((a, b) => a.startedMs - b.startedMs)[0] || null;
}
