import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {MemoryStateStore} from '../src/persistence/state-store.js';
import {modelTurn,toolCall,type ModelTurnRequest} from '../src/providers/model.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';
import {prepareCommunityAction} from '../src/services/personal-agent-community-actions.js';
import {agentWriteKey} from '../src/services/personal-agent-write-key.js';
import {loadAgentScheme} from '../src/services/personal-agent-load.js';
import {DemoPlaceProvider} from '../src/providers/travel.js';
import {DEMO_SHANGHAI_PLACES} from '../src/demo/demo-data.js';

const now=()=> '2026-10-04T02:00:00.000Z';
const receipt=(request:ModelTurnRequest,id:string)=>{const message=request.messages.find(message=>message.role==='tool'&&message.toolCallId===id);return message?JSON.parse(message.content||'{}'):null;};

test('compound cancel wording cancels an existing post preview without invoking a new model write',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('post','community.post_publish',{title:'红砖',text:'晚风'})]);
    if(!receipt(request,'unwanted'))return modelTurn([toolCall('unwanted','memories.create',{title:'取消后的额外笔记',text:'不应该保存'})]);
    return modelTurn([],'已取消。');
  }}});
  ctx.accounts.register('pending_author','test-password-123','owner');
  await runPersonalAgent(ctx,'owner','发布帖子：红砖\n晚风',[]);
  const result=await runPersonalAgent(ctx,'owner','取消，不要保存',[]);
  assert.match(result.reply,/已取消/);assert.equal(ctx.personalMemoriesService.list('owner').length,0);assert.equal(ctx.communityService.mine('owner').posts.length,0);
  assert.equal(ctx.personalAgentTasks.pendingAction('owner'),undefined);assert.equal(calls,1);
});

test('negating publication cancels the preview, retains its text for explanation, and cannot later be confirmed',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('post','community.post_publish',{title:'红砖',text:'晚风'})]);
    assert.ok(request.messages.some(message=>message.role==='system'&&message.content?.includes('旧预览仅供解释')&&message.content.includes('红砖')));
    return modelTurn([],'已取消发布。这段原文描写红砖与晚风。');
  }}});
  ctx.accounts.register('explanation_author','test-password-123','owner');
  await runPersonalAgent(ctx,'owner','发布帖子：红砖\n晚风',[]);
  const result=await runPersonalAgent(ctx,'owner','不要发布，只解释这段文字',[]);
  assert.match(result.reply,/解释|描写/);assert.equal(calls,2);assert.equal(ctx.personalAgentTasks.pendingAction('owner'),undefined);
  const restored=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return modelTurn([],'没有待确认操作。');}}});
  restored.accounts.loadSerialized(ctx.accounts.serialize());restored.communityService.loadSerialized(ctx.communityService.serialize());restored.personalAgentTasks.loadSerialized(ctx.personalAgentTasks.serialize());
  await runPersonalAgent(restored,'owner','确认发布',[]);
  assert.equal(restored.communityService.mine('owner').posts.length,0);
});

test('negating deletion retains the actual object and cancels without another model round',async()=>{
  let planId='',calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([toolCall('delete','plans.delete',{planId})]);}}});
  const plan=ctx.planLibrary.save('owner',{name:'保留方案',kind:'scheme',days:[{dayIndex:0,stops:[],routeLegs:[],plannedCharges:[]}]});planId=plan.id;
  const before=ctx.planLibrary.serialize();await runPersonalAgent(ctx,'owner','删除保留方案',[]);
  const result=await runPersonalAgent(ctx,'owner','先不要删除',[]);
  assert.match(result.reply,/已取消/);assert.equal(calls,1);assert.equal(ctx.planLibrary.serialize(),before);assert.equal(ctx.personalAgentTasks.pendingAction('owner'),undefined);
});

test('compound cancellation cancels a pending load after restart without overwriting any plan',async()=>{
  const store=new MemoryStateStore();let schemeId='',calls=0;
  const options={seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([toolCall('load','plans.load',{schemeId})]);}}};
  const first=createServerContext(options);schemeId=first.planLibrary.save('owner',{name:'载入候选',kind:'scheme',days:[{dayIndex:0,stops:[],routeLegs:[],plannedCharges:[]}]}).id;
  loadAgentScheme(first,'owner',schemeId);await runPersonalAgent(first,'owner','重新载入这个方案',[]);
  const before=first.planLibrary.serialize();const restored=createServerContext(options);
  const result=await runPersonalAgent(restored,'owner','取消，不要保存',[]);
  assert.match(result.reply,/已取消/);assert.equal(calls,1);assert.equal(restored.planLibrary.serialize(),before);assert.equal(restored.personalAgentTasks.pendingLoad('owner'),undefined);
});

test('a quoted cancellation phrase in a new note does not become an instruction to cancel or stop writing',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('post','community.post_publish',{title:'旧预览'})]);
    if(!receipt(request,'note'))return modelTurn([toolCall('note','memories.create',{title:'取消，不要保存'})]);
    return modelTurn([],'原文已保存。');
  }}});ctx.accounts.register('quoted_author','test-password-123','owner');
  await runPersonalAgent(ctx,'owner','发布帖子：旧预览',[]);
  await runPersonalAgent(ctx,'owner','保存笔记，原文是“取消，不要保存”',[]);
  assert.equal(ctx.personalMemoriesService.list('owner')[0].userText,'取消，不要保存');assert.equal(calls,3);
});

test('a restored preview whose original request forbids writing cannot commit through the confirmation shortcut',async()=>{
  const store=new MemoryStateStore();let calls=0;
  const options={seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([],'已说明原文。');}}};
  const first=createServerContext(options);first.accounts.register('restored_author','test-password-123','owner');
  const post=first.communityService.publishPost('owner',{text:'私密原文',visibility:'private'},'restored_author');
  // A pre-guard server could persist an unauthorized model-generated preview.
  const task=first.personalAgentTasks.start('owner',[{role:'user',content:'只解释这篇帖子，不要保存任何内容'}]);
  const args={postId:post.id,expectedVisibility:'private' as const,visibility:'public' as const};
  task.pendingAction=prepareCommunityAction(first,'owner','post_visibility',args);
  const key=agentWriteKey('community.post_visibility',args);
  const preview={ok:true,result:{pending:true,prompt:task.pendingAction.prompt}};
  task.pendingActionCall={callId:'visibility',key};task.writes[key]=preview;task.messages.push({role:'tool',toolName:'community.post_visibility',toolCallId:'visibility',content:JSON.stringify(preview)});task.status='completed';first.persistState();
  const restored=createServerContext(options);
  const result=await runPersonalAgent(restored,'owner','确认修改',[]);
  assert.equal(restored.communityService.postDetail(post.id,'owner')!.visibility,'private');
  assert.match(result.reply,/禁止|只读|未修改|取消/);assert.equal(calls,0);
});

test('typed cancellation during confirmation lookup stops actual publication before committing',async()=>{
  const provider=new DemoPlaceProvider();let details=0,calls=0;
  let signalLookup:()=>void=()=>{},releaseLookup:()=>void=()=>{};
  const lookupStarted=new Promise<void>(resolve=>{signalLookup=resolve;});
  const lookupBlocked=new Promise<void>(resolve=>{releaseLookup=resolve;});
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:{providerName:'controlled',search:input=>provider.search(input),async detail(id){if(++details===2){signalLookup();await lookupBlocked;}return provider.detail(id);}},modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([toolCall('review','community.place_review',{placeId:DEMO_SHANGHAI_PLACES[0].placeId,rating:5,text:'用户的评价原文'})]);}}});
  ctx.accounts.register('inflight_author','test-password-123','owner');
  await runPersonalAgent(ctx,'owner','给武康大楼发布五星评价：用户的评价原文',[]);
  const confirming=runPersonalAgent(ctx,'owner','确认发布',[]);await lookupStarted;
  const cancelled=await runPersonalAgent(ctx,'owner','取消，不要保存',[]);
  assert.match(cancelled.reply,/已取消/);releaseLookup();
  const result=await confirming;assert.match(result.reply,/操作已停止/);
  assert.equal(ctx.communityService.placeUserReviews(DEMO_SHANGHAI_PLACES[0].placeId).length,0);assert.equal(calls,1);
  assert.equal(ctx.personalAgentTasks.current('owner')!.cancelRequested,true);assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');
});

test('a restored forbidden load preview cannot overwrite the current plan through confirmation',async()=>{
  const store=new MemoryStateStore();let calls=0;
  const options={seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([],'已说明。');}}};
  const first=createServerContext(options);
  const scheme=first.planLibrary.save('owner',{name:'旧载入候选',kind:'scheme',days:[{dayIndex:0,stops:[],routeLegs:[],plannedCharges:[]}]});
  loadAgentScheme(first,'owner',scheme.id);
  const task=first.personalAgentTasks.start('owner',[{role:'user',content:'只解释这个方案，不要保存任何内容'}]);
  task.pendingLoad=loadAgentScheme(first,'owner',scheme.id).pending;assert.ok(task.pendingLoad);
  const args={schemeId:scheme.id},key=agentWriteKey('plans.load',args),preview={ok:true,result:{pending:task.pendingLoad}};
  task.pendingLoadCall={callId:'load',key};task.writes[key]=preview;task.messages.push({role:'tool',toolName:'plans.load',toolCallId:'load',content:JSON.stringify(preview)});task.status='completed';first.persistState();
  const before=first.planLibrary.serialize(),restored=createServerContext(options);
  const result=await runPersonalAgent(restored,'owner','确认载入',[]);
  assert.match(result.reply,/禁止|只读|未修改|取消/);assert.equal(restored.planLibrary.serialize(),before);assert.equal(calls,0);assert.equal(restored.personalAgentTasks.pendingLoad('owner'),undefined);
});
