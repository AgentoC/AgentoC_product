import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'agentoc-prompt-language-'));
Object.assign(process.env,{HOME:root,AGENTOC_INSTANCE_ROOT:root,AGENTOC_MEMORY_DIR:path.join(root,'memory'),AGENTOC_WORK_ROOT_DIR:path.join(root,'workspace'),AGENTOC_PLATFORM_SKILLS_DIR:path.join(root,'skills')});
try {
 const {buildSystemContext}=await import('../chat/system-prompt.mjs');
 const context=await buildSystemContext({sessionId:'english-language-acceptance'});
 assert.doesNotMatch(context,/\p{Script=Han}/u);
 assert.match(context,/Answer English messages in English/);
 assert.match(context,/default to English/);
 const starter=await import('../chat/starter-session-content.mjs');
 for(const key of ['WELCOME_STARTER_SYSTEM_PROMPT','WELCOME_STARTER_MESSAGE','CREATE_AGENT_STARTER_SYSTEM_PROMPT','CREATE_AGENT_STARTER_MESSAGE']) {
  assert.equal(typeof starter[key],'string');assert.doesNotMatch(starter[key],/\p{Script=Han}/u,key);
 }
 console.log('PASS built-in generated system context and starter prompts contain no Han characters; current user language takes precedence.');
} finally {await fs.rm(root,{recursive:true,force:true});}
