import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const {stdout,stderr}=await promisify(execFile)(process.execPath,['scripts/launch-test-instance.mjs','--ttl','25','--json','--',process.execPath,'tests/fixtures/windows-cli-product-server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,timeout:32000,maxBuffer:1024*1024});
const report=JSON.parse(stdout);assert.equal(report.ok,true,stderr);assert.equal(report.cleaned,true);assert.match(report.stdoutTail,/WINDOWS_CLI_PRODUCT_PASS/);assert.doesNotMatch(report.stderrTail,/WINDOWS_CLI_PRODUCT_FAIL/);
console.log(JSON.stringify(report));
