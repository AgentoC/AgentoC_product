#!/usr/bin/env node

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWeChatLoginProcess } from '../lib/wechat-connector-login.mjs';

const root = await mkdtemp(join(tmpdir(), 'agentoc-wechat-login-spawn-'));

try {
  const windowsRoot = join(root, 'windows');
  const windowsCalls = [];
  let windowsUnrefCalled = false;
  const windowsChild = new EventEmitter();
  windowsChild.pid = 61234;
  windowsChild.unref = () => { windowsUnrefCalled = true; };
  const windowsPidPath = join(windowsRoot, 'login.pid');
  const windowsLogPath = join(windowsRoot, 'login-run.log');

  const windowsPid = await spawnWeChatLoginProcess({
    platform: 'win32',
    configDir: join(windowsRoot, 'config'),
    connectorDir: join(windowsRoot, 'connector'),
    connectorConfigPath: join(windowsRoot, 'connector', 'config.json'),
    loginPidPath: windowsPidPath,
    loginLogPath: windowsLogPath,
    projectRoot: 'C:\\agentoc',
    loginScriptPath: 'C:\\agentoc\\scripts\\wechat-connector.mjs',
    returnChildProcess: true,
    spawnManagedImpl: async (spec, options) => {
      windowsCalls.push({ spec, options });
      return windowsChild;
    },
  });

  assert.equal(windowsPid, windowsChild);
  assert.equal(windowsUnrefCalled, true);
  assert.equal(await readFile(windowsPidPath, 'utf8'), '61234\n');
  assert.equal(windowsCalls.length, 1);
  assert.deepEqual(windowsCalls[0].spec, {
    file: process.execPath,
    args: [
      'C:\\agentoc\\scripts\\wechat-connector.mjs',
      'login',
      '--config',
      join(windowsRoot, 'connector', 'config.json'),
      '--force',
    ],
    cwd: 'C:\\agentoc',
    env: {
      ...process.env,
      AGENTOC_CONFIG_DIR: join(windowsRoot, 'config'),
    },
    shell: false,
  });
  assert.deepEqual(windowsCalls[0].options, {
    detached: true,
    preserveOnControllerExit: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  windowsChild.emit('exit', 0, null);

  const posixRoot = join(root, 'posix');
  const posixCalls = [];
  const posixChild = new EventEmitter();
  posixChild.pid = 61235;
  const posixPid = await spawnWeChatLoginProcess({
    platform: 'linux',
    configDir: join(posixRoot, 'config'),
    connectorDir: join(posixRoot, 'connector'),
    connectorConfigPath: join(posixRoot, 'connector', 'config.json'),
    loginPidPath: join(posixRoot, 'login.pid'),
    loginLogPath: join(posixRoot, 'login-run.log'),
    projectRoot: '/srv/agentoc',
    loginScriptPath: '/srv/agentoc/scripts/wechat-connector.mjs',
    spawnManagedImpl: async (spec, options) => {
      posixCalls.push({ spec, options });
      return posixChild;
    },
  });

  assert.equal(posixPid, 61235);
  assert.equal(posixCalls[0].options.detached, true);
  assert.equal(posixCalls[0].options.preserveOnControllerExit, true);
  assert.deepEqual(posixCalls[0].options.stdio.slice(0, 1), ['ignore']);
  assert.equal(typeof posixCalls[0].options.stdio[1], 'number');
  assert.equal(typeof posixCalls[0].options.stdio[2], 'number');
  posixChild.emit('exit', 0, null);

  console.log('test-wechat-login-managed-spawn: Windows worker uses preserved managed lifecycle; POSIX log-fd contract remains intact');
} finally {
  await rm(root, { recursive: true, force: true });
}
