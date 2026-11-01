import { AsyncLocalStorage } from 'node:async_hooks';

const contexts = new AsyncLocalStorage();
export function currentMessageExecution() {
  const value = contexts.getStore();
  return value?.active ? value : null;
}
export function withoutMessageExecution(task) { return contexts.run(null, task); }
/** Only the validated PC continuation installs this context, never wire options. */
export function withMessageExecution(value, task, { authorizeScope } = {}) {
  const context = { ...structuredClone(value), active: true, authorizeScope };
  return contexts.run(context, async () => {
    try { return await task(); } finally { context.active = false; }
  });
}
export function applyMessageExecutionConfiguration(session) {
  const context = currentMessageExecution();
  if (!context || !session || session.id !== context.scope.sessionId) return session;
  const result = { ...session };
  for (const [key, value] of Object.entries(context.configuration)) {
    if (key === 'templatePerMessageSystemPrompt') continue; // Private input, not a Session projection field.
    if (value === null) delete result[key]; else result[key] = structuredClone(value);
  }
  return result;
}
