import assert from 'assert';

const { shouldFallbackClaudeBidi } = await import('../chat/claude-bidi-fallback.mjs');

assert.equal(shouldFallbackClaudeBidi({ initialized: false, startedTurn: false, turnActive: false, failureReason: '' }), true);
assert.equal(shouldFallbackClaudeBidi({ initialized: true, startedTurn: false, turnActive: false, failureReason: '' }), false);
assert.equal(shouldFallbackClaudeBidi({ initialized: false, startedTurn: true, turnActive: false, failureReason: '' }), false);
assert.equal(shouldFallbackClaudeBidi({ initialized: false, startedTurn: false, turnActive: false, failureReason: 'Login required' }), false);
assert.equal(shouldFallbackClaudeBidi({ initialized: false, startedTurn: false, turnActive: false, failureReason: '429 rate limit' }), false);
assert.equal(shouldFallbackClaudeBidi({ initialized: false, startedTurn: false, turnActive: false, failureReason: 'Unsupported control request' }), true);
assert.equal(shouldFallbackClaudeBidi({ initialized: false, startedTurn: false, turnActive: false }, { cancelRequested: true }), false);

console.log('test-claude-bidi-fallback-policy: ok');
