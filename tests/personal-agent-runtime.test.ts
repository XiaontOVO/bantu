import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { modelTurn, toolCall, type ModelTurnRequest } from '../src/providers/model.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { loadAgentScheme } from '../src/services/personal-agent-load.js';

test('interrupted narration distinguishes a committed note from a failed or read-only operation', async()=>{
  for(const mode of ['saved','failed','read','old'] as const){
    let round=0;
    const ctx=createServerContext({seedDemo:false,modelProvider:{providerName:'fixture',modelName:'fixture',async generateTurn(){
      if(++round===1)return modelTurn([toolCall('first',['read','old'].includes(mode)?'memories.list':'memories.create',mode==='failed'?{text:''}:mode==='saved'?{text:'我想再看看红砖立面。'}:{})]);
      return {text:'',toolCalls:[],finishReason:'error' as const,error:{code:'MODEL_UNAVAILABLE',message:'fixture'},usage:{inputTokens:0,outputTokens:0}};
    }}});
    const result=await runPersonalAgent(ctx,'owner',['read','old'].includes(mode)?'看看我的笔记':'保存我的感受',mode==='old'?[{role:'tool',toolName:'memories.create',content:JSON.stringify({ok:true,result:{memoryId:'old-note'}})}]:[]);
    assert.equal(ctx.personalMemoriesService.list('owner').length,mode==='saved'?1:0);
    if(mode==='saved'){assert.match(result.reply,/笔记已保存.*后续回复生成中断/);assert.doesNotMatch(result.reply,/暂时无法继续处理/);}
    else assert.doesNotMatch(result.reply,/笔记已保存|操作已保留/);
  }
});

test('a new text question after an interrupted creation does not resume the old planning goal',async()=>{
  let round=0;
  const ctx=createServerContext({seedDemo:false,modelProvider:{providerName:'fixture',modelName:'fixture',async generateTurn(request){
    if(++round===1)return {text:'',toolCalls:[],finishReason:'error' as const,error:{code:'MODEL_UNAVAILABLE',message:'fixture'},usage:{inputTokens:0,outputTokens:0}};
    assert.ok(request.tools.some(tool=>tool.name==='memories.list'),'the old creation goal must not filter the new task tools');
    return modelTurn([],'傍晚可以留意街角的光影。');
  }}});
  await runPersonalAgent(ctx,'owner','生成上海一日方案',[]);
  const result=await runPersonalAgent(ctx,'owner','只回答文字，不用改计划：武康大楼适合什么时间去拍照？',[{role:'user',content:'生成上海一日方案'}]);
  assert.equal(result.reply,'傍晚可以留意街角的光影。');assert.equal(ctx.planLibrary.list('owner').length,0);
});

test('model time adjustment keeps minute/second aliases aligned and changes only the selected scheme day', async () => {
  let planId = '';
  const ctx = createServerContext({ seedDemo: false, modelProvider: { providerName: 'time_alias_fixture', modelName: 'test', async generateTurn(request) {
    return request.messages.some(message => message.role === 'tool') ? modelTurn([], '已调整第二天。') : modelTurn([toolCall('adjust', 'plans.adjust_stop', { planId, stopId: 'second', dayIndex: 1, expectedRevision: 0, startMinutes: 900, durationMinutes: 45 })]);
  } } });
  const saved = ctx.planLibrary.save('owner', { name: '两日安排', kind: 'scheme', days: [0, 1].map(dayIndex => ({ dayIndex, stops: [{ stopId: dayIndex ? 'second' : 'first', placeId: 'place', place: { placeId: 'place', name: '地点' }, status: 'planned', startMinutes: 840, plannedStartMinutes: 840, plannedArrivalMinutes: 840, endMinutes: 900, departureMinutes: 900, plannedDepartureMinutes: 900, plannedDurationMinutes: 60, durationSeconds: 3600, minDurationMinutes: 60, minDurationSeconds: 3600 }], routeLegs: [], plannedCharges: [] })) });
  planId = saved.id;
  const result = await runPersonalAgent(ctx, 'owner', '第二天改成15点开始，停留45分钟', []);
  assert.equal(result.steps[0].ok, true);
  const plan = ctx.planLibrary.list('owner').find(plan => plan.id === planId)!;
  assert.equal(plan.revision, 1);
  assert.ok(plan.days);
  const first = plan.days[0].stops[0] as any, second = plan.days[1].stops[0] as any;
  assert.equal(first.startMinutes, 840); assert.equal(first.durationSeconds, 3600);
  for (const key of ['startMinutes', 'plannedStartMinutes', 'plannedArrivalMinutes']) assert.equal(second[key], 900, key);
  for (const key of ['endMinutes', 'departureMinutes', 'plannedDepartureMinutes']) assert.equal(second[key], 945, key);
  assert.equal(second.durationSeconds, 2700); assert.equal(second.minDurationSeconds, 2700);
});

test('agent confirmation loads around completed progress without erasing it', async () => {
  let schemeId = '';
  let receivedPlan: any;
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T12:00:00+08:00', modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request) {
      const loaded = request.messages.find(m => m.role === 'tool' && m.toolCallId === 'load');
      const plans = loaded && JSON.parse(loaded.content!).result?.plans;
      if (plans) { receivedPlan = plans[0]; return modelTurn([], '载入完成。'); }
      return modelTurn([toolCall('load', 'plans.load', { schemeId })]);
    },
  } });
  const scheme = ctx.planLibrary.save('owner', { name: '书院一日', kind: 'scheme', days: [{ dayIndex: 0, stops: [{ stopId: 'visit', placeId: 'p1', place: { placeId: 'p1', name: '书院' }, status: 'planned', startMinutes: 540, endMinutes: 600 }], routeLegs: [], plannedCharges: [] }] });
  schemeId = scheme.id;
  const plan = loadAgentScheme(ctx, 'owner', schemeId).plans![0];
  for (const [type, time] of [['depart', '09:00'], ['arrive', '09:10'], ['complete', '10:00']] as const) {
    ctx.planLibrary.recordExecution('owner', plan.id, { stopId: 'visit', type, occurredAt: `2026-09-22T${time}:00+08:00` });
  }
  const events = structuredClone(ctx.planLibrary.get('owner', plan.id).executionEvents);
  const requested = await runPersonalAgent(ctx, 'owner', '把书院一日安排到今天', []);
  assert.match(requested.reply, /已有执行记录会保留/);
  const result = await runPersonalAgent(ctx, 'owner', '确认载入', []);
  assert.match(result.reply, /已将/);
  const saved = ctx.planLibrary.list('owner').find(p => p.id === plan.id)!;
  assert.deepEqual(saved.executionEvents, events);
  assert.equal(saved.stops.length, 2);
  assert.equal((saved.stops[0] as any).status, 'completed');
  assert.equal((saved.stops[1] as any).status, 'planned');
  assert.deepEqual(receivedPlan, saved, 'confirmation continuation sees the same progress as the page');
});

test('scheme loading defaults to today and confirms replacement across restart without model consent', async () => {
  const store = new MemoryStateStore();
  let schemeId = '';
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request: ModelTurnRequest) {
      if (request.messages.some(m => m.role === 'tool' && m.toolName === 'plans.load' && JSON.parse(m.content!).result?.plans)) return modelTurn([], '载入完成。');
      return modelTurn([
        toolCall('load', 'plans.load', { schemeId }),
        toolCall('unexpected', 'memories.create', { text: '不应该执行' }),
      ]);
    },
  } };
  const ctx = createServerContext(options);
  const scheme = ctx.planLibrary.save('owner', { name: '两天散步', kind: 'scheme', days: [0, 1].map(dayIndex => ({ dayIndex, stops: [], routeLegs: [], plannedCharges: [] })) }, 'draft');
  schemeId = scheme.id;
  const first = loadAgentScheme(ctx, 'owner', schemeId);
  assert.equal(first.plans?.length, 2);
  assert.ok(first.date);
  assert.throws(() => loadAgentScheme(ctx, 'other', schemeId));
  const requested = await runPersonalAgent(ctx, 'owner', '把两天散步重新载入', []);
  assert.match(requested.reply, /确认载入/);
  assert.equal(ctx.personalMemoriesService.list('owner').length, 0, 'pause remaining tool calls at confirmation boundary');
  const restored = createServerContext(options);
  assert.equal(restored.personalAgentTasks.pendingLoad('other'), undefined);
  assert.ok(restored.personalAgentTasks.pendingLoad('owner'));
  const continued = await runPersonalAgent(restored, 'owner', '继续', []);
  assert.match(continued.reply, /确认载入/);
  const confirmed = await runPersonalAgent(restored, 'owner', '确认载入', []);
  assert.match(confirmed.reply, /已将.*载入为 2 天/);
  assert.deepEqual(confirmed.refresh, ['plans']);
  assert.equal(restored.personalAgentTasks.pendingLoad('owner'), undefined);
  assert.equal(restored.planLibrary.list('owner').filter(p => p.kind === 'plan').length, 2);
});

test('confirmed composite task continues after restart and committed remaining writes survive interruption', async () => {
  const store = new MemoryStateStore();
  let schemeId = '';
  const first = createServerContext({ seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      return modelTurn([toolCall('load', 'plans.load', { schemeId }), toolCall('note', 'memories.create', { text: '确认后记下的原文' })]);
    },
  } });
  const scheme = first.planLibrary.save('owner', { name: '复合任务', kind: 'scheme', days: [{ dayIndex: 0, stops: [], routeLegs: [], plannedCharges: [] }] });
  schemeId = scheme.id;
  loadAgentScheme(first, 'owner', schemeId);
  await runPersonalAgent(first, 'owner', '重新载入复合任务，然后记下：确认后记下的原文', []);
  assert.equal(first.personalMemoriesService.list('owner').length, 0);
  let round = 0;
  const restored = createServerContext({ seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request) {
      assert.ok(request.messages.some(m => m.role === 'user' && m.content?.includes('重新载入复合任务，然后记下')));
      const loaded = request.messages.find(m => m.role === 'tool' && m.toolCallId === 'load');
      assert.ok(JSON.parse(loaded!.content!).result.plans, 'actual confirmation receipt replaces the pending receipt');
      if (++round === 1) return modelTurn([toolCall('after-confirm', 'memories.create', { text: '确认后记下的原文' })]);
      throw new Error('model connection interrupted');
    },
  } });
  const confirmed = await runPersonalAgent(restored, 'owner', '确认载入', []);
  assert.match(confirmed.reply, /已将/);
  assert.match(confirmed.reply, /中断/);
  assert.deepEqual(confirmed.refresh, ['plans', 'memories']);
  assert.equal(restored.personalMemoriesService.list('owner').length, 1);
  const plans = restored.planLibrary.serialize();
  const resumed = createServerContext({ seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      if (++round === 3) return modelTurn([toolCall('replayed-note', 'memories.create', { text: '确认后记下的原文' })]);
      return modelTurn([], '载入和笔记均已完成。');
    },
  } });
  await runPersonalAgent(resumed, 'owner', '继续', []);
  assert.equal(resumed.personalMemoriesService.list('owner').length, 1);
  assert.equal(resumed.planLibrary.serialize(), plans);
  assert.equal(resumed.personalAgentTasks.pendingLoad('owner'), undefined);
});

test('loading refuses to discard malformed execution history', () => {
  const ctx = createServerContext({ seedDemo: false });
  const scheme = ctx.planLibrary.save('owner', { name: '保护进度', kind: 'scheme', days: [{ dayIndex: 0, stops: [], routeLegs: [], plannedCharges: [] }] }, 'draft');
  const loaded = loadAgentScheme(ctx, 'owner', scheme.id);
  const plan = ctx.planLibrary.get('owner', loaded.plans![0].id);
  // The guard must also protect histories whose nodes are no longer visible.
  plan.executionEvents = [{ executionEventId: 'historical', stopId: 'old-stop', type: 'complete', occurredAt: ctx.now(), recordedAt: ctx.now() } as any];
  const before = ctx.planLibrary.serialize();
  const pending = loadAgentScheme(ctx, 'owner', scheme.id).pending;
  assert.ok(pending);
  assert.throws(() => loadAgentScheme(ctx, 'owner', scheme.id, pending.startDate, pending), /已有执行记录/);
  assert.equal(ctx.planLibrary.serialize(), before);
});

test('scheme load approval becomes stale when source changes and cancel leaves plans untouched', async () => {
  let schemeId = '';
  const ctx = createServerContext({ seedDemo: false, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
    return modelTurn([toolCall('load', 'plans.load', { schemeId })]);
  } } });
  const days = [{ dayIndex: 0, stops: [], routeLegs: [], plannedCharges: [] }];
  const scheme = ctx.planLibrary.save('owner', { name: '原方案', kind: 'scheme', days }, 'draft');
  schemeId = scheme.id;
  loadAgentScheme(ctx, 'owner', schemeId);
  await runPersonalAgent(ctx, 'owner', '重新载入', []);
  ctx.planLibrary.update('owner', schemeId, { name: '更改后的方案', days });
  const before = ctx.planLibrary.serialize();
  const stale = await runPersonalAgent(ctx, 'owner', '确认载入', []);
  assert.match(stale.reply, /计划已变化，需要重新确认/);
  assert.equal(ctx.planLibrary.serialize(), before);
  const cancelled = await runPersonalAgent(ctx, 'owner', '取消', []);
  assert.match(cancelled.reply, /已取消/);
  assert.equal(ctx.planLibrary.serialize(), before);
  assert.equal(ctx.personalAgentTasks.pendingLoad('owner'), undefined);
});

test('interrupted task resumes after server reconstruction without repeating a committed memory', async () => {
  const store = new MemoryStateStore();
  let round = 0;
  const first = createServerContext({ seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      if (++round === 1) return modelTurn([toolCall('write', 'memories.create', { text: '重启前的记录' })]);
      throw new Error('connection interrupted');
    },
  } });
  await runPersonalAgent(first, 'owner', '记下重启前的记录', []);
  assert.equal(first.personalMemoriesService.list('owner').length, 1);
  const restored = createServerContext({ seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request) {
      const receipt = request.messages.find(m => m.role === 'tool' && m.toolCallId === 'write');
      assert.ok(receipt, 'restored model receives original committed tool receipt');
      assert.equal(JSON.parse(receipt.content!).ok, true);
      if (++round === 3) return modelTurn([toolCall('retry-write', 'memories.create', { text: '重启前的记录' })]);
      return modelTurn([], '已完成记录。');
    },
  } });
  const result = await runPersonalAgent(restored, 'owner', '继续', []);
  assert.equal(result.reply, '已完成记录。');
  assert.equal(restored.personalMemoriesService.list('owner').length, 1);
  assert.deepEqual(result.refresh, ['memories']);
  assert.equal(restored.personalMemoriesService.list('other').length, 0);
});

test('model sees argument errors, corrects its call and duplicate writes are replayed', async () => {
  let round = 0;
  const server = createHttpServer({ seedDemo: false, modelProvider: {
    providerName: 'tool-contract-test', modelName: 'tool-contract-test',
    async generateTurn(request) {
      round++;
      if (round === 1) return modelTurn([toolCall('bad', 'memories.create', { text: 123, actorId: 'someone-else' })]);
      const result = JSON.parse(request.messages.at(-1)!.content!);
      if (round === 2) {
        assert.equal(result.ok, false);
        return modelTurn([toolCall('fixed', 'memories.create', { text: '散步很开心。', localDate: '2026-09-22' })]);
      }
      assert.equal(result.ok, true);
      if (round === 3) return modelTurn([toolCall('repeat', 'memories.create', { localDate: '2026-09-22', text: '散步很开心。' })]);
      return modelTurn([], '已保存笔记。');
    },
  } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(base + '/api/v1/agent/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '记下：散步很开心。', clientMessageId: 'repair-call' }) });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(round, 4);
    assert.deepEqual(body.data.agent.steps.map((s: any) => s.ok), [false, true]);
    assert.deepEqual(body.data.command.refresh, ['memories']);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('personal LLM loops through live catalog results and saves a scheme without a Trip', async () => {
  let round = 0;
  const server = createHttpServer({ seedDemo: false, modelProvider: {
    providerName: 'tool-contract-test', modelName: 'tool-contract-test',
    async generateTurn(request) {
      assert.ok(request.tools.some(t => t.name === 'plans.create'));
      round++;
      if (round === 1) return modelTurn([toolCall('search', 'places.search', { query: '' })]);
      const last = request.messages.at(-1)!;
      assert.equal(last.role, 'tool');
      const result = JSON.parse(last.content!);
      if (round === 2) {
        assert.equal(last.toolCallId, 'search');
        const place = result.result.places[0];
        assert.ok(place.placeId);
        return modelTurn([toolCall('save', 'plans.create', { name: '模型自选路线', kind: 'scheme', days: [{ stops: [{ placeId: place.placeId, startMinutes: 600, durationMinutes: 60 }] }] })]);
      }
      assert.equal(last.toolCallId, 'save');
      assert.equal(result.ok, true);
      return modelTurn([], '已按目录地点生成方案。');
    },
  } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(base + '/api/v1/agent/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '你帮我选一个地点，做成可以以后用的方案', clientMessageId: 'model-loop' }) });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(round, 3);
    assert.equal(body.data.agent.mode, 'tools');
    assert.deepEqual(body.data.command.refresh, ['plans']);
    const plans = await (await fetch(base + '/api/v1/plans', { headers: { cookie } })).json() as any;
    assert.equal(plans.data.length, 1);
    assert.equal(plans.data[0].name, '模型自选路线');
    await fetch(base + '/api/v1/agent/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '你帮我选一个地点，做成可以以后用的方案', clientMessageId: 'model-loop' }) });
    assert.equal(round, 3, 'HTTP retry replays the committed result without calling the model again');
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
