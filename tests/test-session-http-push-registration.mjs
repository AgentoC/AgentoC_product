#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

const setupStart = sessionHttpSource.indexOf('async function setupPushNotifications()');
if (setupStart === -1) throw new Error('Missing setupPushNotifications');
const setupSnippet = `${sessionHttpSource.slice(setupStart)}\nglobalThis.setupPushNotifications = setupPushNotifications;`;

function createHarness({ existingSubscription }) {
  const fetchCalls = [];
  const subscriptionPayload = { endpoint: existingSubscription ? 'https://push.example/existing' : 'https://push.example/new' };
  const subscribeCalls = [];
  const registration = {
    update() {
      return Promise.resolve();
    },
    installing: { postMessage() {} },
    waiting: { postMessage() {} },
    active: { postMessage() {} },
    pushManager: {
      getSubscription() {
        return Promise.resolve(existingSubscription
          ? {
              toJSON() {
                return subscriptionPayload;
              },
            }
          : null);
      },
      subscribe(options) {
        subscribeCalls.push(options);
        return Promise.resolve({
          toJSON() {
            return subscriptionPayload;
          },
        });
      },
    },
  };
  const context = {
    console,
    JSON,
    Promise,
    encodeURIComponent,
    buildAssetVersion: 'build-test',
    visitorMode: false,
    navigator: {
      serviceWorker: {
        register() {
          return Promise.resolve(registration);
        },
        ready: Promise.resolve(registration),
      },
    },
    window: {
      PushManager: function PushManager() {},
    },
    fetch(url, options = {}) {
      fetchCalls.push({ url, options });
      if (url === '/api/push/vapid-public-key') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ publicKey: 'BEl6Y3Rlc3RLZXk' }),
        });
      }
      if (url === '/api/push/subscribe') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    urlBase64ToUint8Array(value) {
      return value;
    },
  };
  vm.runInNewContext(setupSnippet, context, { filename: 'setupPushNotifications.vm' });
  return {
    fetchCalls,
    subscribeCalls,
    setupPushNotifications: context.setupPushNotifications,
  };
}

const existingHarness = createHarness({ existingSubscription: true });
await existingHarness.setupPushNotifications();
assert.equal(existingHarness.subscribeCalls.length, 0, 'existing subscriptions should not request a new browser subscription');
assert.equal(existingHarness.fetchCalls.length, 1, 'existing subscriptions should still sync back to the backend');
assert.equal(existingHarness.fetchCalls[0].url, '/api/push/subscribe');
assert.deepEqual(JSON.parse(existingHarness.fetchCalls[0].options.body), {
  endpoint: 'https://push.example/existing',
}, 'existing subscription sync should post the current subscription payload');

const freshHarness = createHarness({ existingSubscription: false });
await freshHarness.setupPushNotifications();
assert.equal(freshHarness.subscribeCalls.length, 1, 'missing subscriptions should request a new browser subscription');
assert.deepEqual(freshHarness.fetchCalls.map((entry) => entry.url), [
  '/api/push/vapid-public-key',
  '/api/push/subscribe',
], 'fresh subscriptions should fetch the VAPID key and persist the new subscription');
assert.deepEqual(JSON.parse(freshHarness.fetchCalls[1].options.body), {
  endpoint: 'https://push.example/new',
}, 'new subscription sync should post the subscribed payload');

console.log('test-session-http-push-registration: ok');
