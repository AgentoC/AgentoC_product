// Leading-edge scheduling: continuous provider writes must not postpone the
// first tick. During a slow tick retain one dirty bit, not a queue of tasks.
export function scheduleLeadingTask(state, task, delayMs = 40, options = {}) {
  if (state.cancelled) return;
  if (state.running) { state.dirty = true; return; }
  if (state.timer) return;
  const setTimer = options.setTimer || setTimeout;
  state.timer = setTimer(async () => {
    state.timer = null;
    if (state.cancelled) return;
    state.running = true;
    state.dirty = false;
    try { await task(); }
    catch (error) {
      if (options.onError) options.onError(error);
      else console.error('[observer] scheduled task failed:', error?.message || String(error));
    } finally {
      state.running = false;
      if (state.dirty && !state.cancelled) scheduleLeadingTask(state, task, 0, options);
    }
  }, Math.max(0, Math.min(1_000, Number(delayMs) || 0)));
  state.timer?.unref?.();
}

export function cancelLeadingTask(state, options = {}) {
  state.cancelled = true;
  if (state.timer) (options.clearTimer || clearTimeout)(state.timer);
  state.timer = null;
}
