import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const {stdout,stderr}=await exec(process.execPath,['scripts/launch-test-instance.mjs','--ttl','18','--json','--',process.execPath,'tests/fixtures/auth-session-product-server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,timeout:25000,maxBuffer:1024*1024});
const report=JSON.parse(stdout);assert.equal(report.ok,true,stderr);assert.equal(report.cleaned,true);assert.match(report.stdoutTail,/AUTH_SESSION_HTTP_PASS/);assert.doesNotMatch(report.stderrTail,/AUTH_SESSION_HTTP_FAIL/);
console.log('PASS actual product HTTP: legacy migration/refresh/logout, password login, storage refusal without cookie, TCP CLI auth refusal; owned instance cleaned');
