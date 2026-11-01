const prefix = '/v1/account-pairing/';
const actions = new Set(['register', 'claim', 'inbox', 'approve', 'result', 'revoke']);

export async function handleAccountPairingRoutes({ req, res, pathname, broker }) {
  if (!pathname.startsWith(prefix)) return false;
  const action = pathname.slice(prefix.length);
  const reply = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(value));
  };
  if (!actions.has(action)) { reply(404, { code: 'account_pairing_route_unknown' }); return true; }
  if (req.method !== 'POST') { reply(405, { code: 'account_pairing_method_not_allowed' }); return true; }
  if (!broker) { reply(503, { code: 'account_pairing_unavailable' }); return true; }
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 16 * 1024) { reply(413, { code: 'account_pairing_body_too_large' }); return true; }
      chunks.push(bytes);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || Array.isArray(input) || typeof input !== 'object') throw new SyntaxError('object required');
    reply(action === 'register' ? 201 : 200, await broker[action](input));
  } catch (error) {
    const known = /^(account_pairing|owner_auth_(account_session|desktop_authorization))_[a-z0-9_]+$/.test(error?.code || '');
    reply(known ? error.statusCode || 400 : error instanceof SyntaxError ? 400 : 503,
      { code: known ? error.code : 'account_pairing_request_failed' });
  }
  return true;
}
