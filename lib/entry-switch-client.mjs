// 设备入口切换（介绍人机制）B 侧客户端：
//  B 收到 ?join=<token>&from=<A>&introspect=<A-url> 后的完整消费流程：
//   1. B 用本机实例私钥对 A 做阶段三握手（B 已在 A 登记）→ 5 分钟一次性 Bearer
//   2. 用 Bearer 调 A 的 introspect 端点消费 join-token → 拿到介绍信（A 私钥签名）
//   3. 用【本机清单里登记的 A 公钥】验介绍信签名（信任锚=登记值，不信任响应自报公钥）
//  全部网络调用走注入的 fetchImpl（测试可替换）。
import { buildHandshakeMessage, verifyDeviceSignature } from './device-handshake.mjs';
import { buildIntroMessage } from './entry-switch.mjs';
import { signWithInstanceKey } from './instance-keys.mjs';

export function createEntrySwitchClientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 返回 { ownerId, sourceInstance, targetDevice }；失败抛带 code 的错
export async function consumeEntrySwitchJoin({
  joinToken,
  from,
  introspectUrl,
  deviceId,
  ownerId,
  publicKeyForFrom,   // 本机清单里登记的 A（from）公钥——信任锚
  fetchImpl = fetch,
}) {
  if (!joinToken || !from || !introspectUrl) {
    throw createEntrySwitchClientError('ENTRY_SWITCH_INVALID', 'join, from and introspect are required.');
  }
  if (!deviceId || !ownerId) {
    throw createEntrySwitchClientError('ENTRY_SWITCH_NOT_BOUND', 'This instance has no paired device identity or owner account binding.');
  }
  let baseUrl;
  try {
    const parsed = new URL(introspectUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    baseUrl = parsed;
  } catch {
    throw createEntrySwitchClientError('ENTRY_SWITCH_INVALID', 'introspect must be an http(s) URL.');
  }

  // 1) B 对 A 做阶段三握手：B 私钥签名（含新鲜时间戳）→ 一次性 Bearer
  const timestamp = String(Date.now());
  const signature = await signWithInstanceKey(buildHandshakeMessage({ deviceId, timestamp }));
  const handshakeUrl = new URL('/api/device-handshake', baseUrl);
  const handshakeRes = await fetchImpl(handshakeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, timestamp, signature }),
  });
  if (!handshakeRes.ok) {
    throw createEntrySwitchClientError('HANDSHAKE_FAILED', `Handshake with source instance failed (${handshakeRes.status}).`);
  }
  const { token } = await handshakeRes.json();
  if (!token) {
    throw createEntrySwitchClientError('HANDSHAKE_FAILED', 'Handshake returned no credential.');
  }

  // 2) 消费 join-token，取介绍信
  const introspectEndpoint = new URL('/api/entry-switch/introspect', baseUrl);
  const introspectRes = await fetchImpl(introspectEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ joinToken }),
  });
  const intro = await introspectRes.json().catch(() => ({}));
  if (!introspectRes.ok) {
    throw createEntrySwitchClientError('INTROSPECT_FAILED', `Introspect failed (${introspectRes.status}).`);
  }
  if (!intro.ok || !intro.introSig || !intro.introNonce) {
    throw createEntrySwitchClientError('INTROSPECT_FAILED', 'Introspect response is malformed.');
  }
  if (intro.sourceInstance !== from) {
    throw createEntrySwitchClientError('INTROSPECT_FAILED', 'Introspect source instance mismatch.');
  }
  if (intro.ownerId !== ownerId) {
    throw createEntrySwitchClientError('OWNER_ACCOUNT_MISMATCH', 'The source instance belongs to a different owner account.');
  }

  // 3) 验介绍信：用本机清单登记的 A 公钥（信任锚），不信任响应自报公钥
  if (!publicKeyForFrom) {
    throw createEntrySwitchClientError('SOURCE_NOT_REGISTERED', 'Source device is not registered in this instance.');
  }
  const message = buildIntroMessage({ sourceInstance: from, introNonce: intro.introNonce });
  const valid = verifyDeviceSignature({
    message,
    signature: intro.introSig,
    publicKeyPem: publicKeyForFrom,
  });
  if (!valid) {
    throw createEntrySwitchClientError('INTRO_SIGNATURE_INVALID', 'Introduction signature does not match the registered source device.');
  }

  return { ownerId: intro.ownerId, sourceInstance: intro.sourceInstance, targetDevice: intro.targetDevice };
}
