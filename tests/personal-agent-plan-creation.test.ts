import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { modelTurn, toolCall } from '../src/providers/model.js';
import { DemoPlaceProvider } from '../src/providers/travel.js';
import { DEMO_SHANGHAI_PLACES } from '../src/demo/demo-data.js';
import { PersonalAgentPlaces } from '../src/services/personal-agent-places.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { planningGoalFromText } from '../src/services/personal-agent-planning-goal.js';
import { agentCatalogScope } from '../src/services/personal-agent-catalog-scope.js';
import type { PlanStop, RouteLeg } from '../src/domain/types.js';

const now = () => '2026-09-30T01:00:00.000Z';
const catalog = async () => structuredClone(await new DemoPlaceProvider().search({ cityCode: '310100', limit: 2 }));

test('an edit after creation uses this instruction rather than the old planning goal in chat history',async()=>{
  const found=await catalog();let calls=0,planId='',stopId='',revision=0;
  const ctx=createServerContext({seedDemo:false,now,modelProvider:{providerName:'controlled',modelName:'controlled',async generateTurn(request){
    calls++;
    assert.ok(request.tools.some(tool=>tool.name==='plans.adjust_stop'),'editing tool is hidden by a past creation request');
    if(calls===1)return modelTurn([toolCall('adjust','plans.adjust_stop',{planId,stopId,expectedRevision:revision,startMinutes:840,durationMinutes:30})]);
    return modelTurn([],'已将游览时长调整为30分钟。');
  }}});
  const westBund=DEMO_SHANGHAI_PLACES.find(place=>place.name==='西岸美术馆')!;
  const plan=ctx.planLibrary.save('owner',{name:'半日慢行',kind:'plan',localDate:'2026-09-30',snapshot:{stops:[
    {stopId:'first',place:found.places[0],status:'planned',startMinutes:540,endMinutes:585,plannedDurationMinutes:45,minDurationMinutes:45},
    {stopId:'middle',place:found.places[1],status:'planned',startMinutes:660,endMinutes:705,plannedDurationMinutes:45,minDurationMinutes:45},
    {stopId:'last',place:westBund,status:'planned',startMinutes:840,endMinutes:885,plannedDurationMinutes:45,minDurationMinutes:45},
  ],routeLegs:[],plannedCharges:[]}});
  ctx.planLibrary.recordExecution('owner',plan.id,{stopId:'first',type:'depart',occurredAt:now(),expectedRevision:0});
  const departed=ctx.planLibrary.get('owner',plan.id);
  ctx.planLibrary.recordExecution('owner',plan.id,{stopId:'first',type:'arrive',occurredAt:now(),expectedRevision:departed.revision});
  const before=ctx.planLibrary.get('owner',plan.id);
  revision=before.revision!;
  planId=plan.id;stopId='last';
  const result=await runPersonalAgent(ctx,'owner','最后一站西岸美术馆游览时间改成30分钟，其余开始时间和已有进度保留，直接修改今天的日计划，不创建新方案。',[
    {role:'user',content:'今天下午两点开始上海半日游，直接保存今天的日计划。'},
    {role:'assistant',content:'已保存日计划「半日慢行」。'},
  ]);
  assert.equal(calls,2,'a successful edit must not be forced to create again');
  assert.equal(ctx.planLibrary.list('owner').length,1);
  const after=ctx.planLibrary.get('owner',plan.id);
  assert.equal((after.stops[2] as PlanStop).plannedDurationMinutes,30);
  assert.deepEqual(after.executionEvents,before.executionEvents,'an edit preserves recorded departure and arrival');
  assert.deepEqual(after.stops.slice(0,2),before.stops.slice(0,2),'other stops retain timing and actual progress');
  assert.ok(result.steps.some(step=>step.tool==='plans.adjust_stop'&&step.ok));
  assert.equal(ctx.personalAgentTasks.current('owner')?.status,'completed');
});

test('editing an old plan and separately requesting a new scheme performs both operations',async()=>{
  const found=await catalog();let calls=0,planId='';
  const ctx=createServerContext({seedDemo:false,now,modelProvider:{providerName:'controlled',modelName:'controlled',async generateTurn(request){
    if(++calls===1){
      assert.ok(request.tools.some(tool=>tool.name==='plans.adjust_stop'));
      assert.ok(request.tools.some(tool=>tool.name==='plans.create'));
      return modelTurn([
        toolCall('edit-old','plans.adjust_stop',{planId,stopId:'old-last',expectedRevision:0,startMinutes:840,durationMinutes:30}),
        toolCall('create-new','plans.create',{kind:'scheme',name:'另外的新方案',days:[{stops:[{placeId:found.places[0].placeId,startMinutes:600,durationMinutes:60}]}]}),
      ]);
    }
    return modelTurn([],'已修改旧计划，并单独创建新方案。');
  }}});
  planId=ctx.planLibrary.save('owner',{name:'旧日计划',kind:'plan',localDate:'2026-09-30',snapshot:{stops:[{stopId:'old-last',place:found.places[0],status:'planned',startMinutes:840,endMinutes:885,plannedDurationMinutes:45}],routeLegs:[],plannedCharges:[]}}).id;
  const result=await runPersonalAgent(ctx,'owner','修改旧日计划，把最后一站游览时间改成30分钟；另外创建新方案「另外的新方案」，明天10点去武康大楼，游览60分钟。',[]);
  assert.equal(calls,2);
  assert.ok(result.steps.some(step=>step.tool==='plans.adjust_stop'&&step.ok));
  assert.ok(result.steps.some(step=>step.tool==='plans.create'&&step.ok));
  assert.equal(ctx.planLibrary.list('owner').length,2);
  assert.equal((ctx.planLibrary.get('owner',planId).stops[0] as PlanStop).plannedDurationMinutes,30);
  assert.equal(ctx.planLibrary.list('owner').find(plan=>plan.name==='另外的新方案')?.kind,'scheme');
});

test('a seven-day plan saves all repeated visits and routes even when the detail API is unavailable', async () => {
  const found = await catalog(); let detailCalls = 0, routeCalls = 0, round = 0;
  const ctx = createServerContext({ seedDemo: false, now,
    placeProvider: { providerName: 'live-fixture', search: async () => found, detail: async () => { detailCalls++; throw new Error('详情接口限流'); } },
    routeProvider: { providerName: 'live-route-fixture', async plan(input) {
      routeCalls++; assert.equal(input.transportMode, 'walking');
      return { departureSupport: 'current_only', leg: { legId: 'upstream', fromStopId: '', toStopId: '', transportMode: 'walking', durationMinutes: 20, bufferMinutes: 5 } };
    } },
    modelProvider: { providerName: 'test', modelName: 'test', async generateTurn(request) {
      round++;
      if (round === 1) return modelTurn([toolCall('catalog', 'places.search', {})]);
      if (round === 2) return { toolCalls: [], text: '正在整理七天安排', finishReason: 'length', usage: { inputTokens: 1, outputTokens: 3000 } };
      if (round === 3) {
        assert.equal(request.maxOutputTokens, 16384);
        const places = JSON.parse(request.messages.find(m => m.toolCallId === 'catalog')!.content!).result.places;
        return modelTurn([toolCall('save', 'plans.create', { kind: 'scheme', name: '七天轻松游', days: Array.from({ length: 7 }, () => ({ stops: places.map((p: any, i: number) => ({ placeId: p.placeId, startMinutes: 540 + 90 * i, durationMinutes: 60 })) })) })]);
      }
      if (round === 4) {
        const saved = JSON.parse(request.messages.find(m => m.toolCallId === 'save')!.content!);
        assert.equal(saved.ok, true); assert.equal(saved.result.days.length, 7);
        return modelTurn(Array.from({ length: 7 }, (_, dayIndex) => toolCall(`route-${dayIndex}`, 'plans.route', { planId: saved.result.id, expectedRevision: dayIndex, dayIndex, mode: 'walking' })));
      }
      return modelTurn([], '七天方案和路线已保存。');
    } },
  });
  const result = await runPersonalAgent(ctx, 'owner', '保存七天方案，每天去同样两个地点，步行', []);
  assert.equal(detailCalls, 0, 'verified search coordinates must not depend on the detail endpoint');
  assert.equal(routeCalls, 7);
  const plans = ctx.planLibrary.list('owner'); assert.equal(plans.length, 1);
  assert.equal(plans[0].days!.length, 7);
  const stops = plans[0].days!.flatMap(day => day.stops as PlanStop[]);
  assert.equal(stops.length, 14); assert.equal(new Set(stops.map(stop => stop.stopId)).size, 14);
  for (const day of plans[0].days!) {
    const visits = day.stops as PlanStop[], legs = day.routeLegs as RouteLeg[];
    assert.equal(legs.length, 1); assert.equal(legs[0].fromStopId, visits[0].stopId); assert.equal(legs[0].toStopId, visits[1].stopId);
  }
  assert.deepEqual(result.refresh, ['plans']); assert.equal(ctx.personalAgentTasks.current('owner')!.status, 'completed');
  assert.equal(ctx.planLibrary.list('other').length, 0);
});

test('task place reads are cloned; explicit details refresh or invalidate the searched location', async () => {
  const found = await catalog(); let calls = 0;
  const directory = new PersonalAgentPlaces({ providerName: 'test', search: async () => found, detail: async id => {
    calls++; return calls === 1 ? { ...found.places[0], name: '最新名称', placeId: id } : null;
  } }, now);
  const first = await directory.search({ cityCode: '310100' }); first.places[0].name = '外部修改';
  const id = found.places[0].placeId;
  assert.notEqual((await directory.resolve(id))!.name, '外部修改'); assert.equal(calls, 0);
  assert.equal((await directory.detail(id))!.name, '最新名称'); assert.equal((await directory.resolve(id))!.name, '最新名称');
  assert.equal(await directory.detail(id), null); assert.equal(await directory.resolve(id), null); assert.equal(calls, 3);
});

test('resume uses recent search receipts from the same task and creates only one complete scheme', async () => {
  const store = new MemoryStateStore(), found = await catalog(); let details = 0;
  const options = { seedDemo: false, stateStore: store, now, placeProvider: { providerName: 'test', search: async () => found, detail: async () => { details++; throw new Error('详情不可用'); } } };
  const first = createServerContext({ ...options, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn(request) {
    if (request.messages.some(m => m.role === 'tool')) throw new Error('连接中断');
    return modelTurn([toolCall('search', 'places.search', {})]);
  } } });
  await runPersonalAgent(first, 'owner', '创建完整七天方案', []);
  const tasks = JSON.parse(store.get('bantu-trip-service:personal-agent-tasks')!);
  tasks[0].messages = tasks[0].messages.filter((m: any) => !(m.role === 'system' && m.content?.startsWith('规划流程：')));
  store.set('bantu-trip-service:personal-agent-tasks', JSON.stringify(tasks));
  const restored = createServerContext({ ...options, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn(request) {
    assert.ok(request.messages.some(m => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('规划流程：')), 'existing checkpoints receive current planning guidance');
    if (request.messages.some(m => m.toolName === 'plans.create')) return modelTurn([], '已完成');
    return modelTurn([toolCall('save', 'plans.create', { kind: 'scheme', name: '续办方案', days: Array.from({ length: 7 }, () => ({ stops: [{ placeId: found.places[0].placeId, startMinutes: 600, durationMinutes: 60 }] })) })]);
  } } });
  const result = await runPersonalAgent(restored, 'owner', '继续', []);
  assert.equal(details, 0); assert.equal(restored.planLibrary.list('owner').length, 1); assert.equal(restored.planLibrary.list('owner')[0].days!.length, 7);
  assert.deepEqual(result.refresh, ['plans']);
  const other = new PersonalAgentPlaces(options.placeProvider, now); await assert.rejects(() => other.resolve(found.places[0].placeId), /详情不可用/);
});

test('unknown IDs and failed routes remain failures rather than fabricated saved data', async () => {
  let round = 0;
  const ctx = createServerContext({ seedDemo: false, now,
    placeProvider: { providerName: 'test', search: async () => catalog(), detail: async () => null },
    routeProvider: { providerName: 'test', async plan() { return { departureSupport: 'current_only', leg: { legId: 'bad', fromStopId: '', toStopId: '', transportMode: 'walking' }, error: { code: 'OUTAGE', message: '道路查询暂不可用' } }; } },
    modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
      if (++round === 1) return modelTurn([toolCall('search', 'places.search', {})]);
      if (round === 2) { const found = await catalog(); return modelTurn([toolCall('route', 'routes.estimate', { fromPlaceId: found.places[0].placeId, toPlaceId: found.places[1].placeId, mode: 'walking' }), toolCall('unknown', 'plans.create', { kind: 'scheme', name: '虚构地点', days: [{ stops: [{ placeId: 'made-up', startMinutes: 600, durationMinutes: 60 }] }] })]); }
      return modelTurn([], '道路未知，地点未找到，未保存。');
    } },
  });
  const result = await runPersonalAgent(ctx, 'owner', '规划出行', []);
  assert.deepEqual(result.steps.map(s => s.ok), [true, false, false]); assert.match(result.steps[1].error!, /道路查询/);
  assert.equal(ctx.planLibrary.list('owner').length, 0);
});

test('expired, future or unsuccessful place receipts require a fresh lookup', async () => {
  const found = await catalog(); let reads = 0;
  const directory = new PersonalAgentPlaces({ providerName: 'test', search: async () => found, detail: async () => { reads++; return null; } }, now);
  for (const [readAt, ok] of [['2026-09-29T01:00:00Z', true], ['2026-10-01T01:00:00Z', true], [now(), false]] as const) {
    directory.restore([{ role: 'tool', toolName: 'places.search', toolCallId: 'search', content: JSON.stringify({ ok, result: { ...found, readAt } }) }]);
    assert.equal(await directory.resolve(found.places[0].placeId), null);
  }
  assert.equal(reads, 3);
});

test('truncated tool arguments retry once with more budget; repeatedly truncated replies stay resumable', async () => {
  let calls = 0;
  const ctx = createServerContext({ seedDemo: false, now, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn(request) {
    calls++; if (calls === 1) return { toolCalls: [], finishReason: 'error', error: { code: 'MODEL_TOOL_ARGS_TRUNCATED', message: '截断' }, usage: { inputTokens: 1, outputTokens: 3000 } };
    assert.equal(request.maxOutputTokens, 16384); assert.equal(request.timeoutMs, 60000);
    return { toolCalls: [], text: '尚未完成', finishReason: 'length', usage: { inputTokens: 1, outputTokens: 6000 } };
  } } });
  const result = await runPersonalAgent(ctx, 'owner', '创建七天方案', []);
  assert.equal(calls, 2); assert.equal(ctx.personalAgentTasks.current('owner')!.status, 'interrupted'); assert.equal(ctx.planLibrary.list('owner').length, 0);
  assert.match(result.reply, /尚未完成/);
});

test('planning intent keeps explicit day and per-day stop counts without mistaking edits for creation', () => {
  assert.deepEqual(planningGoalFromText('帮我生成国庆七天旅行方案，每天两个地点，不要载入日计划'), { days: 7, stopsPerDay: 2 });
  assert.equal(planningGoalFromText('把一个地点加入今天计划'), null);
  assert.equal(planningGoalFromText('删除七天旅行方案'), null);
  assert.deepEqual(agentCatalogScope('安排北京一日游'), { cityCode: '110100', explicitCity: true });
  assert.deepEqual(agentCatalogScope('安排浦东一日游'), { cityCode: '310100', districtAdcode: '310115', explicitCity: true });
});

test('an explicitly named city controls search and the saved plan city', async () => {
  const place = { ...(await catalog()).places[0], placeId: 'beijing-test-place', name: '北京测试馆', cityCode: '110100', districtAdcode: '110101' };
  let rounds = 0;
  const ctx = createServerContext({ seedDemo: false, now,
    placeProvider: { providerName: 'beijing-fixture', search: async input => {
      assert.equal(input.cityCode, '110100'); assert.equal(input.districtAdcode, undefined);
      return { places: [place], empty: false };
    }, detail: async () => null },
    modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
      rounds++;
      if (rounds === 1) return modelTurn([toolCall('search-city', 'places.search', { query: '测试馆' })]);
      if (rounds === 2) return modelTurn([toolCall('save-city', 'plans.create', { kind: 'scheme', name: '北京一日游', days: [{ stops: [{ placeId: place.placeId, startMinutes: 540, durationMinutes: 60 }] }] })]);
      return modelTurn([], '北京方案已保存');
    } },
  });
  const result = await runPersonalAgent(ctx, 'owner', '安排北京一日游，生成方案', []);
  assert.equal(ctx.planLibrary.list('owner')[0].cityCode, '110100');
  assert.match(result.reply, /已保存/);
});

test('a vague model reply cannot finish a planning task; incomplete days are rejected before writing', async () => {
  const found = await catalog(); let round = 0;
  const makeDays = (length: number) => Array.from({ length }, () => ({ stops: found.places.map((place, index) => ({
    placeId: place.placeId, startMinutes: 540 + index * 90, durationMinutes: 60,
  })) }));
  const ctx = createServerContext({ seedDemo: false, now,
    placeProvider: { providerName: 'test', search: async () => found, detail: async () => null },
    modelProvider: { providerName: 'test', modelName: 'test', async generateTurn(request) {
      round++;
      if (round === 1) {
        assert.equal(request.maxOutputTokens, 8192);
        assert.ok(request.tools.some(tool => tool.name === 'plans.create'));
        assert.ok(!request.tools.some(tool => tool.name === 'memories.create'));
        assert.ok(!request.tools.some(tool => tool.name === 'routes.estimate'), 'creation should save before making duplicate road queries');
        return modelTurn([], '我建议您先想想要去哪儿。');
      }
      if (round === 2) return modelTurn([toolCall('search', 'places.search', {})]);
      if (round === 3) return modelTurn([toolCall('short', 'plans.create', { kind: 'scheme', name: '七天行程', days: makeDays(1) })]);
      if (round === 4) {
        assert.equal(ctx.planLibrary.list('owner').length, 0);
        assert.match(request.messages.find(message => message.toolCallId === 'short')?.content || '', /用户要求 7 天/);
        return modelTurn([toolCall('full', 'plans.create', { kind: 'scheme', name: '七天行程', days: makeDays(7) })]);
      }
      return modelTurn([], '七天方案已保存。');
    } },
  });
  const result = await runPersonalAgent(ctx, 'owner', '生成七天旅行方案，每天两个地点，不要载入日计划', []);
  assert.equal(round, 5);
  assert.equal(ctx.planLibrary.list('owner')[0].days!.length, 7);
  assert.equal(ctx.planLibrary.list('owner')[0].days!.flatMap(day => day.stops).length, 14);
  assert.equal(result.steps.find(step => step.tool === 'plans.create' && !step.ok)?.error?.includes('7 天'), true);
  assert.match(result.reply, /已保存/);
});

test('repeated conversational replies report that no plan was saved', async () => {
  let round = 0;
  const ctx = createServerContext({ seedDemo: false, now, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
    round++; return modelTurn([], '可以考虑去几个有趣的地方。');
  } } });
  const result = await runPersonalAgent(ctx, 'owner', '安排徐汇一日游，生成方案', []);
  assert.equal(round, 3);
  assert.equal(ctx.planLibrary.list('owner').length, 0);
  assert.equal(ctx.personalAgentTasks.current('owner')?.status, 'interrupted');
  assert.match(result.reply, /方案尚未保存/);
  assert.doesNotMatch(result.reply, /已完成|已保存/);
});

test('Continue gets a fresh bounded planning window instead of immediately repeating the old limit', async () => {
  let rounds = 0;
  const ctx = createServerContext({ seedDemo: false, now,
    placeProvider: { providerName: 'empty-test', search: async () => ({ places: [], empty: true }), detail: async () => null },
    modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
      rounds++;
      return modelTurn([toolCall(`search-${rounds}`, 'places.search', { query: '不存在的地点' })]);
    } },
  });
  const first = await runPersonalAgent(ctx, 'owner', '生成七天方案', []);
  assert.equal(rounds, 64);
  assert.match(first.reply, /方案尚未保存/);
  assert.equal(ctx.personalAgentTasks.current('owner')?.status, 'interrupted');
  const continued = await runPersonalAgent(ctx, 'owner', '继续', []);
  assert.equal(rounds, 128);
  assert.match(continued.reply, /方案尚未保存/);
  assert.equal(ctx.personalAgentTasks.current('owner')?.status, 'interrupted');
  await runPersonalAgent(ctx, 'owner', '继续', []);
  await runPersonalAgent(ctx, 'owner', '继续', []);
  assert.equal(rounds, 256);
  assert.equal(ctx.personalAgentTasks.current('owner')?.status, 'completed');
});

test('provider rate limiting stops repeated road calls after the place plan has been saved', async () => {
  const found = await catalog(); let rounds = 0, roadCalls = 0;
  const ctx = createServerContext({ seedDemo: false, now,
    placeProvider: { providerName: 'test', search: async () => found, detail: async () => null },
    routeProvider: { providerName: 'rate-limited', async plan() {
      roadCalls++;
      return { departureSupport: 'current_only', leg: { legId: 'unavailable', fromStopId: '', toStopId: '', transportMode: 'walking' }, error: { code: 'CUQPS_HAS_EXCEEDED_THE_LIMIT', message: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' } };
    } },
    modelProvider: { providerName: 'test', modelName: 'test', async generateTurn(request) {
      rounds++;
      if (rounds === 1) return modelTurn([toolCall('search', 'places.search', {})]);
      if (rounds === 2) return modelTurn([toolCall('save', 'plans.create', { kind: 'scheme', name: '徐汇一日游', days: [{ stops: found.places.map((place, index) => ({ placeId: place.placeId, startMinutes: 540 + 90 * index, durationMinutes: 60 })) }] })]);
      const saved = JSON.parse(request.messages.find(message => message.toolCallId === 'save')!.content!).result;
      return modelTurn([toolCall(`route-${rounds}`, 'plans.route', { planId: saved.id, expectedRevision: saved.revision || 0, dayIndex: 0, mode: 'walking' })]);
    } },
  });
  const result = await runPersonalAgent(ctx, 'owner', '安排徐汇一日游，生成方案', []);
  assert.equal(rounds, 3, `a supplier limit should stop the loop instead of requesting the same roads again: ${JSON.stringify(result.steps.slice(0, 5))}`);
  assert.equal(roadCalls, 1);
  assert.equal(ctx.planLibrary.list('owner').length, 1);
  assert.match(result.reply, /已保存/);
  assert.match(result.reply, /限流/);
  assert.equal(ctx.personalAgentTasks.current('owner')?.status, 'completed');
});

test('model interruption after saving reports the committed plan separately from unfinished roads', async () => {
  const found = await catalog(); let rounds = 0;
  const ctx = createServerContext({ seedDemo: false, now,
    placeProvider: { providerName: 'test', search: async () => found, detail: async () => null },
    modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
      rounds++;
      if (rounds === 1) return modelTurn([toolCall('search', 'places.search', {})]);
      if (rounds === 2) return modelTurn([toolCall('save', 'plans.create', { kind: 'scheme', name: '徐汇一日游', days: [{ stops: found.places.map((place, index) => ({ placeId: place.placeId, startMinutes: 540 + 90 * index, durationMinutes: 60 })) }] })]);
      throw new Error('model transport closed');
    } },
  });
  const result = await runPersonalAgent(ctx, 'owner', '安排徐汇一日游，生成方案', []);
  assert.equal(ctx.planLibrary.list('owner').length, 1);
  assert.match(result.reply, /地点安排已保存/);
  assert.match(result.reply, /后续路线或说明尚未完成/);
  assert.equal(ctx.personalAgentTasks.current('owner')?.status, 'interrupted');
});
