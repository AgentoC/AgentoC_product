// Device public keys used by the cross-device entry-switch trust handshake.
// This registry is independent from owner authentication and provider OAuth.
import { join } from 'path';
import { CONFIG_DIR } from './config.mjs';
import { readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

export const DEVICE_PUBLIC_KEYS_FILE = join(CONFIG_DIR, 'device-public-keys.json');

function createRegistryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readRegistry() {
  const value = await readJson(DEVICE_PUBLIC_KEYS_FILE, null);
  return value && typeof value === 'object' && Array.isArray(value.devices)
    ? value
    : { version: 1, devices: [] };
}

async function writeRegistry(registry) {
  await writeJsonAtomic(DEVICE_PUBLIC_KEYS_FILE, registry, { mode: 0o600 });
}

export async function registerDevicePublicKey({ deviceId, publicKey, ownerId }) {
  if (!deviceId || !publicKey || !ownerId) {
    throw createRegistryError('device_public_key_invalid', 'deviceId, publicKey and ownerId are required.');
  }
  const registry = await readRegistry();
  const now = new Date().toISOString();
  const existing = registry.devices.find((entry) => entry.deviceId === deviceId);
  if (existing) {
    Object.assign(existing, { ownerId, publicKey, lastSeenAt: now });
  } else {
    registry.devices.push({
      deviceId,
      ownerId,
      publicKey,
      boundAt: now,
      lastSeenAt: now,
    });
  }
  await writeRegistry(registry);
  return { deviceId };
}

export async function getDevicePublicKey(deviceId) {
  const registry = await readRegistry();
  const entry = registry.devices.find((item) => item.deviceId === deviceId);
  return entry?.publicKey || null;
}
