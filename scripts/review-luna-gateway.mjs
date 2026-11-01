#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createReviewResponsesGateway, REVIEW_MODEL } from '../lib/review-responses-gateway.mjs';
import { createReviewProviderAccessReader } from '../lib/review-provider-access.mjs';

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('An operator config file is required');
const bytes = await readFile(path);
if (bytes.length > 16_384) throw new Error('Invalid gateway configuration');
const config = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
if (!['127.0.0.1', '172.18.0.1'].includes(config.listenHost)
    || !Number.isSafeInteger(config.listenPort) || config.listenPort < 1024 || config.listenPort > 65535
    || !config.authFile?.startsWith('/') || !config.brokerSocket?.startsWith('/')) {
  throw new Error('Invalid gateway boundary configuration');
}
const getAccessCredential = createReviewProviderAccessReader({
  authFile: config.authFile, brokerSocket: config.brokerSocket, expectedAccountId: config.expectedAccountId,
});
const server = createReviewResponsesGateway({
  clientKey: config.clientKey, upstreamUrl: config.upstreamUrl, getAccessCredential,
});
server.on('error', () => { console.error('review_gateway_listener_failed'); process.exitCode = 1; });
server.listen(config.listenPort, config.listenHost, () => {
  console.log(JSON.stringify({ event: 'review_gateway_ready', model: REVIEW_MODEL, uid: process.getuid?.() }));
});
function stop() { server.closeAllConnections(); server.close(() => process.exit(0)); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
