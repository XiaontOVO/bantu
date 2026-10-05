// Use the configured official provider read-only; all accounts/posts live in MemoryStateStore.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {ModelSettings} from '../dist/src/services/model-settings.js';
import {createHttpServer} from '../dist/src/server/http-server.js';
import {MemoryStateStore} from '../dist/src/persistence/state-store.js';

const configuration='data/model-settings.json';
const fingerprint=()=>createHash('sha256').update(readFileSync(configuration)).digest('hex');
const before=fingerprint(),manager=new ModelSettings(configuration),model=manager.provider;
assert.ok(model,'The configured official provider must be available.');
const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:model});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const proof={testedAt:new Date().toISOString(),isolatedMemoryServer:true,configuredModel:manager.view().modelName,officialConfigurationReadOnly:true};
const request=async(path,cookie,body)=>{
  const response=await fetch(base+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal(response.status,200,`Unexpected HTTP status at ${path}`);return (await response.json()).data;
};
const account=async username=>{
  const guest=(await fetch(base+'/api/v1/session/guest',{method:'POST'})).headers.get('set-cookie').split(';')[0];
  const response=await fetch(base+'/api/v1/account/register',{method:'POST',headers:{cookie:guest,'content-type':'application/json'},body:JSON.stringify({username,password:'12345678'})});
  assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
};
try{
  const author=await account('isolated_private_author'),reader=await account('isolated_private_reader');
  const preview=await request('agent/chat',author,{text:'帮我发布一篇私密帖子，仅自己可见。第一行是标题：安静的午后。正文：今天在书院休息了一会儿，记下这段旅途。请保留标题和正文，不要公开。',clientMessageId:'official-private-preview'});
  proof.previewTools=preview.agent?.steps?.map(step=>({tool:step.tool,ok:step.ok})) || [];
  assert.match(preview.assistantMessage.text,/仅自己可见|不会公开/,'The frozen preview must show private visibility.');
  assert.equal((await request('community/mine',author)).posts.length,0,'Preview must not publish.');
  assert.equal((await request('community/posts',reader)).length,0);
  proof.privatePreview=true;
  const reply=await request('agent/chat',author,{text:'确认发布',clientMessageId:'official-private-confirm'});
  proof.confirmationTools=reply.agent?.steps?.map(step=>({tool:step.tool,ok:step.ok})) || [];
  const posts=(await request('community/mine',author)).posts;
  assert.equal(posts.length,1,'One confirmation must create exactly one post.');
  const post=posts[0];assert.equal(post.visibility,'private');assert.equal(post.text.split('\n')[0],'安静的午后');
  assert.match(post.text,/今天在书院休息了一会儿，记下这段旅途/);
  assert.equal((await request('community/posts',reader)).length,0);
  assert.equal((await fetch(base+'/api/v1/community/posts/'+post.id,{headers:{cookie:reader}})).status,404);
  assert.equal((await request('community/posts/'+post.id,author)).visibility,'private');
  assert.ok(reply.assistantMessage.resultLinks?.some(link=>link.postId===post.id),'The private receipt must lead to the author-owned post.');
  proof.privatePublication=true;proof.titlePreserved=true;proof.crossAccountReadBlocked=true;proof.authorResultLink=true;proof.passed=true;
}catch(error){proof.passed=false;proof.errorKind=error.name;proof.errorCode=error.code || null;process.exitCode=1;}
finally{
  proof.officialConfigUnchanged=fingerprint()===before;assert.ok(proof.officialConfigUnchanged);
  writeFileSync('tmp/agent-private-post-real-model-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
