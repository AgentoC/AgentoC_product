function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function isClaudeThinkingTokenFrame(value) {
  return value?.type === 'system' && value?.subtype === 'thinking_tokens';
}

// Claude Code can emit one cumulative thinking_tokens frame beside nearly
// every thinking token. The matching thinking_delta remains fully retained,
// so keeping every cumulative counter doubles spool traffic without adding
// replay information. Retain the first, at most one current sample per
// interval, and the newest skipped sample at terminal flush.
export function createClaudeThinkingTokenSampler({ intervalMs = 1000 } = {}) {
  const sampleIntervalMs = Math.max(1, finiteNonNegative(intervalMs, 1000));
  let lastPersistedAtMs = null;
  let pending = null;

  return {
    observe(frame, nowMs = Date.now()) {
      if (!isClaudeThinkingTokenFrame(frame)) {
        return { handled: false, persist: true, frame };
      }
      const observedAtMs = finiteNonNegative(nowMs, Date.now());
      pending = frame;
      if (lastPersistedAtMs === null || observedAtMs - lastPersistedAtMs >= sampleIntervalMs) {
        lastPersistedAtMs = observedAtMs;
        pending = null;
        return { handled: true, persist: true, frame };
      }
      return { handled: true, persist: false, frame: null };
    },

    flush() {
      if (!pending) return null;
      const latest = pending;
      pending = null;
      return latest;
    },
  };
}
