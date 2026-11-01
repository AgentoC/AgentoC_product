// Private adapter after createCredentialDispatchReceiver admission only.
// Native launch hashes the exact provider-binding bytes, so preserve the broker's
// canonical ordering. Never forward storage references, paths or caller options.
import {controlRunSnapshotHash} from './restricted-control-run-broker.mjs';
export function credentialProviderWorkerInput({binding,text,snapshot,apiKey}, nativeBinding){
  if(!binding||!nativeBinding||typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>65536
    ||!snapshot||snapshot.harness!=='claude'||snapshot.protocol!=='anthropic-messages'
    ||typeof apiKey!=='string'||!apiKey||Buffer.byteLength(apiKey)>8192||/[\x00-\x1f\x7f]/.test(apiKey)
    ||!['leaseId','runId','requestId','grantId','authorityHash'].every(key=>binding[key]===nativeBinding[key])
    ||!['instanceId','leaseId','runId','expiresAtUnixMs'].every(key=>snapshot[key]===nativeBinding[key]))
    throw Object.assign(new Error('CP_WORKER_BINDING_INVALID'),{code:'CP_WORKER_BINDING_INVALID'});
  const provider=Object.freeze(Object.fromEntries(Object.entries(snapshot).sort(([a],[b])=>a<b?-1:a>b?1:0)));
  // Snapshot contains primitive fields only, validated by the credential receiver.
  return Object.freeze({policy:Object.freeze({...nativeBinding}),frame:Object.freeze({payload:Object.freeze({text})}),
    provider,providerSnapshotHash:controlRunSnapshotHash(snapshot),apiKey});
}
