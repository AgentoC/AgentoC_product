import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readBody } from '../lib/utils.mjs';

function fakeRequest(headers = {}) {
  const request = new EventEmitter();
  request.headers = headers;
  request.destroyed = false;
  request.destroy = () => { request.destroyed = true; };
  return request;
}

const oversized = fakeRequest({ 'content-length': '1025' });
const oversizedPromise = readBody(oversized, 1024);
await assert.rejects(oversizedPromise, (error) => error?.code === 'BODY_TOO_LARGE');
assert.equal(oversized.destroyed, true, 'declared oversized requests should be destroyed before reading');

const valid = fakeRequest({ 'content-length': '3' });
const validPromise = readBody(valid, 1024);
valid.emit('data', Buffer.from('ok'));
valid.emit('data', Buffer.from('!'));
valid.emit('end');
assert.equal(await validPromise, 'ok!', 'valid requests should retain the existing body contract');

const chunked = fakeRequest({});
const chunkedPromise = readBody(chunked, 3);
chunked.emit('data', Buffer.from('ab'));
chunked.emit('data', Buffer.from('cd'));
await assert.rejects(chunkedPromise, (error) => error?.code === 'BODY_TOO_LARGE');
assert.equal(chunked.destroyed, true, 'chunked oversized requests should still be stopped while streaming');

console.log('readBody guardrails ok');
