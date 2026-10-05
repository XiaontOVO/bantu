import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {MemoryStateStore} from '../src/persistence/state-store.js';
import {modelTurn,toolCall,type ModelTurnRequest} from '../src/providers/model.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';
import {agentCreationStateIssues} from '../src/services/personal-agent-write-state.js';
import {agentWriteKey} from '../src/services/personal-agent-write-key.js';
import {replayAgentWrite} from '../src/services/personal-agent-replay.js';

const now=()=> '2026-10-04T02:00:00.000Z';
const receipt=(request:ModelTurnRequest,id:string)=>{const message=request.messages.find(message=>message.role==='tool'&&message.toolCallId===id);return message?JSON.parse(message.content||'{}'):null;};
const original='保存笔记，原文是“红砖\n晚风”';
const noteArgs={title:'红砖',text:'晚风'};
const days=(length:number)=>Array.from({length},()=>({stops:[]}));

for(const change of ['deleted','edited'] as const)test(`an interrupted literal note cannot report the ${change} object as currently saved after restart`,async()=>{
  const store=new MemoryStateStore();let calls=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){if(++calls===1)return modelTurn([toolCall('note','memories.create',noteArgs)]);throw new Error('disconnected');}}});
  await runPersonalAgent(first,'owner',original,[]);const note=first.personalMemoriesService.list('owner')[0];
  if(change==='deleted')first.personalMemoriesService.delete('owner',note.memoryId);else first.personalMemoriesService.patch('owner',note.memoryId,{content:'用户后来修改的正文'});
  first.persistState();let resumedCalls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++resumedCalls===1)return modelTurn([toolCall('repeat','memories.create',noteArgs)]);
    assert.equal(receipt(request,'repeat').replayed,true);return modelTurn([],'原文已经完整保存了。');
  }}});
  const before=restored.personalMemoriesService.serialize(),result=await runPersonalAgent(restored,'owner','继续',[]);
  assert.match(result.reply,change==='deleted'?/已不存在|已删除/:/已变化|已修改/);assert.equal(restored.personalAgentTasks.current('owner')!.status,'interrupted');
  assert.equal(restored.personalMemoriesService.serialize(),before,'external changes must not be undone or resurrected');
});

for(const change of ['deleted','shortened'] as const)test(`a ${change} scheme cannot satisfy the current complete-day creation goal through an old receipt`,async()=>{
  const store=new MemoryStateStore();let calls=0;
  const args={kind:'scheme',name:'三天方案',days:days(3)};
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){if(++calls===1)return modelTurn([toolCall('plan','plans.create',args)]);throw new Error('disconnected');}}});
  await runPersonalAgent(first,'owner','生成三天方案',[]);const plan=first.planLibrary.list('owner')[0];
  if(change==='deleted')first.planLibrary.remove('owner',plan.id);else first.planLibrary.update('owner',plan.id,{name:'用户缩短后的方案',days:plan.days!.slice(0,1)});
  first.persistState();let resumedCalls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++resumedCalls===1?modelTurn([toolCall('repeat','plans.create',args)]):modelTurn([],'三天完整方案已保存。');}}});
  const before=restored.planLibrary.serialize(),result=await runPersonalAgent(restored,'owner','继续',[]);
  assert.match(result.reply,change==='deleted'?/已不存在|已删除/:/已变化|不再满足/);assert.equal(restored.personalAgentTasks.current('owner')!.status,'interrupted');assert.equal(restored.planLibrary.serialize(),before);
});

test('an inverse visibility change invalidates the old matching write and requires a fresh third confirmation',async()=>{
  let postId='',calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    calls++;
    if(!receipt(request,'first'))return modelTurn([toolCall('first','community.post_visibility',{postId,expectedVisibility:'private',visibility:'public'})]);
    if(!receipt(request,'second'))return modelTurn([toolCall('second','community.post_visibility',{postId,expectedVisibility:'public',visibility:'private'})]);
    if(!receipt(request,'third'))return modelTurn([toolCall('third','community.post_visibility',{postId,expectedVisibility:'private',visibility:'public'})]);
    return modelTurn([],'三次可见范围修改都已完成，当前公开。');
  }}});ctx.accounts.register('visibility_author','test-password-123','owner');postId=ctx.communityService.publishPost('owner',{text:'切换范围测试',visibility:'private'},'作者').id;
  await runPersonalAgent(ctx,'owner','把这篇帖子的可见范围按顺序切换三次：先公开，再私密，最后公开',[]);
  await runPersonalAgent(ctx,'owner','确认修改',[]);
  const thirdPreview=await runPersonalAgent(ctx,'owner','确认修改',[]);
  assert.match(thirdPreview.reply,/确认修改/,'the third desired state needs its own preview and user confirmation');
  assert.equal(ctx.communityService.postDetail(postId,'owner')!.visibility,'private');
  await runPersonalAgent(ctx,'owner','确认修改',[]);
  assert.equal(ctx.communityService.postDetail(postId,'owner')!.visibility,'public');assert.equal(calls,4);
});

for(const instruction of ['保存笔记，原文是“红砖\n晚风”，然后修改笔记正文为晨光','Create a note with original text “红砖\n晚风”, then edit the note body to 晨光'])test(`an explicitly requested subsequent note edit completes using its final contents: ${instruction.startsWith('Create')?'English':'Chinese'}`,async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('note','memories.create',noteArgs)]);
    if(calls===2){const note=receipt(request,'note').result;return modelTurn([toolCall('edit','memories.edit',{memoryId:note.memoryId,expectedVersion:note.entryVersion,content:'晨光'})]);}
    return modelTurn([],'笔记已按要求修改。');
  }}});
  await runPersonalAgent(ctx,'owner',instruction,[]);
  assert.equal(ctx.personalMemoriesService.list('owner')[0].content,'晨光');assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');assert.equal(calls,3);
});

for(const kind of ['note','plan'] as const)test(`an explicitly requested create then confirmed ${kind} deletion completes without recreating it`,async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('create',kind==='note'?'memories.create':'plans.create',kind==='note'?noteArgs:{kind:'scheme',name:'三天方案',days:days(3)})]);
    if(calls===2){const saved=receipt(request,'create').result;return modelTurn([toolCall('delete',kind==='note'?'memories.delete':'plans.delete',kind==='note'?{memoryId:saved.memoryId}:{planId:saved.id})]);}
    return modelTurn([],'已按要求保存并删除。');
  }}});
  await runPersonalAgent(ctx,'owner',kind==='note'?`${original}，然后删除这篇笔记`:'生成三天方案，然后删除这个方案',[]);
  const result=await runPersonalAgent(ctx,'owner','确认删除',[]);
  assert.equal((kind==='note'?ctx.personalMemoriesService.list('owner'):ctx.planLibrary.list('owner')).length,0);
  assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');assert.match(result.reply,/已删除/);assert.equal(calls,3);
});

test('a create followed by several authorized plan edits in one batch respects the final days',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('create','plans.create',{kind:'scheme',name:'三天方案',days:days(3)})]);
    if(calls===2){const saved=receipt(request,'create').result;return modelTurn([1,2,1].map((dayCount,index)=>toolCall(`edit${index}`,'plans.edit',{planId:saved.id,expectedRevision:(saved.revision||0)+index,action:'set_days',dayCount})));}
    for(const index of [0,1,2])assert.equal(receipt(request,`edit${index}`).ok,true,JSON.stringify(receipt(request,`edit${index}`)));
    return modelTurn([],'按顺序完成修改，最终一天。');
  }}});
  const result=await runPersonalAgent(ctx,'owner','生成三天方案，然后修改方案天数为一天、两天、一天',[]);
  assert.equal(ctx.planLibrary.list('owner')[0].days!.length,1,JSON.stringify(result.steps));assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');assert.equal(calls,3);
});

test('a checkpoint uses actual committed message order after the same edit key is overwritten',()=>{
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore()});
  const task=ctx.personalAgentTasks.start('owner',[{role:'user',content:'保存笔记，然后修改笔记正文为甲、乙、甲'}]);
  const created=ctx.personalMemoriesService.create('owner',{userText:'红砖\n晚风'});assert.ok(created.ok);
  const args={memoryId:created.value.memoryId,content:'甲'},other={...args,content:'乙'};
  const append=(id:string,tool:string,args:Record<string,unknown>,value:unknown)=>{
    const result={ok:true,result:structuredClone(value)};
    task.messages.push({role:'assistant',toolCalls:[toolCall(id,tool,args)]},{role:'tool',toolName:tool,toolCallId:id,content:JSON.stringify(result)});task.writes[agentWriteKey(tool,args)]=result;
  };
  append('create','memories.create',noteArgs,created.value);
  for(const [index,editArgs] of [args,other,args].entries()){const saved=ctx.personalMemoriesService.patch('owner',created.value.memoryId,{content:editArgs.content});assert.ok(saved.ok);append(`edit${index}`,'memories.edit',editArgs,saved.value);}
  assert.equal(agentCreationStateIssues(ctx,'owner',task,[]).length,0,'final same-key edit is newer than the inverse action');
  ctx.personalMemoriesService.patch('owner',created.value.memoryId,{content:'用户后来的修改'});
  assert.match(agentCreationStateIssues(ctx,'owner',task,[])[0].message,/已变化/,'later external edits still produce a conflict');
});

test('a deleted post cannot replay an old successful visibility change as a current success',()=>{
  const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore()});ctx.accounts.register('visibility_deleted','test-password-123','owner');
  const post=ctx.communityService.publishPost('owner',{text:'范围测试',visibility:'public'},'作者');
  const cached={ok:true,result:{completed:true,result:structuredClone(post)}};
  ctx.communityService.removePost('owner',post.id);
  const replay=replayAgentWrite(ctx,'owner','community.post_visibility',cached) as any;
  assert.equal(replay.ok,false);assert.equal(replay.replayed,true);assert.match(replay.error,/已不存在/);
});

for(const editedBeforeDisconnect of [false,true])test(`continuation cannot overwrite an externally edited note using a fresh version after ${editedBeforeDisconnect?'its requested edit':'its creation'}`,async()=>{
  const store=new MemoryStateStore();let calls=0;
  const requestText=editedBeforeDisconnect?`${original}，然后修改笔记正文为晨光`:original;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('create','memories.create',noteArgs)]);
    if(editedBeforeDisconnect&&calls===2){const saved=receipt(request,'create').result;return modelTurn([toolCall('edit','memories.edit',{memoryId:saved.memoryId,expectedVersion:saved.entryVersion,content:'晨光'})]);}
    throw new Error('disconnected');
  }}});
  await runPersonalAgent(first,'owner',requestText,[]);const note=first.personalMemoriesService.list('owner')[0];
  first.personalMemoriesService.patch('owner',note.memoryId,{content:'用户后来亲自修改的正文'});first.persistState();let resumedCalls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++resumedCalls===1)return modelTurn([toolCall('latest','memories.list',{})]);
    if(resumedCalls===2){const latest=receipt(request,'latest').result[0];return modelTurn([toolCall('fresh','memories.edit',{memoryId:latest.memoryId,expectedVersion:latest.entryVersion,content:editedBeforeDisconnect?'晨光':'晚风'})]);}
    return modelTurn([],'原文及后续修改均已完成。');
  }}});
  const before=restored.personalMemoriesService.serialize(),result=await runPersonalAgent(restored,'owner','继续',[]);
  assert.equal(restored.personalMemoriesService.serialize(),before,'fresh versions do not reauthorize overwriting external changes');
  assert.equal(restored.personalAgentTasks.current('owner')!.status,'interrupted');assert.ok(result.steps.some(step=>step.tool==='memories.edit'&&!step.ok));assert.match(result.reply,/已变化/);
});

test('a conflicting object is protected while another unfinished original can still be saved',async()=>{
  const store=new MemoryStateStore();let calls=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){if(++calls===1)return modelTurn([toolCall('one','memories.create',{...noteArgs,sourceIndex:1})]);throw new Error('disconnected');}}});
  await runPersonalAgent(first,'owner','保存第一篇笔记，原文是“红砖\n晚风”；保存第二篇笔记，原文是“青石\n晨光”',[]);
  const firstNote=first.personalMemoriesService.list('owner')[0];first.personalMemoriesService.patch('owner',firstNote.memoryId,{content:'用户新的正文'});first.persistState();let resumedCalls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){
    if(++resumedCalls===1){const latest=restored.personalMemoriesService.list('owner')[0];return modelTurn([toolCall('fresh','memories.edit',{memoryId:latest.memoryId,expectedVersion:latest.entryVersion,content:'晚风'}),toolCall('two','memories.create',{title:'青石',text:'晨光',sourceIndex:2})]);}
    return modelTurn([],'两篇均已保存。');
  }}});
  const result=await runPersonalAgent(restored,'owner','继续',[]),notes=restored.personalMemoriesService.list('owner');
  assert.equal(notes.find(note=>note.memoryId===firstNote.memoryId)!.content,'用户新的正文');assert.equal(notes.length,2);assert.equal(notes.find(note=>note.title==='青石')!.content,'晨光');
  assert.equal(restored.personalAgentTasks.current('owner')!.status,'interrupted');assert.ok(result.steps.some(step=>step.tool==='memories.edit'&&!step.ok));assert.ok(result.steps.some(step=>step.tool==='memories.create'&&step.ok));
});

test('a pending deletion cannot be reconfirmed against a conflicting creation checkpoint',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('create','memories.create',noteArgs)]);
    if(calls===2)return modelTurn([toolCall('delete','memories.delete',{memoryId:receipt(request,'create').result.memoryId})]);
    return modelTurn([],'删除已完成。');
  }}});
  await runPersonalAgent(ctx,'owner',`${original}，然后删除这篇笔记`,[]);
  const note=ctx.personalMemoriesService.list('owner')[0];ctx.personalMemoriesService.patch('owner',note.memoryId,{content:'用户新的正文'});
  const result=await runPersonalAgent(ctx,'owner','确认删除',[]);
  assert.equal(ctx.personalMemoriesService.list('owner')[0].content,'用户新的正文');assert.equal(ctx.personalAgentTasks.current('owner')!.status,'interrupted');assert.equal(ctx.personalAgentTasks.current('owner')!.awaitingConfirmation,false);assert.match(result.reply,/已变化/);
});

for(const change of ['deleted','edited'] as const)test(`a free authored note with a ${change} saved object cannot be recreated under a new write key on Continue`,async()=>{
  const store=new MemoryStateStore();let calls=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){if(++calls===1)return modelTurn([toolCall('one','memories.create',{title:'雨路',text:'薄雾'})]);throw new Error('disconnected');}}});
  await runPersonalAgent(first,'owner','自由写一篇笔记，描述雨中的街道',[]);const note=first.personalMemoriesService.list('owner')[0];
  if(change==='deleted')first.personalMemoriesService.delete('owner',note.memoryId);else first.personalMemoriesService.patch('owner',note.memoryId,{content:'用户亲自改过的正文'});
  first.persistState();let resumedCalls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++resumedCalls===1?modelTurn([toolCall('replacement','memories.create',{title:'雨路新记',text:'另一段雨景。'})]):modelTurn([],'新笔记已保存。');}}});
  const before=restored.personalMemoriesService.serialize(),result=await runPersonalAgent(restored,'owner','继续',[]);
  assert.equal(restored.personalMemoriesService.serialize(),before,'a fresh write key does not authorize replacing the conflicting object');assert.ok(result.steps.some(step=>step.tool==='memories.create'&&!step.ok));assert.equal(restored.personalAgentTasks.current('owner')!.status,'interrupted');
});

test('a free published post cannot be replaced with a new publication preview after external withdrawal',async()=>{
  const store=new MemoryStateStore();let calls=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){if(++calls===1)return modelTurn([toolCall('one','community.post_publish',{text:'雨路\n薄雾'})]);throw new Error('disconnected');}}});
  first.accounts.register('free_post_author','test-password-123','owner');
  await runPersonalAgent(first,'owner','自由写一篇旅行帖子并发布，描述雨中的街道',[]);await runPersonalAgent(first,'owner','确认发布',[]);
  const post=first.communityService.listPosts('owner')[0];first.communityService.removePost('owner',post.id);first.persistState();let resumedCalls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++resumedCalls===1?modelTurn([toolCall('replacement','community.post_publish',{text:'雨路新记\n另一段雨景。'})]):modelTurn([],'新帖子已发布。');}}});
  const result=await runPersonalAgent(restored,'owner','继续',[]);
  assert.equal(restored.communityService.listPosts('owner').length,0);assert.equal(restored.personalAgentTasks.current('owner')!.awaitingConfirmation,false);assert.equal(restored.personalAgentTasks.current('owner')!.status,'interrupted');assert.ok(result.steps.some(step=>step.tool==='community.post_publish'&&!step.ok));assert.match(result.reply,/已不存在|已撤回/);
});
