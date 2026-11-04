// Status-only requests are read-only and retain the same run/token validation
// as submissions. They must not wait behind a long-running approval for the
// same request key; mutation requests remain serialized.
export function dispatchApprovedActionProposal(options, { queue, execute }) {
  if (typeof queue !== 'function' || typeof execute !== 'function') throw new TypeError('Approved action dispatch is unavailable');
  if (options?.autoInstallStatusOnly === true) return execute(options);
  const value = item => typeof item === 'string' ? item.trim() : '';
  const key = `${value(options?.runId)}:${value(options?.requestKey)}`;
  return queue(key, () => execute(options));
}
