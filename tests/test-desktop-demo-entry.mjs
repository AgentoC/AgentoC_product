import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';

let base;
const broker = {
  canSignInDemoInstances: true,
  beginDesktop: async () => ({ phoneTicket: 'fixture-ticket' }),
  beginPhone: async () => ({ nonce: 'fixture-nonce' }),
};
const server = createServer(async (req, res) => {
  const handled = await handleOwnerAuthRoutes({ req, res, pathname: req.url, broker, publicBaseUrl: base,
    googleWebClientId: 'fixture.apps.googleusercontent.com', allowInsecurePublicBaseUrl: true });
  if (!handled) { res.writeHead(404); res.end(); }
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/owner/google?tx=fixture&bootstrap=fixture&flow=demo`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const next = new URL(response.headers.get('location'));
  assert.equal(next.pathname, '/owner/google/phone');
  assert.equal(next.hash, '#demo-login');
  const form = await fetch(next);
  assert.equal(form.status, 200);
  assert.match(await form.text(), /<form id="demo-login">/);
  console.log('Desktop demo entry reaches the credential form');
} finally { await new Promise((resolve) => server.close(resolve)); }
