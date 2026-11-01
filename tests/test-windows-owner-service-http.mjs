import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
assert.equal(process.platform,'win32','Actual Windows product service test: CI runs this entry only on Windows.');
for(const mode of ['positive','refuse-context','activation']){
  let stdout,stderr;try{({stdout,stderr}=await promisify(execFile)(process.execPath,['scripts/launch-test-instance.mjs','--ttl','25','--json','--',process.execPath,'tests/fixtures/windows-owner-service-product.mjs',mode],{cwd:new URL('..',import.meta.url),windowsHide:true,timeout:32000,maxBuffer:1024*1024}));}catch(error){stdout=error.stdout||'';stderr=error.stderr||String(error);}
  const report=JSON.parse(stdout);console.log(JSON.stringify(report));assert.equal(report.ok,true,stderr);assert.equal(report.cleaned,true);assert.match(report.stdoutTail,/OWNER_SERVICE_PRODUCT_PASS/,report.stderrTail);assert.doesNotMatch(report.stderrTail,/OWNER_SERVICE_PRODUCT_FAIL/);
  assert.match(report.stdoutTail,/SERVICE_AUTH_CLOSED/);
  if(mode!=='refuse-context')assert.ok(report.stdoutTail.indexOf('SERVICE_OWNER_DRAINED_BEFORE_AUTH_CLOSE')<report.stdoutTail.indexOf('SERVICE_AUTH_CLOSED'));
  else assert.match(report.stderrTail,/OSV_CONTEXT_REFUSED/);
  if(mode==='activation')assert.match(report.stdoutTail,/OWNER_ACTIVATION_HTTP_SQLITE_PASS/);
}
