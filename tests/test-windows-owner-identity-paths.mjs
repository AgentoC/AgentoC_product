import assert from 'node:assert/strict';
import { ownerIdentityPathForService } from '../lib/windows-owner-identity-paths.mjs';

const env = { ProgramData: 'D:\\Shared Data', AGENTOC_INSTANCE_ROOT: 'd:\\shared data\\AgentoC\\instances\\owner',
  AGENTOC_CONFIG_DIR: 'D:\\Shared Data\\AgentoC\\instances\\owner\\config' };
assert.equal(ownerIdentityPathForService(env), 'D:\\Shared Data\\AgentoC\\instances\\owner\\config\\instance-identity.json');
assert.equal(ownerIdentityPathForService({ ...env, AGENTOC_CONFIG_DIR: 'D:\\other' }), null);
assert.equal(ownerIdentityPathForService({ ...env, AGENTOC_INSTANCE_ROOT: 'C:\\ProgramData\\AgentoC\\instances\\owner' }), null);
assert.equal(ownerIdentityPathForService({ ...env, ProgramData: '\\\\server\\share' }), null);
assert.equal(ownerIdentityPathForService({ ...env, ProgramData: 'relative' }), null);
console.log('windows-owner-identity-paths: checks passed');
