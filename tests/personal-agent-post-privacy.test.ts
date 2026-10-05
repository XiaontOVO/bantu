import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { modelTurn, toolCall } from '../src/providers/model.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { prepareCommunityAction, confirmCommunityAction, confirmCommunityActionWithDirectory } from '../src/services/personal-agent-community-actions.js';
import { communityPostVisibilityTools, postPublishVisibility } from '../src/services/personal-agent-post-visibility.js';
import { agentPostResultLinks } from '../src/services/personal-agent-result-links.js';

test('private publishing survives a missing model field, confirmation and restart without becoming public',async()=>{
  const store=new MemoryStateStore();let phase=0;
  const options={seedDemo:false,stateStore:store,modelProvider:{providerName:'privacy-fixture',modelName:'fixture',async generateTurn(input:any){
    assert.ok(input.tools.some((tool:any)=>tool.name==='community.post_publish'));
    if(phase++===0)return modelTurn([toolCall('private-post','community.post_publish',{title:'私人的旅行记录',text:'今天在书院安静休息。'})]);
    return modelTurn([],'已完成。');
  }}};
  const ctx=createServerContext(options);ctx.accounts.register('private_author','12345678','author');ctx.accounts.register('private_reader','12345678','reader');
  const preview=await runPersonalAgent(ctx,'author','发布一篇私密帖子，标题“私人的旅行记录”，正文“今天在书院安静休息。”',[]);
  assert.match(preview.reply,/可见范围：仅自己可见/);assert.match(preview.reply,/标题：私人的旅行记录/);
  assert.equal(ctx.communityService.mine('author').posts.length,0);
  const approval=ctx.personalAgentTasks.pendingAction('author')!.pendingAction!;
  assert.throws(()=>confirmCommunityAction(ctx,'reader',approval as any),/其他账号/);
  const restored=createServerContext(options);
  const receipt=await runPersonalAgent(restored,'author','确认发布',[]);
  assert.match(receipt.reply,/仅自己可见|已完成/);
  const post=restored.communityService.mine('author').posts[0];assert.equal(post.visibility,'private');
  assert.equal(post.text,'私人的旅行记录\n今天在书院安静休息。');
  assert.equal(restored.communityService.listPosts('reader').length,0);assert.equal(restored.communityService.postDetail(post.id,'reader'),null);
  assert.equal(restored.communityService.postSnapshot(post.id,'reader'),null);
});

test('private intent rejects a model public override and invalid visibility',()=>{
  assert.equal(postPublishVisibility(undefined,'发布private帖子'),'private');
  assert.equal(postPublishVisibility(undefined,'发帖，不公开，仅自己可见'),'private');
  assert.equal(postPublishVisibility(undefined,'发布公开帖子'),'public');
  assert.equal(postPublishVisibility('public','把这篇私密帖改为公开'),'public');
  assert.throws(()=>postPublishVisibility('public','不要取消私密，只有自己可见'),/没有发布/);
  assert.throws(()=>postPublishVisibility('public','发布私密帖子'),/没有发布/);
  assert.throws(()=>postPublishVisibility('friends','发布帖子'),/请选择/);
});

test('quoted title and body topics do not change visibility while explicit range instructions remain binding',()=>{
  for(const request of [
    '发布一个公开帖子，内容是“私密空间的建筑体验”',
    '发布一个帖子，标题“Private club”，正文“不要公开的建筑空间值得一看”',
    '发布一个公开帖子，标题「只有我可见」，正文『private空间的公开展览』',
    '发布一个帖子，标题是Private club，正文是私密空间的建筑体验',
  ]){
    assert.equal(postPublishVisibility('public',request),'public',request);
    assert.equal(postPublishVisibility(undefined,request),'public',request);
  }
  for(const request of [
    '发布私密帖子，正文“公开场所的参观感受”',
    '发布一个帖子，内容是“public建筑体验”，不要公开，仅自己可见',
    '发布帖子，可见范围：“private”，标题“公开小径”，正文“私密空间”',
    '把这篇帖子设为“仅自己可见”',
    'private',
  ]){
    assert.equal(postPublishVisibility(undefined,request),'private',request);
    assert.throws(()=>postPublishVisibility('public',request),/没有发布/,request);
  }
  assert.throws(()=>postPublishVisibility(undefined,'发布一个公开帖子，但不要公开，只有自己可见'),/要求有矛盾/);
  assert.throws(()=>postPublishVisibility('private','发布一个公开帖子，正文“私密空间的建筑体验”'),/用户要求公开/);
});

test('runtime preserves quoted privacy topics in an explicitly public post and does not silently make it private',async()=>{
  let phase=0;
  const ctx=createServerContext({seedDemo:false,modelProvider:{providerName:'quoted-privacy-fixture',modelName:'fixture',async generateTurn(){
    return phase++===0?modelTurn([toolCall('public-topic','community.post_publish',{title:'Private空间的建筑体验',text:'不要公开的空间是一种设计主题。',visibility:'public'})]):modelTurn([],'已完成。');
  }}});
  ctx.accounts.register('quoted_public_author','12345678','author');
  const preview=await runPersonalAgent(ctx,'author','发布一个公开帖子，标题“Private空间的建筑体验”，正文“不要公开的空间是一种设计主题。”',[]);
  assert.match(preview.reply,/可见范围：公开/);assert.match(preview.reply,/标题：Private空间的建筑体验/);
  assert.equal(ctx.communityService.listPosts('reader').length,0);
  await runPersonalAgent(ctx,'author','确认发布',[]);
  const post=ctx.communityService.listPosts('reader')[0];assert.ok(post);assert.equal(post.visibility,'public');
  assert.equal(post.text,'Private空间的建筑体验\n不要公开的空间是一种设计主题。');
});

test('publication preview binds visibility; tampering and old unlabelled approvals cannot publish',()=>{
  const ctx=createServerContext({seedDemo:false});ctx.accounts.register('preview_author','12345678','author');
  const original=prepareCommunityAction(ctx,'author','post_publish',{text:'秘密标题\n私人正文',visibility:'private'});
  const altered=structuredClone(original);altered.data.visibility='public';
  const refreshed=confirmCommunityAction(ctx,'author',altered);assert.equal(refreshed.completed,false);assert.match(refreshed.pending!.prompt,/可见范围：公开/);
  assert.equal(ctx.communityService.mine('author').posts.length,0);
  const old=structuredClone(original);delete old.data.visibility;
  assert.throws(()=>confirmCommunityAction(ctx,'author',old),/未包含可见范围/);
  assert.equal(ctx.communityService.mine('author').posts.length,0);
  const completed=confirmCommunityAction(ctx,'author',original);assert.equal(completed.completed,true);assert.match(completed.reply,/仅自己可见/);
  assert.equal(ctx.communityService.mine('author').posts[0].visibility,'private');
  const publicPreview=prepareCommunityAction(ctx,'author','post_publish',{text:'公开标题\n公开正文'});
  assert.match(publicPreview.prompt,/可见范围：公开/);assert.equal(ctx.communityService.listPosts('reader').length,0);
  confirmCommunityAction(ctx,'author',publicPreview);assert.equal(ctx.communityService.listPosts('reader').length,1);
});

test('confirmation cancellation belongs to its conversation and cannot inherit an old default task cancellation',async()=>{
  const ctx=createServerContext({seedDemo:false});ctx.accounts.register('cancel_author','12345678','author');
  const old=ctx.personalAgentTasks.start('author',[]);ctx.personalAgentTasks.cancel('author',old.id);old.status='completed';
  const current=ctx.personalAgentTasks.start('author',[],'another-dialogue');
  const approval=prepareCommunityAction(ctx,'author','post_publish',{text:'对话内的私人记录',visibility:'private'});
  const result=await confirmCommunityActionWithDirectory(ctx,'author',approval,'another-dialogue');assert.equal(result.completed,true);
  ctx.personalAgentTasks.cancel('author',current.id,'another-dialogue');
  const stopped=prepareCommunityAction(ctx,'author','post_publish',{text:'停止后不得写入',visibility:'private'});
  await assert.rejects(confirmCommunityActionWithDirectory(ctx,'author',stopped,'another-dialogue'),/已停止/);
  assert.equal(ctx.communityService.mine('author').posts.length,1);
});

test('visibility changes require owner and current preview and remove foreign favourite snapshots',async()=>{
  const ctx=createServerContext({seedDemo:false});ctx.accounts.register('change_author','12345678','author');ctx.accounts.register('change_reader','12345678','reader');
  const post=ctx.communityService.publishPost('author',{text:'原标题\n原正文'},'作者');
  ctx.favoritesService.addPost('reader',ctx.communityService.postSnapshot(post.id,'reader')!);
  let approval:any;const tool=communityPostVisibilityTools(ctx,'author',pending=>{approval=pending})[0];
  tool.run({postId:post.id,expectedVisibility:'public',visibility:'private'});
  assert.match(approval.prompt,/当前可见范围：公开/);assert.match(approval.prompt,/修改后：仅自己可见/);assert.match(approval.prompt,/确认修改/);
  assert.equal(ctx.communityService.postDetail(post.id,'reader')?.visibility,'public');
  assert.throws(()=>confirmCommunityAction(ctx,'reader',approval),/其他账号/);
  assert.throws(()=>communityPostVisibilityTools(ctx,'reader',()=>{})[0].run({postId:post.id,expectedVisibility:'public',visibility:'private'}),/自己/);
  confirmCommunityAction(ctx,'author',approval);
  assert.equal(ctx.communityService.postDetail(post.id,'reader'),null);assert.equal(ctx.favoritesService.listPosts('reader').length,0);
  assert.equal(ctx.communityService.postDetail(post.id,'author')?.text,'原标题\n原正文');
  assert.throws(()=>communityPostVisibilityTools(ctx,'author',()=>{},()=> '把帖子设为私密')[0].run({postId:post.id,expectedVisibility:'private',visibility:'public'}),/没有发布/);
  const receipt=[{role:'tool' as const,toolName:'community.post_visibility',content:JSON.stringify({ok:true,result:{completed:true,result:{id:post.id}}})}];
  assert.equal(agentPostResultLinks(ctx,'author',receipt)[0].postId,post.id);
  assert.deepEqual(agentPostResultLinks(ctx,'reader',receipt),[]);
  assert.deepEqual(agentPostResultLinks(ctx,'author',[{...receipt[0],content:JSON.stringify({ok:true,result:{completed:false,result:{id:post.id}}})}]),[]);
  tool.run({postId:post.id,expectedVisibility:'private',visibility:'public'});const stale=approval;
  ctx.communityService.updatePostVisibility('author',post.id,'public');
  assert.throws(()=>confirmCommunityAction(ctx,'author',stale),/已有更新/);
  assert.throws(()=>tool.run({postId:post.id,expectedVisibility:'private',visibility:'public'}),/已有更新/);
});

test('controlled HTTP Agent private publish and visibility confirmation are isolated by conversation and account',async()=>{
  let calls=0;
  const server=createHttpServer({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:'http-privacy-fixture',modelName:'fixture',async generateTurn(input:any){
    calls++;const last=input.messages.filter((message:any)=>message.role==='user').at(-1)?.content || '';
    const visibilityReceipt=input.messages.find((message:any)=>message.role==='tool'&&message.toolName==='community.post_visibility');
    const publishReceipt=input.messages.find((message:any)=>message.role==='tool'&&message.toolName==='community.post_publish');
    if(last.startsWith('把这个帖')){
      if(!visibilityReceipt){const match=last.match(/POST=(\S+)/);assert.ok(match);return modelTurn([toolCall('visibility','community.post_visibility',{postId:match[1],expectedVisibility:'private',visibility:'public'})]);}
    }else if(!publishReceipt)return modelTurn([toolCall('publish','community.post_publish',{title:'隔离标题',text:'隔离正文',visibility:'private'})]);
    return modelTurn([],'操作已处理。');
  }}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const guest=async()=>(await fetch(base+'/api/v1/session/guest',{method:'POST'})).headers.get('set-cookie')!.split(';')[0];
  const register=async(username:string)=>{const response=await fetch(base+'/api/v1/account/register',{method:'POST',headers:{cookie:await guest(),'content-type':'application/json'},body:JSON.stringify({username,password:'12345678'})});assert.equal(response.status,200);return response.headers.get('set-cookie')!.split(';')[0]};
  const api=async(cookie:string,path:string,body?:unknown)=>{const response=await fetch(base+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(response.status,200);return (await response.json() as any).data};
  try{
    const author=await register('http_private_author'),reader=await register('http_private_reader');
    const preview=await api(author,'agent/chat',{text:'发布一篇private帖子，第一行标题隔离标题，正文隔离正文',clientMessageId:'private-publish'});
    assert.match(preview.assistantMessage.text,/仅自己可见/);assert.equal((await api(author,'community/mine')).posts.length,0);
    const other=await api(author,'agent/conversations',{});
    // A confirmation in another conversation cannot apply this frozen preview.
    const pendingBefore=await api(author,'agent/task');
    await api(author,'agent/chat',{text:'确认发布',conversationId:other.conversationId,clientMessageId:'other-conversation'});
    assert.equal((await api(author,'community/mine')).posts.length,0);assert.equal((await api(author,'agent/task')).id,pendingBefore.id);
    await api(author,'agent/chat',{text:'确认发布',clientMessageId:'confirm-private'});
    const post=(await api(author,'community/mine')).posts[0];assert.equal(post.visibility,'private');assert.equal(post.text,'隔离标题\n隔离正文');
    assert.equal((await api(reader,'community/posts')).length,0);
    assert.equal((await fetch(base+'/api/v1/community/posts/'+post.id,{headers:{cookie:reader}})).status,404);
    const change=await api(author,'agent/chat',{text:`把这个帖子改为公开 POST=${post.id}`,clientMessageId:'change-visibility'});
    assert.match(change.assistantMessage.text,/修改后：公开/);assert.equal((await api(reader,'community/posts')).length,0);
    await api(author,'agent/chat',{text:'确认发布',clientMessageId:'wrong-confirmation'});
    assert.equal((await api(reader,'community/posts')).length,0,'publication confirmation cannot execute a visibility change');
    await api(author,'agent/chat',{text:'确认修改',clientMessageId:'confirm-visibility'});
    assert.equal((await api(reader,'community/posts')).length,1);assert.ok(calls>0);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
