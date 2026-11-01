const PREFIX = '/v1/account-deletion/';
const METHODS = Object.freeze({ challenges: 'createChallenge', confirmations: 'verifyGoogle',
  requests: 'submit', 'receipts/lookup': 'getReceipt' });
export const ACCOUNT_DELETION_BODY_LIMIT = 24 * 1024;

// Receipt and confirmation capabilities belong in JSON bodies, never URLs,
// cookies, generic account credentials, or redirects.
export async function handleAccountDeletionRoutes({ req, res, pathname, service, publicBaseUrl } = {}) {
  if (!String(pathname || '').startsWith(PREFIX)) return false;
  const respond = (status, codeOrBody, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(JSON.stringify(typeof codeOrBody === 'string' ? { code: codeOrBody } : codeOrBody));
  };
  if (pathname.includes('?') || pathname.includes('#')) { respond(400, 'account_deletion_query_forbidden'); return true; }
  const method = Object.hasOwn(METHODS, pathname.slice(PREFIX.length)) ? METHODS[pathname.slice(PREFIX.length)] : null;
  if (!method) { respond(404, 'account_deletion_route_not_found'); return true; }
  if (req.method !== 'POST') { respond(405, 'account_deletion_method_not_allowed', { Allow: 'POST' }); return true; }
  const headers = req.headers || {};
  const origin = headers.origin;
  if ((origin !== undefined && origin !== new URL(publicBaseUrl).origin)
    || (!origin && headers['sec-fetch-site'] === 'cross-site')) {
    respond(403, 'account_deletion_origin_invalid'); return true;
  }
  if (headers.authorization) { respond(400, 'account_deletion_unexpected_authorization'); return true; }
  if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '')) {
    respond(415, 'account_deletion_json_required'); return true;
  }
  if (!service) { respond(503, 'account_deletion_unavailable'); return true; }
  try {
    if (Number(headers['content-length']) > ACCOUNT_DELETION_BODY_LIMIT) {
      respond(413, 'account_deletion_too_large'); return true;
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > ACCOUNT_DELETION_BODY_LIMIT) { respond(413, 'account_deletion_too_large'); return true; }
      chunks.push(data);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { respond(400, 'account_deletion_invalid'); return true; }
    const result = await service[method](input);
    respond(method === 'submit' && !result.recovered ? 201 : 200, result);
  } catch (error) {
    const known = typeof error?.code === 'string' && /^account_deletion_[a-z_]+$/.test(error.code);
    const status = known && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode : 503;
    respond(status, known ? error.code : 'account_deletion_unavailable');
  }
  return true;
}
