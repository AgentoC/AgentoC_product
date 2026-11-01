// A runtime can be replaced while a background probe is still running.
// Results from the previous filesystem generation must not repopulate the cache.
export function createHarnessVersionProbeCache() {
  const entries = new Map();
  let generation = 0;
  return {
    get(path) { return entries.get(path); },
    generation() { return generation; },
    set(path, value, startedGeneration) {
      if (startedGeneration === generation) entries.set(path, value);
    },
    invalidate() {
      generation += 1;
      entries.clear();
    },
  };
}
