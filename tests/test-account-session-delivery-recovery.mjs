import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createOwnerAuthBroker} from '../accounts/owner-auth-broker.mjs';
import {buildAccountSessionMessage,createDevicePublicKeyFingerprint} from '../lib/device-auth-protocol.mjs';

async function fixture() {
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
  let now=Date.now(),googleCalls=0,state={};
  const store={mutate:async fn=>{const draft=structuredClone(state);const result=await fn(draft);state=draft;return result;}};
  const broker=createOwnerAuthBroker({store,clock:()=>now,
    verifyGoogleCredential:async()=>{googleCalls++;return {sub:'delivery-owner'};},
    resolveAccount:async()=>({accountId:'acct_delivery_owner'}),signAssertion:async()=>''});
  const requestId='request_session_delivery_recovery';
  const challenge=await broker.createAccountSessionChallenge({requestId,device:{deviceId:'adev_delivery_phone',publicKey,platform:'android'}});
  const proof={transactionId:challenge.transactionId,requestId,idToken:'fixture-google-token',
    signature:sign('sha256',Buffer.from(buildAccountSessionMessage({transactionId:challenge.transactionId,requestId,
      deviceId:'adev_delivery_phone',publicKeyFingerprint:createDevicePublicKeyFingerprint(publicKey),nonce:challenge.nonce})),keys.privateKey).toString('base64')};
  const result=await broker.completeAccountSession(proof);
  return {broker,proof,result,state:()=>state,googleCalls:()=>googleCalls,advance:ms=>{now+=ms;}};
}
{
  const f=await fixture();
  assert.deepEqual(await f.broker.completeAccountSession(f.proof),f.result);
  assert.equal(f.googleCalls(),1);assert.equal(f.state().accountCredentials.length,1);
  assert.equal(JSON.stringify(f.state()).includes(f.result.credential.token),false);
  await assert.rejects(f.broker.completeAccountSession({...f.proof,signature:'tampered'}),{code:'owner_auth_account_session_signature_invalid'});
  await assert.rejects(f.broker.completeAccountSession({...f.proof,requestId:'request_other_delivery_recovery'}),{code:'owner_auth_account_session_replay'});
}
{
  const f=await fixture();f.advance(119000);
  assert.deepEqual(await f.broker.completeAccountSession(f.proof),f.result);
  f.advance(1000);
  await assert.rejects(f.broker.completeAccountSession(f.proof),{code:'owner_auth_account_session_consumed'});
  assert.equal(f.state().accountCredentials.length,1,'recovery never resets the original delivery deadline');
}
{
  const f=await fixture();
  await f.broker.logoutAccountSession({credential:f.result.credential.token});
  await assert.rejects(f.broker.completeAccountSession(f.proof),{code:'owner_auth_account_credential_expired'});
}
{
  const f=await fixture();f.state().accountDeviceKeys[0].revokedAt=new Date().toISOString();
  await assert.rejects(f.broker.completeAccountSession(f.proof),{code:'owner_auth_account_device_revoked'});
}
{
  const f=await fixture();f.state().accountDevices[0].revokedAt=new Date().toISOString();
  await assert.rejects(f.broker.completeAccountSession(f.proof),{code:'owner_auth_account_device_revoked'});
}
console.log('PASS session delivery recovery: same proof/credential, no plaintext persistence, wrong proof/request refusal, fixed two-minute window and live logout/key/device revocation');
