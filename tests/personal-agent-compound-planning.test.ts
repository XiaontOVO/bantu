import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServerContext} from '../src/server/http/bootstrap.js';
import {MemoryStateStore} from '../src/persistence/state-store.js';
import {DemoPlaceProvider} from '../src/providers/travel.js';
import {DEMO_SHANGHAI_PLACES} from '../src/demo/demo-data.js';
import {modelTurn,toolCall,type ModelTurnRequest} from '../src/providers/model.js';
import {runPersonalAgent} from '../src/services/personal-agent-runtime.js';
import {planningGoalFromText,planningGoalsFromText} from '../src/services/personal-agent-planning-goal.js';

const now=()=> '2026-10-03T06:00:00.000Z';
const receipt=(request:ModelTurnRequest,id:string)=>{const message=request.messages.find(message=>message.role==='tool'&&message.toolCallId===id);return message?JSON.parse(message.content||'{}'):null;};
const makeDays=(days:number,stops:number)=>Array.from({length:days},()=>({stops:DEMO_SHANGHAI_PLACES.slice(0,stops).map((place,index)=>({placeId:place.placeId,startMinutes:540+90*index,durationMinutes:45}))}));

for(const action of ['favorite','compare','delete'] as const)test(`compound creation preserves full shape validation and performs ${action} through real tools`,async()=>{
  let oldId='',calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    calls++;
    if(!receipt(request,'search'))return modelTurn([toolCall('search','places.search',{})]);
    if(!receipt(request,'short'))return modelTurn([toolCall('short','plans.create',{kind:'scheme',name:'新三天方案',days:makeDays(1,2)})]);
    if(receipt(request,'short').ok)return modelTurn([],'三天方案已保存。');
    if(!receipt(request,'few')){
      assert.match(receipt(request,'short').error,/用户要求 3 天/);assert.equal(ctx.planLibrary.list('owner').length,1);
      return modelTurn([toolCall('few','plans.create',{kind:'scheme',name:'新三天方案',days:makeDays(3,1)})]);
    }
    if(!receipt(request,'full')){
      assert.match(receipt(request,'few').error,/每天 2 个地点/);assert.equal(ctx.planLibrary.list('owner').length,1);
      return modelTurn([toolCall('full','plans.create',{kind:'scheme',name:'新三天方案',days:makeDays(3,2)})]);
    }
    const created=receipt(request,'full').result;
    if(!receipt(request,'additional'))return modelTurn([toolCall('additional',action==='favorite'?'favorites.set':action==='compare'?'plans.compare':'plans.delete',action==='favorite'?{placeId:DEMO_SHANGHAI_PLACES[0].placeId,favorite:true}:action==='compare'?{planIds:[oldId,created.id]}:{planId:oldId})]);
    assert.equal(receipt(request,'additional').ok,true);
    return modelTurn([],'完整三天方案及后续操作已完成；交通时间仍待实际道路核对。');
  }}});
  oldId=ctx.planLibrary.save('owner',{kind:'scheme',name:'旧方案',days:makeDays(1,1).map((day,dayIndex)=>({dayIndex,stops:day.stops.map((stop,index)=>({...stop,stopId:`old-${index}`,endMinutes:stop.startMinutes+45,place:DEMO_SHANGHAI_PLACES[index]})),routeLegs:[],plannedCharges:[]}))}).id;
  const beforeOld=JSON.stringify(ctx.planLibrary.get('owner',oldId));
  const instruction=`生成三天方案，每天两个地点，然后${action==='favorite'?'把第一个地点加入收藏':action==='compare'?'对比旧方案':'删除旧方案'}`;
  const result=await runPersonalAgent(ctx,'owner',instruction,[]);
  const created=ctx.planLibrary.list('owner').find(plan=>plan.id!==oldId);
  assert.equal(created?.days?.length,3,'a later action must not disable explicit creation constraints');
  assert.ok(created.days.every(day=>day.stops.length===2));
  assert.deepEqual(result.steps.filter(step=>step.tool==='plans.create').map(step=>step.ok),[false,false,true]);
  assert.equal(ctx.planLibrary.list('other').length,0);
  if(action==='favorite')assert.equal(ctx.favoritesService.list('owner').length,1);
  if(action==='compare')assert.ok(result.steps.some(step=>step.tool==='plans.compare'&&step.ok));
  assert.equal(JSON.stringify(ctx.planLibrary.get('owner',oldId)),beforeOld,'old arrangements remain intact before deletion confirmation');
  if(action==='delete'){
    assert.match(result.reply,/确认删除/);assert.ok(ctx.personalAgentTasks.pendingAction('owner'));
    const confirmed=await runPersonalAgent(ctx,'owner','确认删除',[]);
    assert.ok(confirmed.steps.some(step=>step.tool==='plans.delete'&&step.ok));assert.equal(ctx.planLibrary.list('owner').length,1);
    assert.equal(ctx.planLibrary.list('owner')[0].days!.length,3);
  }
  assert.equal(calls,6);
});

test('a conversational claim cannot complete explicit creation even when a later action is requested',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){calls++;return modelTurn([],'三天方案已经安排好了。');}}});
  const result=await runPersonalAgent(ctx,'owner','生成三天方案，每天两个地点，然后把第一个地点加入收藏',[]);
  assert.equal(calls,3);assert.match(result.reply,/方案尚未保存/);assert.equal(ctx.planLibrary.list('owner').length,0);assert.equal(ctx.personalAgentTasks.current('owner')!.status,'interrupted');
});

test('negated creation still permits a separate favorite without forcing a new plan',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++calls===1?modelTurn([toolCall('favorite','favorites.set',{placeId:DEMO_SHANGHAI_PLACES[0].placeId,favorite:true})]):modelTurn([],'已收藏，未创建方案。');}}});
  const result=await runPersonalAgent(ctx,'owner','不要生成三天方案，只把武康大楼加入收藏',[]);
  assert.equal(calls,2);assert.equal(ctx.planLibrary.list('owner').length,0);assert.equal(ctx.favoritesService.list('owner').length,1);assert.equal(result.steps.length,1);
});

test('creation shape comes from the creation clause, while existing-plan edits and authored originals stay separate',()=>{
  for(const text of ['先对比旧七天方案，再生成三天方案，每天两个地点','生成三天方案后加入收藏，每天两个地点','生成三天方案，每天两个地点，再把原方案改成一日游'])assert.deepEqual(planningGoalFromText(text),{days:3,stopsPerDay:2});
  for(const text of ['修改三天旅行方案并保存','把地点加入今天计划','不要生成三天方案，只收藏地点','取消创建三天方案','保存笔记，原文是“生成三天方案后加入收藏”'])assert.equal(planningGoalFromText(text),null,text);
});

test('multiple creation targets keep separate constraints and require separate successful objects',async()=>{
  const instruction='生成三天方案A，每天两个地点，再生成两天方案B，每天一个地点';
  assert.deepEqual(planningGoalsFromText(instruction),[{creationIndex:1,days:3,stopsPerDay:2},{creationIndex:2,days:2,stopsPerDay:1}]);
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    calls++;
    if(!receipt(request,'ambiguous'))return modelTurn([toolCall('ambiguous','plans.create',{kind:'scheme',name:'A',days:makeDays(3,2)})]);
    assert.match(receipt(request,'ambiguous').error,/creationIndex/);
    if(!receipt(request,'a'))return modelTurn([toolCall('a','plans.create',{creationIndex:1,kind:'scheme',name:'A',days:makeDays(3,2)})]);
    if(!receipt(request,'wrong-b'))return modelTurn([toolCall('wrong-b','plans.create',{creationIndex:2,kind:'scheme',name:'B',days:makeDays(3,1)})]);
    assert.match(receipt(request,'wrong-b').error,/用户要求 2 天/);
    if(!receipt(request,'b'))return modelTurn([toolCall('b','plans.create',{creationIndex:2,kind:'scheme',name:'B',days:makeDays(2,1)})]);
    return modelTurn([],'两份方案已保存。');
  }}});
  const result=await runPersonalAgent(ctx,'owner',instruction,[]);
  assert.equal(calls,5);assert.deepEqual(result.steps.map(step=>step.ok),[false,true,false,true]);
  assert.deepEqual(ctx.planLibrary.list('owner').map(plan=>[plan.name,plan.days?.length]).sort(),[['A',3],['B',2]]);
  assert.equal(ctx.personalAgentTasks.current('owner')!.status,'completed');
});

test('a missing second creation cannot complete, and continuation preserves the first receipt without duplication',async()=>{
  const store=new MemoryStateStore();let round=0;
  const first=createServerContext({seedDemo:false,now,stateStore:store,placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(){return ++round===1?modelTurn([toolCall('a','plans.create',{creationIndex:1,kind:'scheme',name:'A',days:makeDays(3,2)})]):modelTurn([],'A和B已保存。');}}});
  const result=await runPersonalAgent(first,'owner','生成三天方案A，每天两个地点，再生成两天方案B，每天一个地点',[]);
  assert.match(result.reply,/尚未保存/);assert.equal(first.planLibrary.list('owner').length,1);assert.equal(first.personalAgentTasks.current('owner')!.status,'interrupted');
  let continuedRound=0;
  const restored=createServerContext({seedDemo:false,now,stateStore:store,placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    assert.ok(request.messages.some(message=>message.role==='user'&&message.content?.includes('生成两天方案B')));
    if(++continuedRound===1)return modelTurn([toolCall('replay','plans.create',{creationIndex:1,kind:'scheme',name:'A',days:makeDays(3,2)}),toolCall('b','plans.create',{creationIndex:2,kind:'scheme',name:'B',days:makeDays(2,1)})]);
    return modelTurn([],'两份方案已保存。');
  }}});
  await runPersonalAgent(restored,'owner','继续',[]);
  assert.equal(restored.planLibrary.list('owner').length,2);assert.equal(restored.personalAgentTasks.current('owner')!.status,'completed');
});

test('quoted or explicitly analyzed source commands do not authorize creation',()=>{
  for(const text of ['解释这段文字：“生成三天方案”','分析这句指令：生成三天方案，每天两个地点','阅读笔记，原文是“生成三天方案”'])assert.equal(planningGoalFromText(text),null,text);
});

test('leading daily constraints belong to their own explicit creation without leaking across targets',()=>{
  assert.deepEqual(planningGoalFromText('每天两个地点，生成三天方案'),{days:3,stopsPerDay:2});
  for(const text of ['每天两个地点，生成三天方案A；每天一个地点，生成两天方案B','生成三天方案A，每天两个地点，另外每天一个地点，生成两天方案B'])assert.deepEqual(planningGoalsFromText(text),[{creationIndex:1,days:3,stopsPerDay:2},{creationIndex:2,days:2,stopsPerDay:1}],text);
  assert.equal(planningGoalFromText('每天两个地点，解释这段原文：“生成三天方案”'),null);
  assert.deepEqual(planningGoalsFromText('安排北京一日游，生成方案'),[{creationIndex:1,days:1}]);
});

test('an explicitly prohibited creation is rejected while the separately authorized favorite succeeds',async()=>{
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now,stateStore:new MemoryStateStore(),placeProvider:new DemoPlaceProvider(),modelProvider:{providerName:'controlled',modelName:'fixture',async generateTurn(request){
    if(++calls===1)return modelTurn([toolCall('forbidden','plans.create',{kind:'scheme',name:'未授权方案',days:makeDays(3,2)}),toolCall('favorite','favorites.set',{placeId:DEMO_SHANGHAI_PLACES[0].placeId,favorite:true})]);
    assert.equal(receipt(request,'forbidden').ok,false);assert.equal(receipt(request,'favorite').ok,true);return modelTurn([],'已收藏地点。');
  }}});
  await runPersonalAgent(ctx,'owner','不要生成三天方案，只收藏第一个地点',[]);
  assert.equal(ctx.planLibrary.list('owner').length,0);assert.equal(ctx.favoritesService.list('owner').length,1);assert.equal(calls,2);
});
