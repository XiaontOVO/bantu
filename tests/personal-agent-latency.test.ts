import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentToolDiscovery} from '../src/services/personal-agent-tool-discovery.js';
import {initialAgentPlanContext} from '../src/services/personal-agent-plan-context.js';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {MemoryStateStore} from '../src/persistence/state-store.js';
import {modelTurn,toolCall,type ModelToolDefinition} from '../src/providers/model.js';
import {DEMO_SHANGHAI_PLACES} from '../src/demo/demo-data.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';
import {DemoPlaceProvider} from '../src/providers/travel.js';
import {planningGoalFromText} from '../src/services/personal-agent-planning-goal.js';

const now=()=> '2026-10-03T06:00:00.000Z';
const definitions=['plans.list','plans.rest','places.search','memories.create','community.post_publish'].map(name=>({name,description:name,inputSchema:{type:'object'}}));
test('authored note contents do not become planning goals while genuine dated visits and compound creation remain goals',()=>{
  for(const text of ['保存笔记，内容就是“已经清理旧方案”。','保存笔记：已经清理旧方案','创建一篇旅行记忆','生成旅行笔记','保存笔记，内容就是已经清理旧方案','保存笔记，原文是「旅行三天，安排每天两个景点。」','安排明天休息30分钟'])assert.equal(planningGoalFromText(text),null,text);
  for(const text of ['安排明天武康大楼，再记笔记，内容就是“已经清理旧方案”。','安排明天去上海图书馆','生成七天方案，每天两个景点','规划一次旅行','保存上海半日计划'])assert.ok(planningGoalFromText(text),text);
  assert.deepEqual(planningGoalFromText('生成七天方案，每天两个景点，再记笔记，原文是“旅行三天，每天四个景点”。'),{days:7,stopsPerDay:2});
  assert.ok(planningGoalFromText('保存笔记，原文是“已经清理旧方案”。然后安排明天去上海图书馆'),'a genuine later instruction outside quoted data remains an instruction');
});
test('progressive tool discovery reduces unrelated schemas while every authorized domain stays reachable',()=>{
  const original:ModelToolDefinition[]=definitions.slice();
  const scope=agentToolDiscovery(original,'你好',[]);original.push(scope.definition);
  assert.deepEqual(scope.definitions().map(t=>t.name),['plans.list','places.search','tools.discover']);
  scope.discover({domains:['memories','community']});
  assert.ok(scope.definitions().some(t=>t.name==='memories.create'));assert.ok(scope.definitions().some(t=>t.name==='community.post_publish'));
  assert.equal(scope.definitions().filter(t=>t.name==='tools.discover').length,1,'mutating the dispatcher array cannot duplicate the discovery tool');
});
test('discovery checkpoints cannot restore tools removed by a restricted dispatcher scope',()=>{
  const scope=agentToolDiscovery(definitions.slice(0,3),'你好',[{role:'tool',toolName:'tools.discover',content:JSON.stringify({ok:true,result:{tools:[{name:'community.post_publish'}]}})}]);
  scope.discover({domains:['community']});assert.equal(scope.definitions().some(t=>t.name==='community.post_publish'),false);
  const creating=agentToolDiscovery(definitions,'创建完整方案',[],true);assert.equal(creating.definitions().length,definitions.length+1);
});
test('common Chinese stop-time edits are advertised directly and removing a stop does not select plan deletion',()=>{
  const all=['plans.list','plans.edit','plans.adjust_stop','plans.delete','plans.replace_place','plans.set_transport'].map(name=>({name,description:name,inputSchema:{type:'object'}}));
  for(const text of ['把武康大楼改到15点','第二站延后15分钟','第二站提前半小时','延长游览30分钟'])assert.ok(agentToolDiscovery(all,text,[]).definitions().some(tool=>tool.name==='plans.adjust_stop'),text);
  for(const text of ['移除第二站','删掉一个站','从计划删除这个景点']){
    const names=agentToolDiscovery(all,text,[]).definitions().map(tool=>tool.name);
    assert.ok(names.includes('plans.edit'),text);assert.ok(!names.includes('plans.delete'),text);
  }
  assert.ok(agentToolDiscovery(all,'删除今天的计划',[]).definitions().some(tool=>tool.name==='plans.delete'));
});
test('restricted companion delegation advertises real read-only roads without granting removed plan writes',()=>{
  const scoped=['plans.list','places.search','routes.estimate','companion.context','companion.preview','companion.apply'].map(name=>({name,description:name,inputSchema:{type:'object'}}));
  const names=agentToolDiscovery(scoped,'休息一下自动安排',[]).definitions().map(tool=>tool.name);
  assert.ok(names.includes('routes.estimate'));assert.ok(names.includes('companion.preview'));assert.ok(!names.includes('plans.edit'));assert.ok(!names.includes('plans.create'));
});
test('explicit progress-time corrections advertise the correction tool directly without granting it to scoped delegation',()=>{
  const scope=['plans.list','progress.record','progress.correct'].map(name=>({name,description:name,inputSchema:{type:'object'}}));
  for(const text of ['只把完成时间改成16点','纠正刚才的到达记录','实际出发记录有误'])assert.ok(agentToolDiscovery(scope,text,[]).definitions().some(tool=>tool.name==='progress.correct'),text);
  assert.ok(!agentToolDiscovery(scope.slice(0,2),'纠正刚才的到达记录',[]).definitions().some(tool=>tool.name==='progress.correct'));
});
const seed=(ctx:ReturnType<typeof createServerContext>,actor='owner')=>ctx.planLibrary.save(actor,{kind:'plan',name:`${actor}计划`,localDate:'2026-10-03',snapshot:{stops:[{stopId:'one',placeId:DEMO_SHANGHAI_PLACES[0].placeId,place:DEMO_SHANGHAI_PLACES[0],startMinutes:840,endMinutes:885,plannedDurationMinutes:45,status:'planned'}],routeLegs:[],plannedCharges:[]}});
test('initial plan context reads only the current actor, includes actual revisions and does not read for general questions',()=>{
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore()});seed(ctx);seed(ctx,'other');
  const before=JSON.stringify(ctx.planLibrary.list('owner'));
  assert.equal(initialAgentPlanContext(ctx,'owner','伴途怎么陪我参观？',false),null);
  const context=initialAgentPlanContext(ctx,'owner','我累了，想休息30分钟',false)!;
  assert.match(context,/owner计划/);assert.doesNotMatch(context,/other计划/);assert.match(context,/"revision":0/);assert.match(context,/不是保存、出发或完成的证明/);
  assert.equal(JSON.stringify(ctx.planLibrary.list('owner')),before);
});
test('real model dispatch can rest from a fresh prefetched plan using one tool round without inventing a write',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(request){
    if(++calls===1) {
      const context=request.messages.find(m=>m.role==='system'&&m.content?.includes('"source":"server-read-only"'))!;
      const {plans}=JSON.parse(context.content!.split('\n').at(-1)!);
      assert.ok(request.tools.some(t=>t.name==='plans.rest'));assert.ok(!request.tools.some(t=>t.name==='community.post_publish'));
      return modelTurn([toolCall('rest','plans.rest',{planId:plans[0].id,expectedRevision:plans[0].revision,minutes:30})]);
    }
    return modelTurn([],'休息30分钟，后续开始时间已顺延。');
  }}});seed(ctx);const result=await runPersonalAgent(ctx,'owner','我累了，要休息30分钟',[]);
  assert.equal(calls,2);assert.deepEqual(result.steps,[{tool:'plans.rest',ok:true}]);assert.equal(ctx.planLibrary.list('owner')[0].revision,1);
});
test('a compound creation request keeps genuine memories tools and completes both authorized operations',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(request){
    if(++calls===1){
      assert.ok(request.tools.some(tool=>tool.name==='memories.create'),'creation-only filtering must not remove a requested memory operation');
      return modelTurn([toolCall('search','places.search',{query:'武康大楼'})]);
    }
    if(calls===2){
      const catalog=JSON.parse(request.messages.find(message=>message.toolCallId==='search')!.content!).result;
      return modelTurn([toolCall('create','plans.create',{kind:'plan',name:'明日散步',localDate:'2026-10-04',days:[{stops:[{placeId:catalog.places[0].placeId,startMinutes:540,durationMinutes:45,transportMode:'walking'}]}]}),toolCall('note','memories.create',{title:'明日散步',text:'明天计划上午去武康大楼。'})]);
    }
    return modelTurn([],'日计划与这篇旅行记忆均已保存。');
  }}});
  const result=await runPersonalAgent(ctx,'owner','安排明天的行程，再记录一篇旅行记忆：标题明日散步，正文“明天计划上午去武康大楼。”',[]);
  assert.ok(result.steps.some(step=>step.tool==='plans.create'&&step.ok));assert.ok(result.steps.some(step=>step.tool==='memories.create'&&step.ok));
  assert.equal(ctx.planLibrary.list('owner').length,1);assert.equal(ctx.personalMemoriesService.list('owner').length,1);
  assert.equal(ctx.planLibrary.list('other').length,0);assert.equal(ctx.personalMemoriesService.list('other').length,0);
});
test('confirmation after restart advertises the original compound request tools without another discovery round',async()=>{
  let calls=0,schemeId='';const store=new MemoryStateStore();
  const options={seedDemo:false,now,stateStore:store,placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(request:import('../src/providers/model.js').ModelTurnRequest){
    if(++calls===1)return modelTurn([toolCall('load','plans.load',{schemeId,startDate:'2026-10-03'})]);
    if(calls===2){
      assert.ok(request.tools.some(tool=>tool.name==='favorites.set'),'confirmation must retain the original request to favorite a place');
      assert.ok(request.messages.some(message=>message.toolName==='plans.load'&&JSON.parse(message.content||'{}').result?.plans));
      return modelTurn([toolCall('favorite','favorites.set',{placeId:DEMO_SHANGHAI_PLACES[0].placeId,favorite:true})]);
    }
    return modelTurn([],'方案已载入，地点已收藏。');
  }}};
  const ctx=createServerContext(options);seed(ctx);
  schemeId=ctx.planLibrary.save('owner',{kind:'scheme',name:'散步方案',days:[{dayIndex:0,stops:[{stopId:'template',placeId:DEMO_SHANGHAI_PLACES[0].placeId,place:DEMO_SHANGHAI_PLACES[0],startMinutes:540,endMinutes:585,plannedDurationMinutes:45,status:'planned'}],routeLegs:[],plannedCharges:[]}]}).id;
  const pending=await runPersonalAgent(ctx,'owner','载入散步方案到今天，替换后把武康大楼加入收藏',[]);assert.match(pending.reply,/确认载入/);
  const restored=createServerContext(options);const completed=await runPersonalAgent(restored,'owner','确认载入',[]);
  assert.equal(calls,3);assert.ok(completed.steps.some(step=>step.tool==='favorites.set'&&step.ok));
  assert.equal(restored.favoritesService.list('owner').length,1);assert.equal(restored.favoritesService.list('other').length,0);
});
test('continuing an interrupted non-creation task advertises its original requested write tool',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(request){
    if(++calls===1)return {toolCalls:[],finishReason:'error' as const,error:{code:'MODEL_UNAVAILABLE',message:'fixture'},usage:{inputTokens:0,outputTokens:0}};
    if(calls===2){assert.ok(request.tools.some(tool=>tool.name==='favorites.set'));return modelTurn([toolCall('favorite','favorites.set',{placeId:DEMO_SHANGHAI_PLACES[0].placeId,favorite:true})]);}
    return modelTurn([],'地点已收藏。');
  }}});
  await runPersonalAgent(ctx,'owner','收藏武康大楼',[]);const completed=await runPersonalAgent(ctx,'owner','继续',[]);
  assert.equal(calls,3);assert.ok(completed.steps.some(step=>step.tool==='favorites.set'&&step.ok));assert.equal(ctx.favoritesService.list('owner').length,1);
});
test('an external edit after prefetch still rejects stale writes and can recover by rereading plans.list',async()=>{
  let calls=0,id='';
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(request){
    calls++;
    if(calls===1){const p=ctx.planLibrary.list('owner')[0];ctx.planLibrary.update('owner',p.id,{name:'外部编辑',localDate:p.localDate,expectedRevision:p.revision,snapshot:{stops:p.stops,routeLegs:p.routeLegs,plannedCharges:p.plannedCharges}});return modelTurn([toolCall('stale','plans.rest',{planId:id,expectedRevision:0,minutes:30})]);}
    if(calls===2){assert.match(request.messages.at(-1)!.content!,/计划已变化/);return modelTurn([toolCall('fresh','plans.list',{})]);}
    if(calls===3)return modelTurn([toolCall('retry','plans.rest',{planId:id,expectedRevision:1,minutes:30})]);
    return modelTurn([],'已休息30分钟。');
  }}});id=seed(ctx).id;const result=await runPersonalAgent(ctx,'owner','我要休息30分钟',[]);
  assert.deepEqual(result.steps.map(s=>[s.tool,s.ok]),[['plans.rest',false],['plans.list',true],['plans.rest',true]]);
  const saved=ctx.planLibrary.list('owner')[0];assert.equal(saved.revision,2);assert.equal(saved.name,'外部编辑');assert.equal((saved.stops[0] as any).startMinutes,870);
});

test('cancellation immediately aborts the active model round and an unrelated actor cannot cancel it',async()=>{
  let entered!:()=>void,aborted=false;
  const waiting=new Promise<void>(resolve=>entered=resolve);
  const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(request){
    assert.ok(request.signal);entered();
    return new Promise(resolve=>request.signal!.addEventListener('abort',()=>{aborted=true;resolve({toolCalls:[],finishReason:'error',error:{code:'MODEL_ABORTED',message:'cancelled'},usage:{inputTokens:0,outputTokens:0}});},{once:true}));
  }}});
  const pending=runPersonalAgent(ctx,'owner','保存一份笔记',[]);await waiting;
  const task=ctx.personalAgentTasks.current('owner')!;assert.throws(()=>ctx.personalAgentTasks.cancel('other',task.id));
  ctx.personalAgentTasks.cancel('owner',task.id);const result=await pending;
  assert.equal(aborted,true);assert.match(result.reply,/已停止后续操作/);assert.equal(ctx.personalMemoriesService.list('owner').length,0);assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');
  const next=ctx.personalAgentTasks.start('owner',[{role:'user',content:'新问题'}]);assert.equal(next.cancelRequested,undefined);
});

test('completed round cancellation listeners are removed and cannot cancel a later task',()=>{
  const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore()});const first=ctx.personalAgentTasks.start('owner',[]);let old=0,fresh=0;
  const cleanup=ctx.personalAgentTasks.onCancel('owner',first.id,()=>old++);cleanup();first.status='completed';
  const second=ctx.personalAgentTasks.start('owner',[]);ctx.personalAgentTasks.onCancel('owner',second.id,()=>fresh++);
  assert.throws(()=>ctx.personalAgentTasks.cancel('owner',first.id));ctx.personalAgentTasks.cancel('owner',second.id);
  assert.equal(old,0);assert.equal(fresh,1);assert.doesNotMatch(ctx.personalAgentTasks.serialize(),/cancelListeners/);
});
test('native context overflow stops the exhausted checkpoint without writing or exposing provider details',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(){
    if(++calls===1)return {toolCalls:[toolCall('unsafe','memories.create',{text:'未授权执行'})],finishReason:'error' as const,error:{code:'MODEL_CONTEXT_LIMIT',message:'fixture-provider-private-detail'},usage:{inputTokens:0,outputTokens:0},reasoningContent:'fixture-private-thinking'};
    return modelTurn([],'可以开始新问题。');
  }}});
  const failed=await runPersonalAgent(ctx,'owner','查看我的计划',[]);
  assert.match(failed.reply,/原生上下文容量不足.*任务尚未完成/);assert.match(failed.reply,/开启新对话/);assert.doesNotMatch(JSON.stringify(failed),/fixture-provider|fixture-private-thinking|已保存：/);
  assert.equal(failed.steps.length,0);assert.equal(ctx.personalMemoriesService.list('owner').length,0);assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');
  const fresh=await runPersonalAgent(ctx,'owner','新问题',[]);assert.equal(fresh.reply,'可以开始新问题。');
});
test('context overflow after a committed write truthfully preserves it and does not advise retrying the same checkpoint',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(){
    if(++calls===1)return modelTurn([toolCall('note','memories.create',{text:'已保存的原始笔记'})]);
    return {toolCalls:[],finishReason:'error' as const,error:{code:'MODEL_CONTEXT_LIMIT',message:'private'},usage:{inputTokens:0,outputTokens:0}};
  }}});
  const failed=await runPersonalAgent(ctx,'owner','记录一篇笔记',[]);
  assert.match(failed.reply,/笔记已保存.*原生上下文容量不足/s);assert.doesNotMatch(failed.reply,/稍后点击继续|已经完成全部/);
  assert.equal(ctx.personalMemoriesService.list('owner').length,1);assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');
});
test('timeout stays resumable while malformed, empty and refused turns report unfinished work with fixed safe messages',async()=>{
  const cases=[['MODEL_TIMEOUT',/等待超时/],['MODEL_BAD_TOOL_ARGS',/操作参数无效/],['MODEL_EMPTY_RESPONSE',/没有返回有效/],['MODEL_REFUSAL',/拒绝处理/],['UNRECOGNIZED',/暂时无法继续处理/]] as const;
  for(const [code,pattern] of cases){
    const ctx=createServerContext({seedDemo:false,stateStore:new MemoryStateStore(),modelProvider:{providerName:'fixture',modelName:'m',async generateTurn(){return {toolCalls:[],finishReason:'error' as const,error:{code,message:'fixture-private-provider-response'},usage:{inputTokens:0,outputTokens:0}};}}});
    const failed=await runPersonalAgent(ctx,'owner','请查看计划',[]);assert.match(failed.reply,pattern);assert.doesNotMatch(failed.reply,/fixture-private-provider-response|已完成全部/);
    assert.equal(ctx.planLibrary.list('owner').length,0);assert.equal(failed.steps.length,0);assert.equal(ctx.personalAgentTasks.current('owner')!.status,'interrupted');
  }
});
