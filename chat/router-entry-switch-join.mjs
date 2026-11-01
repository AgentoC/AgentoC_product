// 设备入口切换（介绍人机制）B 端入口：
//  B 收到 GET /?join=<token>&from=<A>&introspect=<A-url> —— 一次性介绍消费：
//   回调 A 握手+introspect → 验介绍信（本机清单登记的 A 公钥）→ 签发 B 实例 owner 会话 → 302 首页
//  失败一律 302 /login?error=join_invalid（"切换链接失效，请重新发起"）。
import { getDevicePublicKey } from '../lib/device-public-key-registry.mjs';
import { getCrossDeviceOwnerIdentity } from '../lib/owner-identity.mjs';
import { consumeEntrySwitchJoin } from '../lib/entry-switch-client.mjs';
import { issueSession, setCookie } from '../lib/auth.mjs';

function getSingleQueryValue(value) {
  return Array.isArray(value) ? (value[0] || '') : String(value || '');
}

export async function handleEntrySwitchJoin({ req, res, parsedUrl }) {
  const query = parsedUrl?.query || {};
  const joinToken = getSingleQueryValue(query.join).trim();
  if (!joinToken || parsedUrl?.pathname !== '/') return false;
  const from = getSingleQueryValue(query.from).trim();
  const introspectUrl = getSingleQueryValue(query.introspect).trim();
  const deviceId = getSingleQueryValue(query.device).trim();

  const redirectToLogin = () => {
    res.writeHead(302, { Location: '/login?error=join_invalid' });
    res.end();
  };

  try {
    const ownerIdentity = await getCrossDeviceOwnerIdentity();
    if (!ownerIdentity) {
      redirectToLogin();
      return true;
    }
    if (!deviceId) {
      redirectToLogin();
      return true;
    }
    const publicKeyForFrom = await getDevicePublicKey(from);
    const result = await consumeEntrySwitchJoin({
      joinToken,
      from,
      introspectUrl,
      deviceId,
      ownerId: ownerIdentity.id,
      publicKeyForFrom,
      fetchImpl: fetch,
    });
    const sessionToken = await issueSession({
      role: 'owner',
      authMethod: 'introduced',
      sourceInstance: result.sourceInstance,
    });
    if (!sessionToken) throw new Error('Failed to issue session');
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': setCookie(sessionToken),
      'Cache-Control': 'no-store',
    });
    res.end();
  } catch {
    redirectToLogin();
  }
  return true;
}
