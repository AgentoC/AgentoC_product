#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  computeSelfProtectionFacts,
  deriveAgentoCSelfProtectionRoots,
  isWithinProtectedRoot,
} from '../chat/self-protection.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

check('POSIX child is inside protected root', isWithinProtectedRoot('/var/lib/agentoc', '/var/lib/agentoc/config', 'linux'));
check('POSIX prefix sibling is outside protected root', !isWithinProtectedRoot('/var/lib/agentoc', '/var/lib/agentoc-evil', 'linux'));
check('Windows drive root preserves root semantics', isWithinProtectedRoot('C:\\', 'C:\\Agentoc\\config', 'win32'));
check('Windows path comparison is case-insensitive', isWithinProtectedRoot('C:\\Agentoc', 'c:\\agentoc\\config', 'win32'));
check('Windows prefix sibling is outside protected root', !isWithinProtectedRoot('C:\\Agentoc', 'C:\\Agentoc-evil', 'win32'));

eq('unmatched target is computed and not protected', computeSelfProtectionFacts({
  canonicalPaths: ['/work/project/file.txt'],
  protectedRoots: [{ label: 'config', path: '/var/lib/agentoc/config' }],
  workspaceRoot: '/work/project',
  platform: 'linux',
}), {
  computed: true,
  matched: false,
  workspaceRecommended: true,
  boundary: 'none',
});

eq('protected target is matched', computeSelfProtectionFacts({
  canonicalPaths: ['C:\\Agentoc\\config\\auth.json'],
  protectedRoots: [{ label: 'config', path: 'C:\\Agentoc' }],
  workspaceRoot: 'C:\\Work',
  platform: 'win32',
}), {
  computed: true,
  matched: true,
  workspaceRecommended: false,
  boundary: 'agentoc-service',
});

eq('unavailable root fails closed', computeSelfProtectionFacts({
  canonicalPaths: ['/var/lib/agentoc/config/auth.json'],
  protectedRoots: [{ label: 'config', path: '/var/lib/agentoc', available: false }],
  workspaceRoot: '/work',
  platform: 'linux',
}), {
  computed: false,
  matched: false,
  workspaceRecommended: false,
  boundary: 'none',
});

const roots = deriveAgentoCSelfProtectionRoots({ platform: 'linux' });
check('Linux self-protection roots include source and config', roots.some((entry) => entry.label === 'agentoc-source')
  && roots.some((entry) => entry.label === 'agentoc-config'));

console.log(`self-protection: ${passed} checks passed`);
