import {rename} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';

// Preserve atomic rename: never unlink the destination or copy over it. Windows
// readers/scanners can temporarily deny replacement. Permanent errors still
// propagate after at most 1600 ms backoff; access-denied EACCES is not retried.
export async function renameWithWindowsRetry(source,target,{signal,beforeAttempt,platform=process.platform,renameImpl=rename,
  waitImpl=(ms,signal)=>sleep(ms,undefined,{signal}),jitterImpl=()=>Math.floor(Math.random()*11)}={}){
  const delays=[50,100,200,400,800];
  for(let attempt=0;;attempt++){
    if(signal?.aborted)throw Object.assign(new Error('Atomic replacement aborted'),{code:'ABORT_ERR'});
    beforeAttempt?.();
    try{await renameImpl(source,target);return;}
    catch(error){
      if(platform!=='win32'||!['EPERM','EBUSY'].includes(error?.code)||attempt===delays.length)throw error;
      const jitter=Math.max(0,Math.min(10,Number(jitterImpl())||0));
      await waitImpl(delays[attempt]+jitter,signal);
    }
  }
}
