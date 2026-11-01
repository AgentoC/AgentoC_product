// HTTP 路由：跨设备 provider refresh lease。
// 与 handleOwnerAuthRoutes 同一请求管线风格：未匹配的路径返回 false，让
// 其他 handler 继续处理。
const REFRESH_LEASE_PATH = /^\/v1\/owner-auth\/refresh-leases\/(acquire|heartbeat|complete|release|status)$/;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function isRefreshLeaseRoute(pathname) {
  return REFRESH_LEASE_PATH.test(pathname.split('?')[0]);
}

export async function handleRefreshLeaseRoutes({
  req,
  res,
  pathname,
  broker,
  audit = () => {},
}) {
  if (!broker) return false;
  const qIndex = pathname.indexOf('?');
  const requestPath = qIndex >= 0 ? pathname.slice(0, qIndex) : pathname;
  const match = REFRESH_LEASE_PATH.exec(requestPath);
  if (!match || req.method !== 'POST') return false;
  const action = match[1];
  try {
    const body = await readJsonBody(req);
    let result;
    switch (action) {
      case 'acquire':
        result = await broker.acquireRefreshLease({ ...body, operation: 'acquire' });
        break;
      case 'heartbeat':
        result = await broker.heartbeatRefreshLease({ ...body, operation: 'heartbeat' });
        break;
      case 'complete':
        result = await broker.completeRefreshLease({ ...body, operation: 'complete' });
        break;
      case 'release':
        // release 语义：设备在上游 refresh 发出之前主动放弃；未指定时按
        // released 处理（与 failed 区分：failed 表示尝试过但失败）。
        result = await broker.completeRefreshLease({
          ...body,
          outcome: trimString(body?.outcome) || 'released',
          operation: 'complete',
        });
        break;
      case 'status':
        result = await broker.statusOfRefreshLease({ ...body, operation: 'status' });
        break;
      default:
        return false;
    }
    jsonResponse(res, 200, result);
    return true;
  } catch (error) {
    audit({ event: 'refresh_lease.error', action, code: error?.code || '' });
    jsonResponse(res, Number(error?.statusCode) || 500, {
      error: 'refresh lease request failed',
      code: error?.code || 'refresh_lease_internal',
    });
    return true;
  }
}
