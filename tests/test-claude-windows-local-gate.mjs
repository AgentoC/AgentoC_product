import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32' || process.env.AGENTOC_RUN_CLAUDE_LOCAL_GATE !== '1') {
  console.log('claude-windows-local-gate: skipped (opt-in Windows integration test)'); process.exit(0);
}
const binary = process.env.AGENTOC_TEST_CLAUDE_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('absolute Claude executable required');
const unicodeFixture = process.env.AGENTOC_QA_CLAUDE_UNICODE === '1';
const root = await mkdtemp(path.join(os.tmpdir(), unicodeFixture ? 'agentoc-claude-local-gate-项目 空格-' : 'agentoc-claude-local-gate-'));
const config = path.join(root, 'config');
await mkdir(config);
process.env.AGENTOC_INSTANCE_ROOT = path.join(root, 'instance');
process.env.AGENTOC_CONFIG_DIR = path.join(root, 'instance', 'config');
process.env.AGENTOC_WORK_ROOT_DIR = path.join(root, 'instance', 'workspace');
process.env.AGENTOC_MEMORY_DIR = path.join(root, 'instance', 'memory');
process.env.AGENTOC_PROVIDER_HOMES_DIR = path.join(root, 'instance', 'provider-homes');
process.env.AGENTOC_RUN_SPOOL_DIR = path.join(root, 'instance', 'data', 'chat-runs');
const { buildClaudeBidiArgs } = await import('../chat/adapters/claude-bidi.mjs');
const { buildClaudeBidiApprovalResponseMessage, buildClaudeBidiInitializeMessage, buildClaudeBidiUserMessage, readClaudeBidiApprovalRequest, serializeClaudeBidiMessage } = await import('../chat/claude-bidi-protocol.mjs');
const { createRun, getRun, readRunSpoolRecords } = await import('../chat/runs.mjs');
const { trackClaudeBidiApprovalRequest } = await import('../chat/runner-sidecar.mjs');
const protectedCase = process.env.AGENTOC_QA_CLAUDE_PROTECTED === '1';
const installCase = process.env.AGENTOC_QA_CLAUDE_INSTALL === '1';
const deleteCase = process.env.AGENTOC_QA_CLAUDE_DELETE === '1';
const outsideFileCase = process.env.AGENTOC_QA_CLAUDE_FILE_OUTSIDE === '1';
const dotnetCase = process.env.AGENTOC_QA_CLAUDE_DOTNET === '1';
const guidanceCase = process.env.AGENTOC_QA_CLAUDE_ELEVATION === '1';
const readCase = process.env.AGENTOC_QA_CLAUDE_READ || '';
const outsideCase = deleteCase && process.env.AGENTOC_QA_CLAUDE_DELETE_OUTSIDE === '1';
const reviewCase = protectedCase || outsideCase;
const relativeDelete = deleteCase && process.env.AGENTOC_QA_CLAUDE_DELETE_RELATIVE === '1';
if ((installCase && (protectedCase || deleteCase)) || (reviewCase && relativeDelete) || (outsideCase && protectedCase) || (outsideFileCase && (installCase || deleteCase || protectedCase)) || (dotnetCase && (installCase || deleteCase)) || (guidanceCase && (installCase || deleteCase || dotnetCase || protectedCase || outsideFileCase))) throw new Error('fixture modes are mutually exclusive');
if (readCase && (!['numbered', 'list', 'git-status'].includes(readCase) || installCase || deleteCase || dotnetCase || guidanceCase || protectedCase || outsideFileCase)) throw new Error('invalid read fixture mode');
if ((installCase || deleteCase || dotnetCase || guidanceCase || readCase) && !path.isAbsolute(process.env.AGENTOC_TEST_BASH_BINARY || '')) throw new Error('absolute Git Bash executable required');
const safeDeleteHelper = process.env.AGENTOC_TEST_SAFE_DELETE_BINARY;
if (deleteCase && !path.isAbsolute(safeDeleteHelper || '')) throw new Error('absolute safe deletion helper required');
const installCommand = `winget ${process.env.AGENTOC_QA_CLAUDE_INSTALL_ALIAS === '1' ? 'add' : 'install'} --${process.env.AGENTOC_QA_CLAUDE_INSTALL_QUERY === '1' ? 'query' : 'id'}=Vendor.App --source=winget --scope=user`;
// The admitted-context fixture uses an actually sensitive profile directory,
// rather than injecting an extra protected root directly into gate state.
const protectedRoot = path.join(root, process.env.AGENTOC_QA_BOUND_CONTEXT === '1' ? '.ssh' : 'protected');
if (protectedCase) await mkdir(protectedRoot);
const outsideRoot = outsideCase ? await mkdtemp(path.join(os.tmpdir(), 'agentoc-claude-outside-')) : '';
const outsideFileRoot = outsideFileCase ? await mkdtemp(path.join(os.tmpdir(), 'agentoc-claude-outside-file-')) : '';
const deleteTarget = path.join(outsideCase ? outsideRoot : protectedCase ? protectedRoot : root, unicodeFixture ? '构建 输出' : 'delete-fixture');
const keepFile = path.join(root, 'keep-fixture.txt');
if (deleteCase) {
  await mkdir(deleteTarget);
  await writeFile(path.join(deleteTarget, 'fixture.txt'), 'deletable fixture');
  await writeFile(keepFile, 'keep fixture');
}
const bashTarget = deleteTarget.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
const deleteCommand = `rm -rf '${bashTarget.replace(/'/g, "'\\''")}'`;
const artifact = path.join(outsideFileCase ? outsideFileRoot : protectedCase ? protectedRoot : root, 'fixture.md');
const bashQuote = value => `'${value.replaceAll("'", `'"'"'`)}'`;
if (readCase) await writeFile(artifact, 'local read fixture\n');
if (readCase === 'git-status') execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
const bashArtifact = artifact.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
const bashRoot = root.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
const readCommand = readCase === 'numbered' ? `cat -n ${bashQuote(bashArtifact)}` : readCase === 'git-status' ? 'git status --short' : `ls -lah ${bashQuote(bashRoot)}`;
const powershell = path.join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const dotnetScript = `[System.IO.File]::WriteAllText('${artifact.replaceAll("'", "''")}', 'dotnet fixture'${process.env.AGENTOC_QA_DOTNET_ENCODING === '1' ? ', [System.Text.Encoding]::UTF8' : ''})`;
const dotnetCommand = `${bashQuote(powershell)} -NoProfile -NonInteractive -Command ${bashQuote(dotnetScript)}`;
const guidanceMarker = path.join(root, 'admin-command-ran.txt');
const guidanceAction = process.env.AGENTOC_QA_CLAUDE_ELEVATION_REGISTRY === '1'
  ? "Set-ItemProperty -LiteralPath 'HKLM:\\Software\\AgentoC-Nonexistent-Fixture' -Name Value -Value 1 -WhatIf"
  : "Start-Service -Name 'AgentoC-Nonexistent-Fixture'";
const guidanceScript = `${guidanceAction}; [System.IO.File]::WriteAllText('${guidanceMarker.replaceAll("'", "''")}', 'unexpected')`;
const guidanceCommand = `${bashQuote(powershell)} -NoProfile -NonInteractive -Command ${bashQuote(guidanceScript)}`;
let requests = 0;
let preflights = 0; let submissions = 0; let toolResultObserved = false; let guidanceObserved = false;
const server = createServer((req, res) => {
  let body = ''; req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; if (body.length > 4_000_000) req.destroy(); });
  req.on('end', () => {
    let request; try { request = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    if (installCase && req.url === '/api/internal/approved-actions/propose' && req.method === 'POST') {
      if (req.headers['x-agentoc-approved-action-token'] !== 'fixture-token' || request.actions?.[0]?.command !== installCommand || request.runId !== run.id) { res.writeHead(400).end(); return; }
      if (request.autoInstallPreflight === true) { preflights++; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'automatic_install_preflight', ready: true })); }
      else { submissions++; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'automatic_install', status: 'succeeded' })); }
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
    requests++;
    const tool = requests === 1 || (relativeDelete && requests === 2);
    const toolName = installCase || deleteCase || dotnetCase || guidanceCase || readCase ? 'Bash' : 'Write';
    if (tool && !request.tools?.some((item) => item.name === toolName)) { res.writeHead(400).end(); return; }
    if (!tool && installCase) toolResultObserved ||= JSON.stringify(request.messages || []).includes('Installation completed successfully');
    if (relativeDelete && requests === 2 && !JSON.stringify(request.messages || []).includes('resolve each target against the command working directory')) { res.writeHead(400).end(); return; }
    if (!tool && deleteCase) toolResultObserved ||= JSON.stringify(request.messages || []).includes('deleted');
    if (!tool && guidanceCase) guidanceObserved ||= JSON.stringify(request.messages || []).includes('agentoc_request_actions');
    if (!tool && readCase) toolResultObserved ||= JSON.stringify(request.messages || []).includes(readCase === 'numbered' ? 'local read fixture' : 'fixture.md');
    const message = { id: `msg_fixture_${requests}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const events = [{ type: 'message_start', message }];
    if (tool) {
      const input = JSON.stringify(installCase ? { command: installCommand, description: 'Fixture installation' } : deleteCase
        ? { command: relativeDelete && requests === 1 ? 'rm -rf delete-fixture' : deleteCommand, description: 'Delete fixture' }
        : dotnetCase ? { command: dotnetCommand, description: 'Write isolated fixture' }
        : guidanceCase ? { command: guidanceCommand, description: 'Administrative fixture' }
        : readCase ? { command: readCommand, description: 'Read isolated fixture' } : { file_path: artifact, content: 'local fixture\n' });
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_fixture_${requests}`, name: toolName, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } });
    } else events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture completed.' } });
    events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
  CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_API_KEY: 'fixture', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
  http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', no_proxy: '127.0.0.1,localhost' };
delete env.ANTHROPIC_AUTH_TOKEN;
const mode = process.env.AGENTOC_QA_MODE === 'full-auto' ? 'full-auto' : 'recommended';
const boundContext = process.env.AGENTOC_QA_BOUND_CONTEXT === '1'
  ? await (await import('./fixtures/windows-admitted-context.mjs')).admittedWindowsContext(root, 'claude-local-fixture') : null;
const run = await createRun({ status: { sessionId: 'claude-local-fixture', requestId: 'fixture', state: 'running', tool: 'claude' },
  manifest: { sessionId: 'claude-local-fixture', requestId: 'fixture', folder: root, tool: 'claude', runtimeFamily: 'claude-stream-json-bidi', prompt: 'fixture', options: {} } });
const gateState = { riskMode: mode, permissionMode: 'default', cwd: root, projectRoot: root, turnActive: true, riskContextValid: boundContext?.valid ?? true,
  riskContext: boundContext?.riskContext ?? { platform: 'win32', trustedWorkspaceRoot: root, protectedRoots: protectedCase ? [protectedRoot] : [] }, pendingApprovals: new Map(), autoApprovedMcpRequestIds: new Set() };
if (installCase || deleteCase || dotnetCase || guidanceCase || readCase) env.CLAUDE_CODE_GIT_BASH_PATH = process.env.AGENTOC_TEST_BASH_BINARY;
if (guidanceCase) {
  gateState.windowsManagedActionChannel = true;
  gateState.windowsManagedActionBinding = { runId: run.id };
}
if (installCase) {
  const endpoint = `http://127.0.0.1:${server.address().port}/api/internal/approved-actions/propose`;
  Object.assign(env, { CLAUDE_CODE_GIT_BASH_PATH: process.env.AGENTOC_TEST_BASH_BINARY,
    AGENTOC_APPROVED_ACTIONS_ENDPOINT: endpoint, AGENTOC_APPROVED_ACTIONS_TOKEN: 'fixture-token',
    AGENTOC_APPROVED_ACTIONS_SESSION_ID: 'claude-local-fixture', AGENTOC_APPROVED_ACTIONS_RUN_ID: run.id, AGENTOC_APPROVED_ACTIONS_TURN_ID: 'fixture-turn' });
  gateState.windowsManagedActionChannel = true;
  gateState.windowsManagedActionBinding = { endpoint, token: 'fixture-token', sessionId: 'claude-local-fixture', runId: run.id, turnId: 'fixture-turn' };
}
const child = spawn(binary, buildClaudeBidiArgs({ permissionMode: 'default', model: 'claude-sonnet-4-5', maxTurns: relativeDelete ? 3 : 2 }), { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let errors = ''; child.stderr.on('data', (chunk) => { errors = (errors + String(chunk)).slice(-6000); });
let approvals = 0; let terminal = null; let handlerFailure = null; let gitOwnerReviewObserved = false;
const output = createInterface({ input: child.stdout });
const completed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error(`Claude fixture timed out: ${errors}`)); }, 45000);
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
});
output.on('line', (line) => {
  void (async () => {
    let event; try { event = JSON.parse(line); } catch { return; }
    const approval = readClaudeBidiApprovalRequest(event);
    if (approval) {
      approvals++;
      await trackClaudeBidiApprovalRequest(run.id, gateState, event, child, deleteCase ? { safeDeleteHelperPath: safeDeleteHelper } : {});
      if (readCase === 'git-status' && mode === 'recommended') {
        const current = await getRun(run.id);
        if (current.appServerPendingApprovals?.some((item) => item.approvalId === approval.approvalId)) {
          gitOwnerReviewObserved = true;
          child.stdin.write(serializeClaudeBidiMessage(buildClaudeBidiApprovalResponseMessage(approval, 'deny')));
        }
      }
      if (reviewCase && mode === 'recommended') {
        const current = await getRun(run.id);
        assert.ok(current.appServerPendingApprovals?.some((item) => item.approvalId === approval.approvalId), 'protected operation must wait for the owner');
        // Complete this disposable test as if the owner denied the request.
        child.stdin.write(serializeClaudeBidiMessage(buildClaudeBidiApprovalResponseMessage(approval, 'deny')));
      }
    }
    if (event.type === 'result') { terminal = event; child.stdin.end(); }
  })().catch((error) => { handlerFailure = error; child.kill(); });
});
child.stdin.write(serializeClaudeBidiMessage(buildClaudeBidiInitializeMessage('fixture-init')));
child.stdin.write(serializeClaudeBidiMessage(buildClaudeBidiUserMessage({ text: 'Write the requested fixture.' })));
try {
  const code = await completed;
  if (handlerFailure) throw handlerFailure;
  assert.equal(code, 0, `Claude exited unexpectedly: ${errors}`);
  if (readCase) assert.ok(approvals <= 1, 'read fixture must not emit multiple approvals');
  else assert.equal(approvals, relativeDelete ? 2 : 1, 'real Claude must emit the expected approval requests');
  assert.ok(terminal && !terminal.is_error, 'Claude must finish the turn');
  if (installCase) {
    assert.ok(preflights >= 1, 'sidecar must preflight the controlled install');
    assert.equal(submissions, 1, 'only the mock control service may receive the install request');
    assert.ok(toolResultObserved, 'actual Claude must receive the bridge result');
  } else if (deleteCase) {
    if (reviewCase) assert.equal(await readFile(path.join(deleteTarget, 'fixture.txt'), 'utf8'), 'deletable fixture');
    else await assert.rejects(access(deleteTarget), { code: 'ENOENT' });
    assert.equal(await readFile(keepFile, 'utf8'), 'keep fixture');
    if (!reviewCase) assert.ok(toolResultObserved, 'actual Claude must receive the safe deletion result');
  } else if (guidanceCase) {
    await assert.rejects(access(guidanceMarker), { code: 'ENOENT' });
    assert.ok(guidanceObserved, 'real Claude must receive managed executor guidance');
  } else if (readCase) {
    assert.equal(await readFile(artifact, 'utf8'), 'local read fixture\n');
    if (readCase !== 'git-status' || approvals === 0) assert.ok(toolResultObserved, 'actual Claude must receive the read result');
    if (readCase === 'git-status' && approvals && mode === 'recommended') assert.ok(gitOwnerReviewObserved, 'Git must wait for owner when not auto-approved');
  } else if (protectedCase) await assert.rejects(access(artifact), { code: 'ENOENT' });
  else assert.equal((await readFile(artifact, 'utf8')).replace(/^\uFEFF/, ''), dotnetCase ? 'dotnet fixture' : 'local fixture\n');
  assert.ok(requests >= 2, 'local model must receive the tool result');
  const spool = await readRunSpoolRecords(run.id);
  if (deleteCase && !reviewCase) assert.ok(spool.some((record) => record.json?.reason === 'handle-bound workspace deletion'), 'actual sidecar must use the handle-bound deletion helper');
  else if (guidanceCase) assert.ok(spool.some((record) => record.json?.type === 'agentoc.approval_response' && record.json?.autoDenied === true && record.json?.reason?.includes('agentoc_request_actions')), 'actual sidecar must persist managed executor guidance');
  else if (readCase === 'git-status' && approvals && mode === 'full-auto') assert.ok(spool.some((record) => record.json?.type === 'agentoc.approval_response' && record.json?.autoDenied === true), 'unattended Git request must be denied when not auto-approved');
  else if (!reviewCase && (!readCase || approvals) && readCase !== 'git-status') assert.ok(spool.some((record) => record.json?.type === 'agentoc.approval_response' && record.json?.autoApproved === true), 'actual sidecar must persist the automatic decision');
  else if (reviewCase && mode === 'full-auto') assert.ok(spool.some((record) => record.json?.type === 'agentoc.approval_response' && record.json?.autoDenied === true), 'unattended protected write must be denied');
  if (relativeDelete) assert.ok(spool.some((record) => record.json?.autoDenied === true && record.json?.reason?.includes('resolve each target against the command working directory')), 'relative target must be denied with an actionable retry');
  console.log(`claude-windows-local-gate: ${mode} real CLI ${installCase ? 'controlled install reached mock service' : reviewCase ? 'dangerous operation denied' : deleteCase ? 'handle-bound fixture deletion completed' : guidanceCase ? 'managed executor guidance received' : readCase ? `${readCase} ${approvals ? 'approval observed' : 'read completed without approval request'}` : dotnetCase ? 'trusted PowerShell wrapped file write completed' : outsideFileCase ? 'outside-workspace file write completed' : 'file approval completed'}`);
} finally {
  child.kill(); output.close(); await new Promise((resolve) => server.close(resolve));
  const parent = path.resolve(os.tmpdir()).toLowerCase();
  for (const [target, prefix] of [[root, 'agentoc-claude-local-gate-'], [outsideRoot, 'agentoc-claude-outside-'], [outsideFileRoot, 'agentoc-claude-outside-file-']]) {
    if (!target) continue;
    const resolved = path.resolve(target);
    if (path.dirname(resolved).toLowerCase() !== parent || !path.basename(resolved).startsWith(prefix)) throw new Error('unsafe fixture cleanup target');
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
