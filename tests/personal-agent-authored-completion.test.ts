import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {MemoryStateStore} from '../src/persistence/state-store.js';
import {modelTurn,toolCall,type ModelTurnRequest} from '../src/providers/model.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';

const now=()=> '2026-10-04T02:00:00.000Z';
const receipt=(request:ModelTurnRequest,id:string)=>{const message=request.messages.find(message=>message.role==='tool'&&message.toolCallId===id);return message?JSON.parse(message.content||'{}'):null;};
const note1={sourceIndex:1,title:'红砖',text:'晚风'},note2={sourceIndex:2,title:'白墙',text:'晨光'};
const instruction='保存两篇笔记，第一篇内容就是“红砖\n晚风”，第二篇内容就是“白墙\n晨光”';

test('each original needs a distinct successful write, and wrong second content cannot mark the task completed',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    calls++;
    if(!receipt(request,'first'))return modelTurn([toolCall('first','memories.create',note1)]);
    if(!receipt(request,'substitute'))return modelTurn([toolCall('substitute','memories.create',{...note1,sourceIndex:2})]);
    assert.equal(receipt(request,'substitute').ok,false);
    return modelTurn([],'两篇都保存好了。');
  }}});
  const result=await runPersonalAgent(ctx,'owner',instruction,[]);
  assert.equal(calls,5);assert.match(result.reply,/第2篇笔记原文还未保存/);
  assert.deepEqual(ctx.personalMemoriesService.list('owner').map(note=>note.userText),['红砖\n晚风']);
  assert.equal(ctx.personalAgentTasks.current('owner')!.status,'interrupted');
});

test('an interrupted multi-original task resumes after reconstruction and replays the first write without duplication',async()=>{
  const store=new MemoryStateStore();let calls=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){if(++calls===1)return modelTurn([toolCall('first','memories.create',note1)]);throw new Error('disconnected');}}});
  const interrupted=await runPersonalAgent(first,'owner',instruction,[]);
  assert.match(interrupted.reply,/第2篇笔记/);assert.equal(first.personalMemoriesService.list('owner').length,1);
  let resumedCalls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    assert.ok(request.messages.some(message=>message.role==='user'&&message.content===instruction));
    if(++resumedCalls===1)return modelTurn([toolCall('replay','memories.create',note1),toolCall('second','memories.create',note2)]);
    assert.equal(receipt(request,'replay').replayed,true);assert.equal(receipt(request,'second').ok,true);
    return modelTurn([],'两篇原文均已保存。');
  }}});
  await runPersonalAgent(restored,'owner','继续',[]);
  assert.equal(restored.personalMemoriesService.list('owner').length,2);
  assert.deepEqual(restored.personalMemoriesService.list('owner').map(note=>note.userText).sort(),['白墙\n晨光','红砖\n晚风'].sort());
  assert.equal(restored.personalAgentTasks.current('owner')!.status,'completed');
});

test('explicitly requested identical originals still create two independent notes',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++calls===1?modelTurn([toolCall('first','memories.create',note1),toolCall('second','memories.create',{...note1,sourceIndex:2})]):modelTurn([],'两篇已保存。');}}});
  await runPersonalAgent(ctx,'owner','保存两篇笔记，第一篇内容就是“红砖\n晚风”，第二篇内容就是“红砖\n晚风”',[]);
  const notes=ctx.personalMemoriesService.list('owner');assert.equal(notes.length,2);assert.notEqual(notes[0].memoryId,notes[1].memoryId);assert.equal(notes[0].userText,notes[1].userText);
});

test('post preview never counts as committed publication and confirmation preserves the original multi-part request',async()=>{
  const store=new MemoryStateStore();let calls=0;
  const instruction='发布帖子，原文是“红砖\n晚风”；然后保存笔记，原文是“白墙\n晨光”';
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([toolCall('post','community.post_publish',{...note1,visibility:'private'})]);}}});
  const actorId='multi-owner';first.accounts.register('multi_author','correct horse 1234',actorId);
  const preview=await runPersonalAgent(first,actorId,instruction,[]);
  assert.match(preview.reply,/确认发布/);assert.equal(first.communityService.listPosts(actorId).length,0);assert.equal(calls,1);
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    assert.ok(request.messages.some(message=>message.role==='user'&&message.content===instruction));
    assert.equal(receipt(request,'post').result.completed,true);
    calls++;return modelTurn([],'帖子和笔记都完成了。');
  }}});
  const incomplete=await runPersonalAgent(restored,actorId,'确认发布',[]);
  assert.match(incomplete.reply,/第2篇笔记/);assert.equal(calls,4);assert.equal(restored.personalMemoriesService.list(actorId).length,0);
  assert.equal(restored.communityService.mine(actorId).posts.length,1);assert.equal(restored.personalAgentTasks.current(actorId)!.status,'interrupted');
  let finishCalls=0;
  const continued=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++finishCalls===1)return modelTurn([toolCall('post-replay','community.post_publish',{...note1,visibility:'private'}),toolCall('note','memories.create',note2)]);
    assert.equal(receipt(request,'post-replay').replayed,true);return modelTurn([],'帖子已发布，笔记已保存。');
  }}});
  await runPersonalAgent(continued,actorId,'继续',[]);
  assert.equal(continued.communityService.mine(actorId).posts.length,1);assert.equal(continued.personalMemoriesService.list(actorId).length,1);assert.equal(continued.personalAgentTasks.current(actorId)!.status,'completed');
});

test('read-only originals do not force saving and an explicit no-write request blocks a model write',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('unwanted','memories.create',{title:'红砖',text:'晚风'})]);
    assert.equal(receipt(request,'unwanted').ok,false);return modelTurn([],'这篇笔记描写红砖与晚风。');
  }}});
  const result=await runPersonalAgent(ctx,'owner','只解释这篇笔记，原文是“红砖\n晚风”，不要保存任何内容',[]);
  assert.equal(ctx.personalMemoriesService.list('owner').length,0);assert.equal(calls,2);assert.doesNotMatch(result.reply,/未保存|尚未完成/);
});

test('a no-write phrase in the authored payload does not block saving its literal original',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++calls===1?modelTurn([toolCall('note','memories.create',{title:'不要保存任何内容',text:'这只是笔记原文。'})]):modelTurn([],'已保存原文。');}}});
  await runPersonalAgent(ctx,'owner','保存笔记，原文是“不要保存任何内容\n这只是笔记原文。”',[]);
  assert.equal(ctx.personalMemoriesService.list('owner')[0].userText,'不要保存任何内容\n这只是笔记原文。');assert.equal(calls,2);
});

test('ambiguous original destination remains incomplete instead of selecting a post or note',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('guess','memories.create',{title:'红砖',text:'晚风'})]);
    assert.equal(receipt(request,'guess').ok,false);return modelTurn([],'原文已保存。');
  }}});
  const result=await runPersonalAgent(ctx,'owner','保存原文，原文是“红砖\n晚风”',[]);
  assert.match(result.reply,/尚未明确为笔记还是帖子/);assert.equal(ctx.personalMemoriesService.list('owner').length,0);assert.equal(ctx.personalAgentTasks.current('owner')!.status,'interrupted');
});

test('a failed confirmation keeps the original checkpoint and can prepare a fresh valid preview after restart',async()=>{
  const store=new MemoryStateStore();let memoryId='';
  const instruction='发布帖子，原文是“红砖\n晚风”，附上已有笔记';
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return modelTurn([toolCall('old-preview','community.post_publish',{title:'红砖',text:'晚风',memoryId})]);}}});
  first.accounts.register('confirmation_author','correct horse 1234','owner');
  const note=first.personalMemoriesService.createJourney('owner',{plan:{id:'test-walk',localDate:'2026-10-04'},places:[{stopId:'visit',name:'红砖街道',visitMinutes:30}],firstEventAt:null,completedAt:null,elapsedMinutes:30,generatedBy:'manual'});assert.ok(note.ok);memoryId=note.value.memoryId;
  const preview=await runPersonalAgent(first,'owner',instruction,[]);assert.match(preview.reply,/确认发布/);
  first.personalMemoriesService.delete('owner',memoryId);
  const failed=await runPersonalAgent(first,'owner','确认发布',[]);
  assert.match(failed.reply,/找不到/);assert.equal(first.personalAgentTasks.current('owner')!.status,'interrupted');
  assert.equal(first.communityService.mine('owner').posts.length,0);
  let calls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    assert.ok(request.messages.some(message=>message.role==='user'&&message.content===instruction));
    assert.equal(receipt(request,'old-preview').ok,false);
    return ++calls===1?modelTurn([toolCall('new-preview','community.post_publish',{title:'红砖',text:'晚风'})]):modelTurn([],'原文已发布。');
  }}});
  const renewed=await runPersonalAgent(restored,'owner','继续',[]);assert.match(renewed.reply,/确认发布/);
  await runPersonalAgent(restored,'owner','确认发布',[]);
  assert.equal(restored.communityService.mine('owner').posts.length,1);assert.equal(restored.personalAgentTasks.current('owner')!.status,'completed');
});

test('English and corner-quoted restrictions inside original text stay data, while English read-only instructions block writes',async()=>{
  for(const request of ['保存笔记，原文是『不要保存任何内容\n正文。』','保存笔记，original text is "不要保存任何内容\n正文。"','保存笔记，内容如下：不要保存任何内容\n正文。']){
    let calls=0;
    const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++calls===1?modelTurn([toolCall('note','memories.create',{title:'不要保存任何内容',text:'正文。'})]):modelTurn([],'已保存原文。');}}});
    await runPersonalAgent(ctx,'owner',request,[]);assert.equal(ctx.personalMemoriesService.list('owner').length,1,request);assert.equal(calls,2);
  }
  let calls=0;
  const readonly=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){if(++calls===1)return modelTurn([toolCall('note','memories.create',{title:'Red brick',text:'Evening wind.'})]);assert.equal(receipt(request,'note').ok,false);return modelTurn([],'The text describes red brick and evening wind.');}}});
  await runPersonalAgent(readonly,'owner','Only explain this note, original text is "Red brick\nEvening wind.". Do not save anything.',[]);
  assert.equal(readonly.personalMemoriesService.list('owner').length,0);assert.equal(calls,2);
});
