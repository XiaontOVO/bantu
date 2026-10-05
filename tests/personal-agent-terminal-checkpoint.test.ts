import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {MemoryStateStore} from '../src/persistence/state-store.js';
import {modelTurn,toolCall,type ModelTurnRequest} from '../src/providers/model.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';

const now=()=> '2026-10-05T01:00:00.000Z';
const original='保存笔记，原文是“红砖\n晚风”';
const noteArgs={title:'红砖',text:'晚风'};
const overflow=(calls=false)=>({toolCalls:calls?[toolCall('unsafe','memories.create',noteArgs)]:[],finishReason:'error' as const,error:{code:'MODEL_CONTEXT_LIMIT',message:'synthetic-private-provider-detail'},usage:{inputTokens:0,outputTokens:0}});

test('native context overflow closes a pending literal checkpoint without executing its error turn',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return overflow(true);}}});
  const failed=await runPersonalAgent(ctx,'owner',original,[]),task=ctx.personalAgentTasks.current('owner')!;
  assert.equal(task.status,'completed');assert.equal(failed.steps.length,0);assert.equal(ctx.personalMemoriesService.list('owner').length,0);
  assert.match(failed.reply,/原文还未保存/);assert.match(failed.reply,/原生上下文容量不足/);assert.doesNotMatch(failed.reply,/synthetic-private|全部完成/);
  const continued=await runPersonalAgent(ctx,'owner','继续',[]);
  assert.equal(calls,1);assert.equal(ctx.personalAgentTasks.current('owner')!.id,task.id);assert.match(continued.reply,/不能.*继续|不能.*恢复/);
});

for(const partial of [false,true])test(`plain Continue after overflow cannot recreate a ${partial?'partly':'fully'} saved literal under a fresh task`,async()=>{
  let calls=0;
  const request=partial?'保存两篇笔记，第一篇内容就是“红砖\n晚风”，第二篇内容就是“青石\n晨光”':original;
  const args=partial?{...noteArgs,sourceIndex:1}:noteArgs;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(turn){
    if(++calls===1)return modelTurn([toolCall('saved','memories.create',args)]);
    if(calls===2)return overflow();
    if(calls===3){assert.ok(turn.messages.some(message=>message.role==='user'&&message.content===request),'ordinary chat history still contains the original request');return modelTurn([toolCall('repeated','memories.create',args)]);}
    return modelTurn([],'原文保存好了。');
  }}});
  const failed=await runPersonalAgent(ctx,'owner',request,[]),old=ctx.personalAgentTasks.current('owner')!,before=ctx.personalMemoriesService.serialize();
  assert.equal(old.status,'completed');assert.equal(ctx.personalMemoriesService.list('owner').length,1);assert.match(failed.reply,/原生上下文容量不足/);
  if(partial)assert.match(failed.reply,/第2篇笔记原文还未保存/);
  const continued=await runPersonalAgent(ctx,'owner','继续',[{role:'user',content:request},{role:'assistant',content:failed.reply}]);
  assert.equal(ctx.personalMemoriesService.serialize(),before,'a short continuation is not authorization for another saved copy');assert.equal(calls,2);assert.equal(ctx.personalAgentTasks.current('owner')!.id,old.id);assert.match(continued.reply,/已.*保留/);
});

test('an overflow after saving the plan closes remaining original work and preserves the actual scheme',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++calls===1?modelTurn([toolCall('plan','plans.create',{kind:'scheme',name:'三天方案',days:Array.from({length:3},()=>({stops:[]}))})]):overflow();}}});
  const failed=await runPersonalAgent(ctx,'owner',`生成三天方案，然后${original}`,[]),before=ctx.planLibrary.serialize();
  assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');assert.equal(ctx.planLibrary.list('owner')[0].days!.length,3);assert.match(failed.reply,/原文还未保存/);assert.match(failed.reply,/地点安排已保存/);
  await runPersonalAgent(ctx,'owner','继续',[]);assert.equal(calls,2);assert.equal(ctx.planLibrary.serialize(),before);
});

for(const limit of ['model','tool'] as const)test(`the cumulative ${limit} limit remains terminal even with an unfinished literal`,async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([toolCall('late','memories.create',noteArgs)]);}}});
  const task=ctx.personalAgentTasks.start('owner',[{role:'user',content:original}]);task.status='interrupted';if(limit==='model')task.modelCalls=256;else task.toolCalls=768;
  const failed=await runPersonalAgent(ctx,'owner','继续',[]);
  assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');assert.equal(ctx.personalMemoriesService.list('owner').length,0);assert.match(failed.reply,/原文还未保存/);assert.match(failed.reply,/上限/);
  const count=calls;await runPersonalAgent(ctx,'owner','继续',[]);assert.equal(calls,count);assert.equal(ctx.personalAgentTasks.current('owner')!.id,task.id);
});

test('a current-object conflict cannot reopen a checkpoint terminated by native context overflow',async()=>{
  const store=new MemoryStateStore();let calls=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){if(++calls===1)return modelTurn([toolCall('note','memories.create',noteArgs)]);throw new Error('disconnected');}}});
  await runPersonalAgent(first,'owner',original,[]);const note=first.personalMemoriesService.list('owner')[0];first.personalMemoriesService.patch('owner',note.memoryId,{content:'用户后来的正文'});first.persistState();let resumedCalls=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){resumedCalls++;return overflow();}}});
  const before=restored.personalMemoriesService.serialize(),failed=await runPersonalAgent(restored,'owner','继续',[]);
  assert.equal(restored.personalAgentTasks.current('owner')!.status,'completed');assert.match(failed.reply,/已变化/);assert.match(failed.reply,/原生上下文容量不足/);assert.doesNotMatch(failed.reply,/稍后继续|可以.*继续/);
  await runPersonalAgent(restored,'owner','继续',[]);assert.equal(resumedCalls,1);assert.equal(restored.personalMemoriesService.serialize(),before);
});

test('terminal continuation protection survives reconstruction and stays in its original conversation',async()=>{
  const store=new MemoryStateStore();let calls=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return overflow();}}});
  await runPersonalAgent(first,'owner',original,[],[],undefined,undefined,undefined,'one');
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([],'新的独立对话。');}}});
  const old=restored.personalAgentTasks.current('owner','one')!;
  await runPersonalAgent(restored,'owner','继续',[],[],undefined,undefined,undefined,'one');assert.equal(calls,1);assert.equal(restored.personalAgentTasks.current('owner','one')!.id,old.id);
  const other=await runPersonalAgent(restored,'owner','继续',[],[],undefined,undefined,undefined,'two');assert.equal(calls,2);assert.equal(other.reply,'新的独立对话。');
});

test('timeout still resumes its original task while a later explicit request may save another copy',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request:ModelTurnRequest){
    if(++calls===1)return {...overflow(),error:{code:'MODEL_TIMEOUT',message:'private'}};
    if(calls===2||calls===4)return modelTurn([toolCall(`note${calls}`,'memories.create',noteArgs)]);
    assert.ok(request.messages.some(message=>message.role==='tool'));return modelTurn([],'本次原文已保存。');
  }}});
  await runPersonalAgent(ctx,'owner',original,[]);const old=ctx.personalAgentTasks.current('owner')!;assert.equal(old.status,'interrupted');
  await runPersonalAgent(ctx,'owner','继续',[]);assert.equal(ctx.personalAgentTasks.current('owner')!.id,old.id);assert.equal(ctx.personalMemoriesService.list('owner').length,1);
  await runPersonalAgent(ctx,'owner',`再保存一份笔记，原文是“红砖\n晚风”`,[]);assert.notEqual(ctx.personalAgentTasks.current('owner')!.id,old.id);assert.equal(ctx.personalMemoriesService.list('owner').length,2);
});

for(const cancelled of [false,true])test(`a ${cancelled?'cancelled':'normally completed'} checkpoint does not redo a saved note on Continue after reconstruction`,async()=>{
  const store=new MemoryStateStore();let calls=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){
    if(++calls===1)return modelTurn([toolCall('saved','memories.create',noteArgs)]);
    if(cancelled)first.personalAgentTasks.cancel('owner',first.personalAgentTasks.current('owner')!.id);
    return modelTurn([],'笔记已经保存。');
  }}});
  const result=await runPersonalAgent(first,'owner',original,[]),old=first.personalAgentTasks.current('owner')!,before=first.personalMemoriesService.serialize();
  assert.equal(old.status,'completed');assert.doesNotMatch(first.personalAgentTasks.serialize(),/terminalReason/,'older completed checkpoint shapes need no new marker');
  const restored=createServerContext({seedDemo:false,now,stateStore:store,modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([toolCall('repeat','memories.create',noteArgs)]);}}});
  const continued=await runPersonalAgent(restored,'owner','继续',[{role:'user',content:original},{role:'assistant',content:result.reply}]);
  assert.equal(calls,2);assert.equal(restored.personalMemoriesService.serialize(),before);assert.equal(restored.personalAgentTasks.current('owner')!.id,old.id);assert.match(continued.reply,cancelled?/已停止/:/已结束处理/);assert.deepEqual(continued.refresh,['memories']);assert.equal(continued.detailLinks?.length,1);
});

test('a new explicit save after terminal overflow authorizes an independent second copy',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){
    if(++calls===1||calls===3)return modelTurn([toolCall(`note${calls}`,'memories.create',noteArgs)]);
    return calls===2?overflow():modelTurn([],'新的一份原文已保存。');
  }}});
  await runPersonalAgent(ctx,'owner',original,[]);const old=ctx.personalAgentTasks.current('owner')!;
  await runPersonalAgent(ctx,'owner','再保存一份笔记，原文是“红砖\n晚风”',[]);
  assert.notEqual(ctx.personalAgentTasks.current('owner')!.id,old.id);assert.equal(ctx.personalMemoriesService.list('owner').length,2);assert.equal(calls,4);
});

test('terminal feedback synchronizes the actual saved date and links without claiming changed content is still original',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){
    if(++calls===1)return modelTurn([toolCall('plan','plans.create',{kind:'plan',localDate:'2026-10-05',name:'当天计划',days:[{stops:[]}]}),toolCall('note','memories.create',noteArgs)]);
    return overflow();
  }}});
  await runPersonalAgent(ctx,'owner',`生成今天的日计划，然后${original}`,[]);const note=ctx.personalMemoriesService.list('owner')[0];ctx.personalMemoriesService.patch('owner',note.memoryId,{content:'用户后来的修改'});
  const continued=await runPersonalAgent(ctx,'owner','继续',[]);
  assert.equal(calls,2);assert.equal(continued.date,'2026-10-05');assert.deepEqual(new Set(continued.refresh),new Set(['plans','memories']));assert.equal(continued.detailLinks?.length,2);assert.match(continued.reply,/已变化/);assert.match(continued.reply,/不能.*恢复/);assert.equal(ctx.personalMemoriesService.list('owner')[0].content,'用户后来的修改');
});

test('the natural final loop at 256 model calls reports the terminal limit before any further Continue',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return modelTurn([toolCall(`read-${++calls}`,'memories.list',{})]);}}});
  let result=await runPersonalAgent(ctx,'owner',original,[]);
  for(let window=1;window<4;window++)result=await runPersonalAgent(ctx,'owner','继续',[]);
  assert.equal(calls,256);assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');assert.match(result.reply,/原文还未保存/);assert.match(result.reply,/累计模型调用.*上限/);assert.match(result.reply,/不能继续原检查点/);assert.doesNotMatch(result.reply,/点击继续|稍后继续|请继续/);
  await runPersonalAgent(ctx,'owner','继续',[]);assert.equal(calls,256);assert.equal(ctx.personalMemoriesService.list('owner').length,0);
});
