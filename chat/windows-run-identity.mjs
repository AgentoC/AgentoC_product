import { isTerminalRunState, updateRun } from './runs.mjs';

// Only the supervisor calls this with its OS-observed token. A resumed run may
// not silently switch user; consumers must still independently probe their own
// token immediately before executing a user-scoped operation.
export async function bindWindowsRunExecutionIdentity(runId, identity, { update = updateRun } = {}) {
  const sid = typeof identity?.sid === 'string' ? identity.sid.trim() : '';
  const isService = typeof identity?.isService === 'boolean' ? identity.isService : null;
  if (!/^S-1-\d+(?:-\d+)+$/i.test(sid)) throw new Error('Windows run execution identity is unavailable');
  let bound = false;
  const run = await update(runId, (current) => {
    if (isTerminalRunState(current.state)) throw new Error('Windows run is no longer active');
    const previous = current.windowsExecutionSid;
    if (previous && (typeof previous !== 'string' || previous.toLowerCase() !== sid.toLowerCase())) throw new Error('Windows run execution identity changed');
    if (isService !== null && typeof current.windowsExecutionIsService === 'boolean' && current.windowsExecutionIsService !== isService) throw new Error('Windows run execution identity changed');
    bound = true;
    if (previous && (isService === null || typeof current.windowsExecutionIsService === 'boolean')) return current;
    return { ...current, windowsExecutionSid: previous || sid, ...(isService === null ? {} : { windowsExecutionIsService: isService }) };
  });
  if (!run || !bound) throw new Error('Windows run not found');
  return sid;
}
