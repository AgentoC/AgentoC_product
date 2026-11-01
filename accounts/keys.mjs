// @ts-check
// Accounts 签名密钥环：主 key 签发 assertion，轮换后旧 key 在宽限期内仍出现在
// JWKS 供实例按 kid 校验（旧 assertion 兼容）；宽限期后可安全清理。
// 兼容旧的单 key 文件格式（{ kid, privateKey, publicJwk }），加载时自动迁移为
// ring 格式（{ primaryKid, keys: { [kid]: {...} } }）。
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const KEY_RETIRED_GRACE_MS = 24 * 60 * 60 * 1000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function b64(value) {
  return Buffer.from(value).toString('base64url');
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function writeAtomic(filePath, value, mode = 0o600) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, json(value), { mode });
  await rename(tmp, filePath);
}

function makeKey(clock) {
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const kid = `accounts-${sha256(publicJwk.x).slice(0, 16)}`;
  return {
    kid,
    privateKey,
    publicJwk,
    createdAt: new Date(clock()).toISOString(),
    retiredAt: '',
  };
}

function normalizeRing(value, filePath, clock) {
  if (!value || typeof value !== 'object') throw new Error(`Invalid signing key file: ${filePath}`);
  if (value.keys && typeof value.keys === 'object' && !Array.isArray(value.keys)) {
    const keys = Object.values(value.keys).filter(
      (key) => key && text(key.kid) && text(key.privateKey) && key.publicJwk,
    );
    if (keys.length === 0 || !text(value.primaryKid) || !keys.some((key) => key.kid === value.primaryKid)) {
      throw new Error(`Invalid signing key ring: ${filePath}`);
    }
    return {
      primaryKid: value.primaryKid,
      keys: Object.fromEntries(keys.map((key) => [key.kid, key])),
    };
  }
  if (text(value.kid) && text(value.privateKey)) {
    const key = {
      kid: value.kid,
      privateKey: value.privateKey,
      publicJwk: value.publicJwk,
      createdAt: text(value.createdAt) || new Date(clock()).toISOString(),
      retiredAt: '',
    };
    return { primaryKid: key.kid, keys: { [key.kid]: key } };
  }
  throw new Error(`Unrecognized signing key file: ${filePath}`);
}

/** 加载 key ring；文件不存在时创建首个 key；旧单 key 格式自动迁移并写回。 */
export async function loadOrCreateSigningKeyRing(filePath, { clock = Date.now } = {}) {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const key = makeKey(clock);
    const ring = { primaryKid: key.kid, keys: { [key.kid]: key } };
    await writeAtomic(filePath, ring);
    return ring;
  }
  const parsed = JSON.parse(raw);
  const ring = normalizeRing(parsed, filePath, clock);
  if (!parsed.keys) await writeAtomic(filePath, ring);
  return ring;
}

/** 原子写回 key ring（轮换脚本使用）。 */
export async function saveSigningKeyRing(filePath, ring, { clock = Date.now } = {}) {
  const normalized = normalizeRing(ring, filePath, clock);
  await writeAtomic(filePath, normalized);
  return normalized;
}

/**
 * 轮换：新 key 成为主 key；旧主 key 标记退役（保留宽限期供校验）；
 * 超过宽限期的已退役 key 清理出 ring。
 */
export function rotateSigningKey(ring, { clock = Date.now, graceMs = KEY_RETIRED_GRACE_MS } = {}) {
  const now = clock();
  const current = ring.keys[ring.primaryKid];
  const retained = {};
  for (const key of Object.values(ring.keys)) {
    if (key.retiredAt && now - Date.parse(key.retiredAt) >= graceMs) continue;
    retained[key.kid] = { ...key };
  }
  if (current && !retained[current.kid]?.retiredAt) retained[current.kid].retiredAt = new Date(now).toISOString();
  const next = makeKey(clock);
  retained[next.kid] = next;
  return { primaryKid: next.kid, keys: retained };
}

/** 当前可对外发布的公钥（主 key 在前；宽限期内的退役 key 保留）。 */
export function activePublicKeys(ring, { clock = Date.now, graceMs = KEY_RETIRED_GRACE_MS } = {}) {
  const now = clock();
  return Object.values(ring.keys)
    .filter((key) => !key.retiredAt || now - Date.parse(key.retiredAt) < graceMs)
    .sort((a, b) => Number(a.kid !== ring.primaryKid) - Number(b.kid !== ring.primaryKid));
}

/** 用主 key 签发 assertion。 */
export function signAssertionFactory(ring) {
  return async (claims) => {
    const key = ring.keys[ring.primaryKid];
    if (!key) throw new Error('Accounts signing key ring has no primary key');
    const header = { alg: 'EdDSA', typ: 'JWT', kid: key.kid };
    const encodedHeader = b64(json(header).trim());
    const encodedClaims = b64(json(claims).trim());
    const input = `${encodedHeader}.${encodedClaims}`;
    const signature = sign(null, Buffer.from(input), createPrivateKey(key.privateKey));
    return `${input}.${b64(signature)}`;
  };
}

/** JWKS HTTP handler：返回主 key 与宽限期内退役 key。 */
export function createJwksHandler(ring, { clock = Date.now, graceMs = KEY_RETIRED_GRACE_MS } = {}) {
  return (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    });
    res.end(
      JSON.stringify({
        keys: activePublicKeys(ring, { clock, graceMs }).map((key) => ({
          ...key.publicJwk,
          kid: key.kid,
          alg: 'EdDSA',
          use: 'sig',
        })),
      }),
    );
    return true;
  };
}
