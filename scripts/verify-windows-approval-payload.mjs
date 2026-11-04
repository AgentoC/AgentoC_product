import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WINDOWS_APPROVAL_PAYLOAD_FILES = Object.freeze([
  'chat/windows-approval-gate.mjs', 'chat/windows-powershell-ast.mjs', 'chat/windows-powershell-actions.mjs',
  'chat/windows-bash-actions.mjs', 'chat/windows-elevation-guidance.mjs', 'chat/windows-service-control.mjs', 'chat/windows-system-paths.mjs', 'chat/windows-winget-discovery.mjs',
  'chat/windows-managed-auto-install.mjs', 'chat/windows-auto-install-authorization.mjs', 'chat/windows-auto-install-bridge.mjs', 'chat/codex-managed-hook-setup.mjs',
  'chat/windows-user-install-store.mjs', 'chat/windows-user-install-executor.mjs', 'chat/windows-user-install-bridge.mjs', 'chat/windows-run-identity.mjs',
  'lib/windows-execution-identity.mjs', 'lib/windows-owner-identity-paths.mjs', 'lib/windows-job-object.mjs', 'lib/executable-resolution.mjs',
  'scripts/initialize-windows-owner-identity.mjs', 'scripts/windows-job-object-host.cmd', 'scripts/windows-job-object-host.ps1',
  'chat/codex-windows-install-hook.mjs', 'scripts/agentoc-codex-windows-install-hook.mjs',
  'scripts/agentoc-windows-install-bridge.mjs', 'scripts/create-windows-runtime-manifest.mjs',
  'native/windows-privileged-broker/auto_install.go', 'native/windows-privileged-broker/auto_install_windows.go', 'native/windows-privileged-broker/service_control.go', 'native/windows-privileged-broker/service_control_windows.go', 'native/windows-privileged-broker/service_image_pin_windows.go',
  'native/windows-safe-delete/go.mod', 'native/windows-safe-delete/go.sum', 'native/windows-safe-delete/pinned_windows.go',
  'native/windows-safe-delete/tree_windows.go', 'native/windows-safe-delete/cmd/agentoc-safe-delete/main_windows.go',
  'packaging/windows/build-safe-delete.ps1', 'chat/windows-safe-delete-plan.mjs', 'chat/windows-safe-delete-bridge.mjs', 'chat/codex-windows-safe-delete-hook.mjs',
  'packaging/windows/stage-powershell-runtime.ps1', 'packaging/windows/stage-winget-client.ps1',
]);

export async function verifyWindowsApprovalPayload(root) {
  if (!root || !path.isAbsolute(root)) throw new Error('Windows approval payload root must be absolute');
  for (const relative of WINDOWS_APPROVAL_PAYLOAD_FILES) {
    const entry = await lstat(path.join(root, ...relative.split('/'))).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(`Windows approval payload missing required file: ${relative}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyWindowsApprovalPayload(process.argv[2]).then(() => console.log('Windows approval payload inputs verified'), error => {
    console.error(error.message); process.exitCode = 1;
  });
}
