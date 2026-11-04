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

// Legacy installAuto is classified by the Unix-oriented batch classifier and
// is not evidence of Windows install eligibility. The Windows managed install
// path separately authenticates and validates supported installs. Any legacy
// leftovers must be visible as owner-review items (or denied by an unattended
// profile), not represented as an automatically approved installation.
export function deferWindowsLegacyInstallBatch(batch, platform = process.platform) {
  if (platform !== 'win32' || !batch || !Array.isArray(batch.installAuto) || batch.installAuto.length === 0) return batch;
  return { ...batch, installAuto: [], other: [
    ...(Array.isArray(batch.other) ? batch.other : []),
    ...batch.installAuto.map((op) => ({ ...op, deferredFromInstall: true })),
  ] };
}
