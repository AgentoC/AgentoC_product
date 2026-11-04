import { createPublicKey } from 'node:crypto';
import { executeWindowsUserInstall } from './windows-user-install-executor.mjs';

// The identity is embedded by the sidecar/hook in the exact approved command;
// it is not accepted from the authorization response or the tool request.
export async function runWindowsUserInstallBridge({ capability, pinnedIdentity, binding, cwd, request }, { execute = executeWindowsUserInstall } = {}) {
  if (!pinnedIdentity || typeof pinnedIdentity.kid !== 'string' || pinnedIdentity.kid !== capability?.kid
      || typeof pinnedIdentity.publicKey !== 'string' || pinnedIdentity.publicKey.length > 1024 || typeof request !== 'function') {
    throw new Error('User installation identity is unavailable');
  }
  let publicKey;
  try { publicKey = createPublicKey(pinnedIdentity.publicKey); } catch { throw new Error('User installation identity is invalid'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('User installation identity is invalid');
  const rpc = async (flag, extra = {}) => {
    const result = await request({ [flag]: true, userInstallCapability: capability, ...extra });
    if (!result || result.kind !== `automatic_user_install_${flag.slice('autoInstallUser'.length).toLowerCase()}`) throw new Error('User installation control response is invalid');
    return result;
  };
  return execute({ capability, binding, riskMode: 'recommended', publicKey, cwd, expectedOwnerSid: capability.windowsExecutionSid, platform: process.platform }, {
    assertActive: async () => { if ((await rpc('autoInstallUserCheck')).ok !== true) throw new Error('Run is no longer active'); },
    claim: async () => rpc('autoInstallUserClaim'),
    finish: async ({ status, code }) => { if ((await rpc('autoInstallUserFinish', { userInstallResult: { status, code } })).ok !== true) throw new Error('User installation outcome was not recorded'); },
  });
}
