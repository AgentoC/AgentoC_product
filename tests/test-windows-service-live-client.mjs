import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsPrivilegedBrokerClient } from '../chat/windows-privileged-broker.mjs';
import { windowsServiceOwnerSigningBytes, windowsServiceReviewSigningBytes } from '../chat/windows-service-grant.mjs';
import { buildApprovedAction } from '../chat/approved-actions.mjs';
import { prepareApprovedActionSemanticProjection } from '../chat/approved-action-semantic.mjs';
import { submitOrResumeWindowsServiceProposal, queryWindowsServiceProposal } from '../chat/windows-service-proposal.mjs';

const fixtureDir = process.env.AGENTOC_BROKER_LIVE_CLIENT_DIR;
if (process.platform !== 'win32' || !fixtureDir) {
  console.log('windows-service-live-client: skipped (opt-in Windows live broker fixture)');
  process.exit(0);
}
const dir = path.resolve(fixtureDir);
const relative = path.relative(path.resolve(os.tmpdir()), dir);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
    !path.basename(dir).startsWith('service-qa-')) throw new Error('Invalid live broker fixture directory');

async function waitForFixture() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path.join(dir, 'ready.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Live broker fixture did not become ready');
}
let succeeded = false;
try {
  const fixture = await waitForFixture();
  assert.match(fixture.pipe, /^\\\\\.\\pipe\\AgentoC\.PrivilegedBroker\.LocalTest\.[a-f0-9]+\.Request$/);
  const fixtureGrant = fixture.proposal?.serviceControl;
  assert.ok(fixtureGrant && fixture.approval?.requestId === fixtureGrant.requestId);
  // The production ServiceHost bridge supplies an impersonation-capable pipe
  // token. Node's direct named-pipe sockets do not, so this fixture uses the
  // same Windows pipe impersonation level against the isolated test pipe.
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const pipeName = fixture.pipe.slice('\\\\.\\pipe\\'.length);
  const healthPipeName = fixture.healthPipe?.slice('\\\\.\\pipe\\'.length);
  if (healthPipeName) assert.match(healthPipeName, /^AgentoC\.PrivilegedBroker\.LocalTest\.[a-f0-9]+\.Health$/);
  const exchangeScript = `
    $ErrorActionPreference='Stop'
    $p=[IO.Pipes.NamedPipeClientStream]::new('.', $env:AGENTOC_QA_PIPE, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Impersonation)
    try {
      $p.Connect(5000)
      $body=[Convert]::FromBase64String($env:AGENTOC_QA_REQUEST)
      $header=[BitConverter]::GetBytes([uint32]$body.Length)
      $p.Write($header,0,4); $p.Write($body,0,$body.Length); $p.Flush()
      $header=[byte[]]::new(4); $offset=0
      while($offset -lt 4){$n=$p.Read($header,$offset,4-$offset);if($n -le 0){throw 'Short header'};$offset+=$n}
      $length=[BitConverter]::ToUInt32($header,0);if($length -eq 0 -or $length -gt 65536){throw 'Invalid frame'}
      $body=[byte[]]::new($length);$offset=0
      while($offset -lt $body.Length){$n=$p.Read($body,$offset,$body.Length-$offset);if($n -le 0){throw 'Short frame'};$offset+=$n}
      [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
      [Console]::Write([Text.Encoding]::UTF8.GetString($body))
    } finally {$p.Dispose()}`;
  const client = createWindowsPrivilegedBrokerClient({ platform: 'win32', pipeExchange: async ({ pipe, request }) =>
    JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', exchangeScript], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, AGENTOC_QA_PIPE: pipe === 'health' ? healthPipeName : pipeName, AGENTOC_QA_REQUEST: Buffer.from(JSON.stringify(request)).toString('base64') },
    })) });
  let grant = fixtureGrant;
  let decisionSignature = fixture.approval.deviceSignature;
  let controlPlaneOptions;
  let deviceKey;
  let proposal;
  if (fixture.testSignerKey && fixture.testDeviceKey && healthPipeName) {
    const context = { sessionId: 'js-session', runId: 'js-run', turnId: 'js-turn', requestKey: 'js-request',
      platform: 'win32', cwd: dir, projectRoot: dir, home: dir };
    const action = buildApprovedAction({ command: `Start-Service ${fixtureGrant.serviceName}` }, context);
    const projection = await prepareApprovedActionSemanticProjection({ action, trustedContext: context,
      resolverOptions: { windowsFactsProvider: { name: 'live-broker', serviceFacts: args => client.inspectService(args) } } });
    const privateKey = createPrivateKey({ key: Buffer.from(fixture.testSignerKey, 'base64'), format: 'der', type: 'pkcs8' });
    controlPlaneOptions = { action, projection, riskMode: 'recommended', authenticatedPrincipalKind: 'owner',
      client, kid: 'test-key', privateKey, assertActive: async () => {} };
    proposal = await submitOrResumeWindowsServiceProposal(controlPlaneOptions);
    assert.equal(proposal.duplicate, false);
    assert.equal((await submitOrResumeWindowsServiceProposal(controlPlaneOptions)).duplicate, true);
    assert.equal((await queryWindowsServiceProposal(controlPlaneOptions)).status, 'awaiting_device');
    deviceKey = createPrivateKey({ key: Buffer.from(fixture.testDeviceKey, 'base64'), format: 'der', type: 'pkcs8' });
  } else {
    proposal = await client.proposeServiceControl({ grant, signature: fixture.proposal.signature });
  }
  assert.equal(proposal.status, 'awaiting_device');
  const pending = await client.pendingServiceControls({ deviceId: fixture.approval.deviceId });
  const review = pending.items.find(item => item.grant.requestId === proposal.requestId);
  assert.ok(review);
  if (controlPlaneOptions) {
    grant = review.grant;
    decisionSignature = sign('sha256', windowsServiceOwnerSigningBytes(grant), deviceKey).toString('base64');
  } else assert.deepEqual(review.grant, grant);
  const publicKey = createPublicKey({ key: Buffer.from(review.brokerPublicKey, 'base64'), type: 'spki', format: 'der' });
  assert.equal(verify('sha256', windowsServiceReviewSigningBytes(grant), publicKey, Buffer.from(review.brokerSignature, 'base64')), true);
  const approval = await client.approveServiceControl({ requestId: grant.requestId,
    deviceId: fixture.approval.deviceId, deviceSignature: decisionSignature });
  assert.ok(['executing', 'succeeded'].includes(approval.status));
  let status;
  const deadline = Date.now() + 15_000;
  do {
    status = await client.status(grant.requestId);
    if (status.status === 'succeeded') break;
    assert.equal(status.status, 'executing');
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(status.status, 'succeeded');
  assert.equal((await client.approveServiceControl({ requestId: grant.requestId,
    deviceId: fixture.approval.deviceId, deviceSignature: decisionSignature })).status, 'succeeded');
  if (controlPlaneOptions) assert.equal((await queryWindowsServiceProposal(controlPlaneOptions)).status, 'succeeded');
  succeeded = true;
  console.log(`windows-service-live-client: ${controlPlaneOptions ? 'control-plane proposal and ' : ''}signed pending, approval, execution and replay verified through real broker pipe`);
} finally {
  const temporary = path.join(dir, 'result.json.tmp');
  await writeFile(temporary, JSON.stringify({ success: succeeded, ...(succeeded ? {} : { error: 'Node client test failed' }) }), { flag: 'wx' });
  await rename(temporary, path.join(dir, 'result.json'));
}
