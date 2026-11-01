// Product Windows CLI bridge. Installed/native trust owns helper, purpose and
// peer pins. Never pass a Run/HTTP/environment path or policy into that boundary.
import { requestInstalledOwnerBootstrap, requestInstalledOwnerActivation } from './windows-owner-bootstrap.mjs';

export const WINDOWS_OWNER_CLI_BASE_URL = 'http://127.0.0.1:7690';
const typed = code => Object.assign(new Error(code), { code });

export function isWindowsOwnerCliTarget(baseUrl) {
  return baseUrl === WINDOWS_OWNER_CLI_BASE_URL || baseUrl === WINDOWS_OWNER_CLI_BASE_URL + '/';
}

export async function requestWindowsCliOwnerCookie({ baseUrl, signal } = {}) {
  if (!isWindowsOwnerCliTarget(baseUrl)) throw typed('CLI_OWNER_TARGET_REFUSED');
  await requestInstalledOwnerActivation({ signal });
  const result = await requestInstalledOwnerBootstrap({ signal });
  if (result?.baseUrl !== WINDOWS_OWNER_CLI_BASE_URL
    || typeof result.sessionToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.sessionToken)) {
    throw typed('CLI_OWNER_RESULT_INVALID');
  }
  return 'session_token=' + result.sessionToken;
}
