export function shouldFallbackClaudeBidi(state, run = {}) {
  if (!state || run?.cancelRequested === true) return false;
  if (state.initialized || state.startedTurn || state.turnActive) return false;
  const reason = String(state.failureReason || '').toLowerCase();
  if (/(auth|login|credential|unauthor|forbidden|quota|rate.?limit|429|billing)/i.test(reason)) return false;
  return true;
}
