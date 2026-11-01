#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const composeSource = readFileSync(join(repoRoot, 'static/chat/compose.js'), 'utf8');
const helperSource = composeSource.match(/function shouldSubmitComposerOnEnter\(event\) \{[\s\S]*?\n\}/)?.[0];

assert.ok(helperSource, 'compose should define a dedicated Enter submission policy');

function createHarness(mobile) {
  const context = {
    window: {
      matchMedia(query) {
        assert.equal(query, '(max-width: 767px)');
        return { matches: mobile };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nthis.shouldSubmitComposerOnEnter = shouldSubmitComposerOnEnter;`, context);
  return context.shouldSubmitComposerOnEnter;
}

const mobilePolicy = createHarness(true);
assert.equal(mobilePolicy({ key: 'Enter', shiftKey: false, isComposing: false }), false, 'mobile Enter should insert a newline instead of sending');

const desktopPolicy = createHarness(false);
assert.equal(desktopPolicy({ key: 'Enter', shiftKey: false, isComposing: false }), true, 'desktop Enter should continue sending');
assert.equal(desktopPolicy({ key: 'Enter', shiftKey: true, isComposing: false }), false, 'desktop Shift+Enter should continue inserting a newline');
assert.equal(desktopPolicy({ key: 'Enter', shiftKey: false, isComposing: true }), false, 'IME composition Enter should not send');
assert.equal(desktopPolicy({ key: 'a', shiftKey: false, isComposing: false }), false, 'non-Enter keys should not send');

assert.match(
  composeSource,
  /sendBtn\.addEventListener\("click", \(\) => sendMessage\(\)\);/,
  'the send button should remain the explicit mobile send path',
);
assert.match(
  composeSource,
  /function handleComposerKeydown\(e\) \{\s*if \(shouldSubmitComposerOnEnter\(e\)\)/,
  'the composer keydown handler should use the device-aware Enter policy',
);
assert.match(
  composeSource,
  /msgInput\.addEventListener\("keydown", handleComposerKeydown\);/,
  'the composer should install the shared Enter policy on the input',
);

console.log('test-chat-mobile-composer-enter: ok');
