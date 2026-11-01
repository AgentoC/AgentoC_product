const prefix = '/v1/temporary-control/';

export async function handleTemporaryControlRoutes({ req, res, pathname, broker }) {
  if (!pathname.startsWith(prefix)) return false;
  const action = pathname.slice(prefix.length);
  const reply = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(value));
  };
  if (!['register', 'claim', 'inbox', 'complete', 'result', 'revoke', 'turn-reserve',
    'connect', 'connection-publish', 'connection-result'].includes(action)) {
    reply(404, { code: 'temporary_control_broker_route_unknown' }); return true;
  }
  if (req.method !== 'POST') { reply(405, { code: 'temporary_control_broker_method_not_allowed' }); return true; }
  if (!broker) { reply(503, { code: 'temporary_control_broker_unavailable' }); return true; }
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 16 * 1024) { reply(413, { code: 'temporary_control_broker_body_too_large' }); return true; }
      chunks.push(bytes);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new SyntaxError('object required');
    reply(action === 'register' ? 201 : 200, await broker[action](body));
  } catch (error) {
    reply(error.statusCode || (error instanceof SyntaxError ? 400 : 503), {
      code: typeof error.code === 'string' && /^temporary_control_(?:broker|credential|proof|invalid)_/.test(error.code)
        ? error.code : 'temporary_control_broker_request_failed',
    });
  }
  return true;
}
