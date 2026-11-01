import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { http } = require('follow-redirects');
let receivedHeader;
const server = createServer((request, response) => {
  if (request.url === '/start') {
    response.writeHead(302, { location: `http://localhost:${server.address().port}/destination` });
    response.end();
    return;
  }
  receivedHeader = request.headers['x-test-private'];
  response.end('ok');
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/start',
      family: 4,
      headers: { 'x-test-private': 'synthetic-test-value' },
      sensitiveHeaders: runInNewContext("['x-test-private']"),
    }, (response) => {
      response.resume();
      response.once('end', resolve);
      response.once('error', reject);
    });
    request.once('error', reject);
  });
  assert.equal(receivedHeader, undefined, 'cross-origin redirects must strip cross-realm sensitive headers');
  console.log('test-redirect-sensitive-headers: ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
