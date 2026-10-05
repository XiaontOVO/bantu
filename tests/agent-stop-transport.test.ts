import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { planAgentRoutes } from '../src/services/personal-agent-routes.js';
import type { ModelTurn, ModelTurnRequest } from '../src/providers/model.js';

test('agent can change an existing first stop without pretending it has an origin', async () => {
  let args: Record<string,unknown>={};
  let calls=0;
  const ctx=createServerContext({seedDemo:false,now:()=> '2026-10-01T01:00:00Z',modelProvider:{providerName:'controlled',modelName:'controlled',async generateTurn():Promise<ModelTurn>{
    if(++calls===1)return{toolCalls:[{callId:'first-mode',name:'plans.set_transport',arguments:args}],finishReason:'tool_calls',usage:{inputTokens:1,outputTokens:1}};
    return{text:'已保存选择，首站路程需当前位置。',toolCalls:[],finishReason:'stop',usage:{inputTokens:1,outputTokens:1}};
  }}});
  const places=(await ctx.fallbackPlaceProvider.search({cityCode:'310100',limit:2})).places;
  const plan=ctx.planLibrary.save('owner',{kind:'plan',name:'改首站方式',localDate:'2026-10-02',snapshot:{stops:places.map((place,index)=>({stopId:`s${index}`,place,status:'planned',startMinutes:600+index*90,endMinutes:645+index*90,preferredTransportMode:'walking'})),routeLegs:[],plannedCharges:[]}});
  args={planId:plan.id,expectedRevision:0,stopId:'s0',mode:'transit'};
  const result=await runPersonalAgent(ctx,'owner','把第一站的交通方式改为公共交通，只改选择，不调整时间或其他站。',[]);
  assert.ok(result.steps.some(step=>step.tool==='plans.set_transport'&&step.ok),result.reply);
  const updated=ctx.planLibrary.list('owner')[0];
  assert.equal((updated.stops[0] as any).preferredTransportMode,'transit');
  // Compare stored fields; list() also derives forecast fields for every stop.
  assert.deepEqual(ctx.planLibrary.get('owner',plan.id).stops[1],plan.stops[1]);
  assert.equal((updated.stops[0] as any).startMinutes,600);
  assert.equal(updated.routeLegs.length,0);
  assert.equal(updated.executionEvents?.length || 0,0);
  assert.equal(updated.revision,1);
});

test('agent saves each destination mode including the first before roads are available', async () => {
  let calls = 0;
  let ids: string[] = [];
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-10-01T01:00:00Z', modelProvider: {
    providerName: 'controlled', modelName: 'controlled', async generateTurn(request: ModelTurnRequest): Promise<ModelTurn> {
      calls++;
      if (calls === 1) return {toolCalls:[{callId:'create-mixed',name:'plans.create',arguments:{name:'逐站交通',kind:'plan',localDate:'2026-10-02',days:[{stops:ids.map((placeId,index)=>({placeId,startMinutes:600+index*90,durationMinutes:45,transportMode:['driving','transit','walking'][index]}))}]}}],finishReason:'tool_calls',usage:{inputTokens:1,outputTokens:1}};
      return {text:'已按逐地点交通选择保存。',toolCalls:[],finishReason:'stop',usage:{inputTokens:1,outputTokens:1}};
    },
  }});
  ids = (await ctx.fallbackPlaceProvider.search({cityCode:'310100',limit:3})).places.map(p=>p.placeId);
  const result = await runPersonalAgent(ctx,'owner','安排明天三个地点，去第一站驾车，第二站公共交通，第三站步行，每站45分钟，直接保存日计划。',[]);
  assert.ok(result.steps.some(step=>step.tool==='plans.create'&&step.ok),result.reply);
  const plan = ctx.planLibrary.list('owner')[0];
  assert.deepEqual(plan.stops.map((stop:any)=>stop.preferredTransportMode),['driving','transit','walking']);
  assert.equal(plan.routeLegs.length,0,'saving a preference never invents roads or first-stop location');
  assert.equal(plan.executionEvents?.length || 0,0);
});

test('agent road calculation follows saved destination choices and keeps the first preference', async () => {
  const modes: string[]=[];
  const ctx=createServerContext({seedDemo:false,routeProvider:{providerName:'controlled-roads',async plan(input){
    modes.push(input.transportMode);return{departureSupport:'current_only',leg:{legId:'controlled',fromStopId:'',toStopId:'',transportMode:input.transportMode,durationMinutes:10}};
  }}});
  const places=(await ctx.fallbackPlaceProvider.search({cityCode:'310100',limit:3})).places;
  const plan=ctx.planLibrary.save('owner',{kind:'scheme',name:'交通分别选择',days:[{dayIndex:0,stops:places.map((place,index)=>({stopId:`s${index}`,placeId:place.placeId,place,status:'planned',startMinutes:600+index*90,endMinutes:645+index*90,preferredTransportMode:['driving','transit','walking'][index]})),routeLegs:[],plannedCharges:[]}]});
  const result=await planAgentRoutes(ctx,'owner',{planId:plan.id,expectedRevision:0,dayIndex:0});
  assert.deepEqual(modes,['transit','walking']);
  assert.deepEqual(result.days![0].stops.map((stop:any)=>stop.preferredTransportMode),['driving','transit','walking']);
  assert.deepEqual(result.days![0].routeLegs.map((leg:any)=>leg.transportMode),['transit','walking']);
  assert.equal((result.days![0].stops[0] as any).startMinutes,600);
});

test('agent segment mode changes update the destination selector without altering other choices', async () => {
  const ctx=createServerContext({seedDemo:false,routeProvider:{providerName:'controlled-roads',async plan(input){return{departureSupport:'current_only',leg:{legId:'controlled',fromStopId:'',toStopId:'',transportMode:input.transportMode,durationMinutes:10}}}}});
  const places=(await ctx.fallbackPlaceProvider.search({cityCode:'310100',limit:3})).places;
  const plan=ctx.planLibrary.save('owner',{kind:'scheme',name:'单站切换',days:[{dayIndex:0,stops:places.map((place,index)=>({stopId:`s${index}`,placeId:place.placeId,place,status:'planned',startMinutes:600+index*90,endMinutes:645+index*90,preferredTransportMode:'walking'})),routeLegs:[],plannedCharges:[]}]});
  const result=await planAgentRoutes(ctx,'owner',{planId:plan.id,expectedRevision:0,dayIndex:0,toStopId:'s1',mode:'driving'});
  assert.deepEqual(result.days![0].stops.map((stop:any)=>stop.preferredTransportMode),['walking','driving','walking']);
  assert.equal((result.days![0].routeLegs[0] as any).transportMode,'driving');
  assert.deepEqual(result.days![0].stops[0],plan.days![0].stops[0]);
  assert.equal((result.days![0].stops[2] as any).endMinutes-(result.days![0].stops[2] as any).startMinutes,45);
});
