#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  createWindowsRuntimeFactsProvider,
  parseWindowsAclFacts,
  parseWindowsArtifactFacts,
  parseWindowsPathFacts,
  parseWindowsServiceFacts,
  revalidateWindowsAclFacts,
  revalidateWindowsPathFacts,
  revalidateWindowsResourceSnapshot,
  revalidateWindowsServiceFacts,
  WINDOWS_POWERSHELL_EXECUTABLE,
} from '../chat/windows-runtime-facts-provider.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}
async function rejects(label, promise, code) {
  await assert.rejects(promise, (error) => {
    eq(`${label} code`, error.code, code);
    return true;
  });
}

const pathIdentity = '00000001:0000000000000001';
const pathOutput = JSON.stringify({
  platform: 'win32',
  canonicalPath: 'C:\\project\\file.txt',
  type: 'file',
  size: 12,
  reparsePoint: false,
  volumeSerial: '00000001',
  fileId: '0000000000000001',
  identity: pathIdentity,
});
const serviceHash = 'a'.repeat(64);
const aclHash = 'b'.repeat(64);

eq('path parser keeps identity', parseWindowsPathFacts(pathOutput).identity, pathIdentity);
await rejects('path parser rejects malformed output', Promise.resolve().then(() => parseWindowsPathFacts('{"platform":"win32"}')), 'WINDOWS_FACTS_OUTPUT_INVALID');
await rejects('path parser rejects ambiguous output', Promise.resolve().then(() => parseWindowsPathFacts(`${pathOutput}\n${pathOutput}`)), 'WINDOWS_FACTS_OUTPUT_INVALID');
await rejects('service parser rejects hash mutation', Promise.resolve().then(() => parseWindowsServiceFacts(JSON.stringify({
  platform: 'win32', manager: 'windows-service', serviceName: 'agentoc', exists: true, definitionHash: 'changed',
}), 'agentoc')), 'WINDOWS_FACTS_OUTPUT_INVALID');
await rejects('ACL parser rejects path mismatch', Promise.resolve().then(() => parseWindowsAclFacts(JSON.stringify({
  platform: 'win32', provider: 'windows-acl', canonicalPath: 'C:\\other', ownerSid: 'S-1-5-18', protected: true, descriptorHash: aclHash,
}), 'C:\\project\\file.txt')), 'WINDOWS_FACTS_OUTPUT_INVALID');

const calls = [];
const provider = createWindowsRuntimeFactsProvider({
  platform: 'win32',
  execFile: async (command, args, options) => {
    calls.push({ command, args, options });
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    if (script.includes('Get-CimInstance')) {
      return { stdout: JSON.stringify({ platform: 'win32', manager: 'windows-service', serviceName: 'agentoc', exists: true, definitionHash: serviceHash }), stderr: '' };
    }
    if (script.includes('Get-Acl')) {
      return { stdout: JSON.stringify({ platform: 'win32', provider: 'windows-acl', canonicalPath: 'C:\\project\\file.txt', ownerSid: 'S-1-5-18', protected: true, descriptorHash: aclHash }), stderr: '' };
    }
    if (script.includes('Get-ChildItem')) {
      return { stdout: JSON.stringify([{ name: 'file.txt', type: 'file', reparsePoint: false }]), stderr: '' };
    }
    if (script.includes('GetFinalPathNameByHandle') && !script.includes('Identity($item.FullName)')) {
      return { stdout: JSON.stringify({ platform: 'win32', canonicalPath: 'C:\\project\\file.txt' }), stderr: '' };
    }
    return { stdout: pathOutput, stderr: '' };
  },
});

const hostilePath = 'C:\\project\\safe.txt;Write-Output INJECTED';
eq('provider canonicalizes via fixed script', await provider.realpath(hostilePath), 'C:\\project\\file.txt');
eq('provider parses fixed stat facts', (await provider.stat(hostilePath)).identity, pathIdentity);
eq('provider parses directory facts', (await provider.readdir('C:\\project'))[0].name, 'file.txt');
eq('provider parses service facts', (await provider.serviceFacts({ serviceName: 'agentoc' })).definitionHash, serviceHash);
eq('provider parses ACL facts', (await provider.aclFacts({ canonicalPath: 'C:\\project\\file.txt' })).descriptorHash, aclHash);
check('provider uses fixed absolute PowerShell', calls.every((call) => call.command === WINDOWS_POWERSHELL_EXECUTABLE));
check('provider disables shell execution', calls.every((call) => call.options.shell === false));
check('dynamic path is passed as an environment value', calls.some((call) => call.options.env.AGENTOC_FACTS_PATH === hostilePath));
check('dynamic path never enters PowerShell source', calls.every((call) => !Buffer.from(call.args.at(-1), 'base64').toString('utf16le').includes(hostilePath)));
check('provider pins no-profile noninteractive mode', calls.every((call) => call.args.includes('-NoProfile') && call.args.includes('-NonInteractive')));
check('provider forces UTF-8 console output encoding before every script',
  calls.every((call) => {
    const decoded = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
    return decoded.startsWith('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8;');
  }));

const malformedProvider = createWindowsRuntimeFactsProvider({
  platform: 'win32',
  execFile: async () => ({ stdout: `${pathOutput}\ntrailing`, stderr: '' }),
});
await rejects('provider rejects malformed command output', malformedProvider.stat('C:\\project\\file.txt'), 'WINDOWS_FACTS_OUTPUT_INVALID');

let pathState = { identity: pathIdentity, mountId: 'volume-1', reparsePoint: false };
const revalidationProvider = {
  async realpath(value) { return value; },
  async stat(value) {
    if (value === 'C:\\project') return { identity: 'parent-1', mountId: 'volume-1', reparsePoint: false };
    return { ...pathState };
  },
  async serviceFacts() { return { platform: 'win32', manager: 'windows-service', serviceName: 'agentoc', exists: true, definitionHash: serviceHash }; },
  async aclFacts() { return { platform: 'win32', provider: 'windows-acl', canonicalPath: 'C:\\project\\file.txt', ownerSid: 'S-1-5-18', protected: true, descriptorHash: aclHash }; },
};
const pathSnapshot = {
  canonical: 'C:\\project\\file.txt', identity: pathIdentity, mountId: 'volume-1', reparsePoint: false, expectedParentIdentity: 'parent-1',
};
check('unchanged path passes execution revalidation', (await revalidateWindowsPathFacts(pathSnapshot, { provider: revalidationProvider })).ok);
pathState = { ...pathState, identity: 'changed-file-id' };
check('identity change fails execution revalidation', !(await revalidateWindowsPathFacts(pathSnapshot, { provider: revalidationProvider })).ok);
pathState = { identity: pathIdentity, mountId: 'volume-2', reparsePoint: false };
check('volume change fails execution revalidation', !(await revalidateWindowsPathFacts(pathSnapshot, { provider: revalidationProvider })).ok);
pathState = { identity: pathIdentity, mountId: 'volume-1', reparsePoint: true };
check('reparse change fails execution revalidation', !(await revalidateWindowsPathFacts(pathSnapshot, { provider: revalidationProvider })).ok);

pathState = { identity: pathIdentity, mountId: 'volume-1', reparsePoint: false };
check('unchanged service passes execution revalidation', (await revalidateWindowsServiceFacts({ serviceName: 'agentoc', definitionHash: serviceHash }, { provider: revalidationProvider })).ok);
const changedServiceProvider = { ...revalidationProvider, async serviceFacts() { return { platform: 'win32', manager: 'windows-service', serviceName: 'agentoc', exists: true, definitionHash: 'c'.repeat(64) }; } };
check('service definition hash change fails revalidation', !(await revalidateWindowsServiceFacts({ serviceName: 'agentoc', definitionHash: serviceHash }, { provider: changedServiceProvider })).ok);
check('unchanged ACL passes execution revalidation', (await revalidateWindowsAclFacts({ canonicalPath: 'C:\\project\\file.txt', descriptorHash: aclHash, ownerSid: 'S-1-5-18' }, { provider: revalidationProvider })).ok);
const changedAclProvider = { ...revalidationProvider, async aclFacts() { return { platform: 'win32', provider: 'windows-acl', canonicalPath: 'C:\\project\\file.txt', ownerSid: 'S-1-5-18', protected: true, descriptorHash: 'c'.repeat(64) }; } };
check('ACL descriptor hash change fails revalidation', !(await revalidateWindowsAclFacts({ canonicalPath: 'C:\\project\\file.txt', descriptorHash: aclHash }, { provider: changedAclProvider })).ok);
check('resource snapshot revalidation fails closed without provider', !(await revalidateWindowsResourceSnapshot({ paths: [pathSnapshot] })).ok);

// Artifact facts (MSI revalidation): digest must be a sha256 hex, else fail closed.
check('artifact digest parses a sha256 hex', (await parseWindowsArtifactFacts(JSON.stringify({ exists: true, digest: 'a'.repeat(64) }))).digest === 'a'.repeat(64));
let artifactRejected = false;
try { parseWindowsArtifactFacts(JSON.stringify({ exists: false, error: 'missing' })); } catch { artifactRejected = true; }
check('artifact digest fails closed when unavailable', artifactRejected);
let artifactBadHash = false;
try { parseWindowsArtifactFacts(JSON.stringify({ exists: true, digest: 'not-a-hash' })); } catch { artifactBadHash = true; }
check('artifact digest fails closed on malformed hash', artifactBadHash);

console.log(`windows-runtime-facts-provider: ${passed} checks passed`);
