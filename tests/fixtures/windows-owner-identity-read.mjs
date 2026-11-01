// Disposable guest only; cryptographically validate privately, emit public facts.
import {pathToFileURL} from 'node:url';
const {loadInstanceIdentity,publicInstanceIdentity}=await import(pathToFileURL(process.argv[2]));
const identity=await loadInstanceIdentity({filePath:process.argv[3]});
if(!identity)throw Error('QA_IDENTITY_MISSING');
const value=publicInstanceIdentity(identity);
if(value.instanceId!=='inst_'+value.keyFingerprint.slice(0,32))throw Error('QA_IDENTITY_FINGERPRINT_MISMATCH');
console.log(JSON.stringify({instanceId:value.instanceId,keyFingerprint:value.keyFingerprint,algorithm:value.algorithm}));
