// Account-level permission policy (account-level permission mode).
//
// The owner can pick an account-wide default. An unset record uses full-auto;
// older explicit full-auto/approval records keep their original meaning. The value is the default risk
// posture for sessions created without an explicit riskMode; it never
// overrides an explicit per-session or per-message selection. Instances of
// the same account converge on this value through the account-sync
// 'runtime-policy' scope.
//
// This module performs file I/O only for the local policy file. It never
// touches sessions, runs, or provider processes.

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { UI_ACCOUNT_POLICY_FILE } from './config.mjs';

export const ACCOUNT_PERMISSION_POLICIES = Object.freeze({
  FULL_AUTO: 'full-auto',
  APPROVAL: 'approval',
  CONSERVATIVE_AUTO: 'conservative-auto',
});

export const DEFAULT_ACCOUNT_PERMISSION_POLICY = ACCOUNT_PERMISSION_POLICIES.FULL_AUTO;

export const ACCOUNT_POLICY_SYNC_SCOPE = 'runtime-policy';
export const ACCOUNT_POLICY_SYNC_KEY = 'permission-policy';

// Mapping to the session risk-mode vocabulary (chat/session-manager.mjs).
// 'approval' intentionally resolves to 'recommended': routine work is
// auto-answered while danger-tier operations hold for owner approval.
export const ACCOUNT_POLICY_RISK_MODES = Object.freeze({
  [ACCOUNT_PERMISSION_POLICIES.FULL_AUTO]: 'full-auto',
  [ACCOUNT_PERMISSION_POLICIES.APPROVAL]: 'recommended',
  [ACCOUNT_PERMISSION_POLICIES.CONSERVATIVE_AUTO]: 'conservative-auto',
});

let pendingWrite = Promise.resolve();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAccountPermissionPolicy(value) {
  const normalized = trimString(value).toLowerCase();
  return Object.values(ACCOUNT_PERMISSION_POLICIES).includes(normalized) ? normalized : '';
}

export function normalizeAccountPolicyRecord(value = {}) {
  return {
    permissionPolicy: normalizeAccountPermissionPolicy(value.permissionPolicy),
    updatedAt: trimString(value.updatedAt),
  };
}

export function accountPolicyToSessionRiskMode(policy) {
  const normalized = normalizeAccountPermissionPolicy(policy);
  return ACCOUNT_POLICY_RISK_MODES[normalized || DEFAULT_ACCOUNT_PERMISSION_POLICY];
}

export async function loadAccountPolicy(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath || UI_ACCOUNT_POLICY_FILE, 'utf8'));
    return normalizeAccountPolicyRecord(raw);
  } catch {
    return normalizeAccountPolicyRecord({});
  }
}

export async function loadAccountPermissionPolicy(filePath) {
  return (await loadAccountPolicy(filePath)).permissionPolicy;
}

export async function saveAccountPolicy(value = {}, filePath) {
  const current = await loadAccountPolicy(filePath);
  const next = normalizeAccountPolicyRecord({
    ...current,
    ...value,
    updatedAt: new Date().toISOString(),
  });
  const targetPath = filePath || UI_ACCOUNT_POLICY_FILE;

  pendingWrite = pendingWrite.catch(() => {}).then(async () => {
    await mkdir(dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tempPath, targetPath);
  });

  await pendingWrite;
  return next;
}
