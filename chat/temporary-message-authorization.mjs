import { getTemporaryPairingHost } from './temporary-pairing-runtime.mjs';

/** Private Run continuation boundary; never called from phone-supplied identity headers. */
export async function authorizeTemporaryMessage(binding, session, { host } = {}) {
  if (binding?.principalKind !== 'temporary_device') return;
  return (host || await getTemporaryPairingHost()).authorizeStoredMessage(binding.temporaryAuthority, session);
}
