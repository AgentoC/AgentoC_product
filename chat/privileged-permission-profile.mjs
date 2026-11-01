// Pure profile decision for the existing privileged batch channel. Execution
// and every per-operation authorization check still happen in the executor.
export function resolvePrivilegedBatchPolicy(riskMode, platform = process.platform) {
  if (riskMode === 'conservative-auto') {
    return { install: 'deny', other: 'deny', delete: 'deny' };
  }
  if (riskMode === 'full-auto') {
    return platform === 'win32'
      ? { install: 'deny', other: 'deny', delete: 'deny' }
      : { install: 'execute', other: 'deny', delete: 'deny' };
  }
  return { install: 'execute', other: 'wait_owner', delete: 'wait_owner' };
}
