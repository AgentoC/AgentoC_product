import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';

export async function readTemporaryClaimKeyRing(filePath) {
  const info = await stat(filePath);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Temporary pairing key file must be private to the Accounts service');
  }
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** Broker-private at-rest encryption, not end-to-end encryption. TLS is still required. */
export function createTemporaryClaimCipher({ activeKeyId, keys } = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(activeKeyId || '') || !keys || Array.isArray(keys)
    || Object.keys(keys).length > 5 || !Object.hasOwn(keys, activeKeyId)) {
    throw new Error('Temporary pairing requires a configured claim encryption key ring');
  }
  const ring = new Map(Object.entries(keys).map(([id, value]) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('Invalid claim encryption key');
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid claim encryption key');
    return [id, key];
  }));
  return {
    seal(token, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', ring.get(activeKeyId), iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return { keyId: activeKeyId, iv: iv.toString('base64url'), data: data.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    },
    open(sealed, context) {
      try {
        const key = ring.get(sealed?.keyId);
        if (!key) throw new Error('unknown key');
        const iv = Buffer.from(sealed.iv, 'base64url'); const tag = Buffer.from(sealed.tag, 'base64url');
        if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid GCM parameters');
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64url')), decipher.final()]).toString('utf8');
      } catch { throw temporaryPairingError('temporary_broker_claim_unavailable', 503); }
    },
  };
}
