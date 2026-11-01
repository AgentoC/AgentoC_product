#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildSessionHierarchyIndex,
  buildSessionHierarchyProjection,
  getSessionParentId,
  isRootSessionMeta,
} from '../chat/session-hierarchy.mjs';

const root = {
  id: 'root',
  sessionPlane: 'user',
  sessionClass: 'ROOT_LEADERSHIP',
};
const manager = {
  id: 'manager',
  sessionPlane: 'organization',
  sessionClass: 'MANAGER',
  parentSessionId: 'root',
  rootSessionId: 'root',
};
const worker = {
  id: 'worker',
  sessionPlane: 'organization',
  sessionClass: 'WORKER',
  parentSessionId: 'manager',
  rootSessionId: 'root',
};
const fork = {
  id: 'fork',
  sessionPlane: 'user',
  forkedFromSessionId: 'root',
  rootSessionId: 'root',
};
const forkOfWorker = {
  id: 'fork-of-worker',
  sessionPlane: 'user',
  forkedFromSessionId: 'worker',
  rootSessionId: 'root',
};
const legacyChild = {
  id: 'legacy-child',
  sessionPlane: 'user',
  delegatedFromSessionId: 'root',
  delegationDepth: 1,
};

assert.equal(getSessionParentId(worker), 'manager');
assert.equal(getSessionParentId(fork), '');

const index = buildSessionHierarchyIndex([root, manager, worker, fork, forkOfWorker, legacyChild]);
assert.deepEqual(index.get(root.id), {
  level: 0,
  category: 'root',
  rootSessionId: 'root',
  parentSessionId: null,
  isRoot: true,
});
assert.equal(index.get(manager.id).level, 1);
assert.equal(index.get(manager.id).category, 'manager');
assert.equal(index.get(manager.id).isRoot, false);
assert.equal(index.get(worker.id).level, 2);
assert.equal(index.get(worker.id).category, 'worker');
assert.equal(index.get(worker.id).rootSessionId, 'root');
assert.deepEqual(index.get(fork.id), {
  level: 0,
  category: 'root',
  rootSessionId: 'root',
  parentSessionId: null,
  isRoot: true,
});
assert.deepEqual(index.get(forkOfWorker.id), {
  level: 2,
  category: 'worker',
  rootSessionId: 'root',
  parentSessionId: null,
  isRoot: false,
});
assert.equal(index.get(legacyChild.id).parentSessionId, 'root');
assert.equal(index.get(legacyChild.id).rootSessionId, 'root');
assert.equal(index.get(legacyChild.id).isRoot, false);
assert.equal(buildSessionHierarchyProjection(fork).isRoot, true, 'fork fallback projection should remain a root');
assert.equal(buildSessionHierarchyProjection({ id: 'detached', rootSessionId: 'root' }).category, 'detached');
assert.equal(isRootSessionMeta(root, index), true);
assert.equal(isRootSessionMeta(worker, index), false);
assert.equal(buildSessionHierarchyProjection({ id: 'standalone' }).isRoot, true);

console.log('test-session-hierarchy: ok');
