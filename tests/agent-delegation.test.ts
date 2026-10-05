import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { DemoPlaceProvider, type RouteProvider } from '../src/providers/travel.js';
import { DEMO_PLACE_IDS } from '../src/demo/demo-data.js';
import { modelTurn, toolCall } from '../src/providers/model.js';

const instant = '2026-09-28T03:00:00Z';
const road: RouteProvider = { providerName: 'delegation_road_fixture', async plan(input) { return { departureSupport: 'current_only', leg: { legId: 'verified-road', fromStopId: 'origin', toStopId: 'destination', transportMode: input.transportMode, durationMinutes: 10, distanceMeters: 800, geometry: [{ lat: 31.19, lng: 121.44 }, { lat: 31.195, lng: 121.438 }], geometryCrs: 'WGS84' } }; } };
const receipts = (input: any, name: string) => input.messages.filter((message: any) => message.role === 'tool' && message.toolName === name).map((message: any) => JSON.parse(message.content));
const call = (name: string, args = {}) => modelTurn([toolCall(crypto.randomUUID(), name, args)]);
async function fixture(run: (f: any) => Promise<void>, model?: (input: any) => any, route = road) {
  let calls = 0;
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => instant, placeProvider: new DemoPlaceProvider(), routeProvider: route,
    ...(model ? { modelProvider: { providerName: 'delegation_model_fixture', modelName: 'test', async generateTurn(input: any) {
      calls++;
      const names = input.tools.map((tool: any) => tool.name);
      for (const name of ['companion.context', 'companion.preview', 'companion.apply', 'places.search', 'routes.estimate']) assert.ok(names.includes(name));
      for (const name of ['plans.edit', 'plans.create', 'progress.record', 'community.post_publish', 'plans.delete']) assert.ok(!names.includes(name), name);
      return model(input);
    } } } : {}),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const guest = async () => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  const cookie = await guest();
  const api = async (path: string, body?: unknown, actor = cookie, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + '/api/v1/' + path, { method, headers: { cookie: actor, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
  };
  try {
    const plan = await api('plans', { name: '今天的托管散步', kind: 'plan', localDate: '2026-09-28', cityCode: '310100', timezone: 'Asia/Shanghai', snapshot: {
      stops: [DEMO_PLACE_IDS.xujiahuiLibrary, DEMO_PLACE_IDS.wukang].map((placeId, index) => ({ stopId: `stop${index}`, placeId, place: { placeId, name: `地点${index}` }, startMinutes: 720 + index * 90, endMinutes: 780 + index * 90, plannedDurationMinutes: 60, minDurationMinutes: 15, status: 'planned' })), routeLegs: [], plannedCharges: [],
    } });
    const location = { lat: 31.19, lng: 121.44, accuracyMeters: 15, measuredAt: Date.parse(instant) };
    const request = (change: string, extra = {}) => ({ action: 'delegate', planId: plan.id, expectedRevision: 0, stopId: 'stop0', transportMode: 'walking', change, ...extra });
    const send = (companionRequest: unknown, text = '请自动处理后续安排', clientMessageId = crypto.randomUUID(), actor = cookie) => api('agent/chat', { text, companionRequest, clientMessageId, location }, actor);
    await run({ api, plan, send, request, guest, modelCalls: () => calls });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const restModel = (input: any) => {
  if (!receipts(input, 'companion.context').length) return call('companion.context');
  if (!receipts(input, 'companion.preview').length) return call('companion.preview', { minutes: 25 });
  const preview = receipts(input, 'companion.preview').at(-1);
  if (!preview.result?.candidates.length) return modelTurn([], '实际道路或开放时段无法核对，保留原安排。');
  if (!receipts(input, 'companion.apply').length) return call('companion.apply', { previewId: preview.result.candidates[0].previewId });
  return modelTurn([], '已安排休息25分钟，重新核对道路并更新后续时间。');
};

test('首页休息调用模型的真实工具循环并自动保存，不需要第二次确认，重试不重复写入', () => fixture(async ({ api, plan, send, request, modelCalls }: any) => {
  const result = await send(request('rest'), '休息一下，自动安排', 'rest-delegate-once');
  assert.equal(result.assistantMessage.companionDelegation.status, 'applied');
  assert.equal(result.assistantMessage.agentMode, 'tools'); assert.equal(modelCalls(), 4);
  assert.deepEqual(result.agent.steps.map((step: any) => step.tool), ['companion.context', 'companion.preview', 'companion.apply']);
  const saved = (await api('plans')).find((item: any) => item.id === plan.id);
  assert.equal(saved.revision, 1); assert.equal(saved.routeLegs.length, 2); assert.deepEqual(saved.executionEvents, []);
  assert.equal(saved.stops[0].startMinutes, plan.stops[0].startMinutes + 25);
  const replay = await send(request('rest'), '休息一下，自动安排', 'rest-delegate-once');
  assert.equal(replay.assistantMessage.messageId, result.assistantMessage.messageId); assert.equal(modelCalls(), 4);
  assert.equal((await api('plans')).find((item: any) => item.id === plan.id).revision, 1);
}, restModel));

test('结束时间由模型追问，普通中文回答再次调用模型和工具、自动保存', () => fixture(async ({ api, plan, send, request, modelCalls }: any) => {
  const asked = await send(request('time'), '时间不够，请托管后续安排');
  assert.equal(asked.assistantMessage.companionDelegation.status, 'needs_input');
  assert.match(asked.assistantMessage.text, /几点/); assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 0);
  const answered = await send({ action: 'delegate', sourceMessageId: asked.assistantMessage.messageId }, '今天下午四点前结束');
  assert.equal(answered.assistantMessage.companionDelegation.status, 'applied'); assert.ok(modelCalls() >= 6);
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 1);
  assert.deepEqual((await api('plans')).find((p: any) => p.id === plan.id).executionEvents, []);
}, input => {
  if (!receipts(input, 'companion.context').length) return call('companion.context');
  const text = input.messages.filter((message: any) => message.role === 'user').at(-1).content;
  if (!text.includes('四点')) return call('companion.ask', { question: '今天最迟希望几点结束？' });
  if (!receipts(input, 'companion.preview').length) return call('companion.preview', { deadlineMinutes: 960 });
  if (!receipts(input, 'companion.apply').length) return call('companion.apply', { previewId: receipts(input, 'companion.preview').at(-1).result.candidates[0].previewId });
  return modelTurn([], '已更新安排，按实际道路预计16点前结束。');
}));

for (const change of ['rain', 'replace']) test(`首页${change}由模型查询并选定地点，不固定选目录第一个`, () => fixture(async ({ api, plan, send, request }: any) => {
  const result = await send(request(change));
  assert.equal(result.assistantMessage.companionDelegation.status, 'applied', result.assistantMessage.text);
  const saved = (await api('plans')).find((p: any) => p.id === plan.id);
  assert.equal(saved.stops[0].placeId, DEMO_PLACE_IDS.shanghaiLibrary); assert.equal(saved.stops[0].stopId, 'stop0');
  assert.deepEqual(saved.executionEvents, []); assert.equal(saved.revision, 1);
}, input => {
  if (!receipts(input, 'companion.context').length) return call('companion.context');
  if (!receipts(input, 'places.search').length) return call('places.search', { query: '上海图书馆' });
  if (!receipts(input, 'places.detail').length) return call('places.detail', { placeId: DEMO_PLACE_IDS.shanghaiLibrary });
  if (!receipts(input, 'companion.preview').length) return call('companion.preview', { placeId: DEMO_PLACE_IDS.shanghaiLibrary });
  if (!receipts(input, 'companion.apply').length) {
    const preview = receipts(input, 'companion.preview').at(-1); assert.ok(preview.result.candidates.length, JSON.stringify(preview));
    return call('companion.apply', { previewId: preview.result.candidates[0].previewId });
  }
  return modelTurn([], '已自动改去上海图书馆，并更新实际道路预计时间。');
}));

test('未配置模型不会伪装自动处理，也不改变安排', () => fixture(async ({ api, plan, send, request }: any) => {
  const result = await send(request('rest'));
  assert.match(result.assistantMessage.text, /未连接|尚未连接/); assert.equal(result.assistantMessage.companionDelegation.status, 'unavailable');
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 0);
}));

test('模型连接异常不退回预设调整、不写计划', () => fixture(async ({ api, plan, send, request }: any) => {
  const result = await send(request('rest')); assert.match(result.assistantMessage.text, /尚未修改.*连接中断/);
  assert.equal(result.assistantMessage.companionDelegation.status, 'unavailable');
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 0);
}, () => { throw new Error('offline fixture'); }));

test('模型不能越过托管范围调用普通写入工具或伪造候选凭据', () => fixture(async ({ api, plan, send, request }: any) => {
  const before = JSON.stringify(await api('plans'));
  const result = await send(request('rest')); assert.equal(result.assistantMessage.companionDelegation.status, 'unavailable');
  assert.deepEqual(result.agent.steps.map((step: any) => step.ok), [false, false]);
  assert.equal(JSON.stringify(await api('plans')), before);
}, input => input.messages.some((message: any) => message.role === 'tool') ? modelTurn([], '操作未完成。') : modelTurn([
  toolCall('unsafe-write', 'plans.edit', { planId: 'not-authorized', action: 'rename', name: 'bad', expectedRevision: 0 }),
  toolCall('forged-candidate', 'companion.apply', { previewId: 'forged' }),
])));

test('托管追问属于当前身份，取消后不能复用，错误版本或当前站点在调用模型之前拒绝', () => fixture(async ({ api, plan, send, request, guest, modelCalls }: any) => {
  await send(request('time', { expectedRevision: 9 })); await send(request('time', { stopId: 'stop1' })); assert.equal(modelCalls(), 0);
  const asked = await send(request('time')); const continuation = { action: 'delegate', sourceMessageId: asked.assistantMessage.messageId };
  const foreign = await send(continuation, '四点', crypto.randomUUID(), await guest()); assert.match(foreign.assistantMessage.text, /找不到/);
  await send({ ...continuation, action: 'cancel_delegate' }, '取消');
  const late = await send(continuation, '四点'); assert.match(late.assistantMessage.text, /找不到/); assert.equal(modelCalls(), 1);
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 0);
}, () => call('companion.ask', { question: '最迟几点结束？' })));

test('真实道路不可用时托管保留原计划并说明未完成', () => fixture(async ({ api, plan, send, request }: any) => {
  const result = await send(request('rest')); assert.equal(result.assistantMessage.companionDelegation.status, 'unavailable');
  assert.match(result.assistantMessage.text, /尚未修改/); assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 0);
}, restModel, { providerName: 'unavailable_road_fixture', async plan() { throw new Error('road unavailable'); } }));

test('模型判断原安排已满足需求时可明确保留，不能把保留说成保存了新计划', () => fixture(async ({ api, plan, send, request }: any) => {
  const stops = structuredClone(plan.stops); stops[1].placeId = DEMO_PLACE_IDS.shanghaiLibrary; stops[1].place = { placeId: DEMO_PLACE_IDS.shanghaiLibrary, name: '上海图书馆' };
  await api('plans/' + plan.id, { name: plan.name, kind: 'plan', localDate: plan.localDate, timezone: plan.timezone, cityCode: plan.cityCode, expectedRevision: 0, snapshot: { stops, routeLegs: [], plannedCharges: [] } }, undefined, 'PUT');
  const before = JSON.stringify(await api('plans'));
  const result = await send(request('rain', { expectedRevision: 1 })); assert.equal(result.assistantMessage.companionDelegation.status, 'unchanged');
  assert.equal(JSON.stringify(await api('plans')), before); assert.equal(result.assistantMessage.companionDelegation.reason, '下一站已在室内，保持原安排。');
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 1);
}, input => !receipts(input, 'companion.context').length ? call('companion.context') : !receipts(input, 'companion.keep').length ? call('companion.keep', { reason: '下一站已在室内，保持原安排。' }) : modelTurn([], '下一站为室内书院，已保留原安排。')));

test('保存后模型断线保留成功回执及刷新提示，继续任务不再重复调整', () => fixture(async ({ api, plan, send, request }: any) => {
  const result = await send(request('rest')); assert.equal(result.assistantMessage.companionDelegation.status, 'applied');
  assert.ok(result.assistantMessage.companionDelegation.outcome.changes.length); assert.deepEqual(result.command.refresh, ['plans']);
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 1);
}, input => {
  if (receipts(input, 'companion.apply').length) throw new Error('disconnect after save');
  return restModel(input);
}));

test('下雨不能因下一站室内而忽略后续户外，可精确替换后面的到访并保留室内时段', () => fixture(async ({ api, plan, send, request }: any) => {
  const result = await send(request('rain')); assert.equal(result.assistantMessage.companionDelegation.status, 'applied');
  const saved = (await api('plans')).find((p: any) => p.id === plan.id);
  assert.equal(saved.stops[0].placeId, DEMO_PLACE_IDS.xujiahuiLibrary); assert.equal(saved.stops[0].startMinutes, plan.stops[0].startMinutes); assert.equal(saved.stops[0].endMinutes, plan.stops[0].endMinutes);
  assert.equal(saved.stops[1].placeId, DEMO_PLACE_IDS.shanghaiLibrary); assert.equal(saved.stops[1].stopId, plan.stops[1].stopId); assert.equal(saved.revision, 1); assert.deepEqual(saved.executionEvents, []);
  assert.ok(result.agent.steps.some((step: any) => step.tool === 'companion.keep' && !step.ok));
}, input => {
  if (!receipts(input, 'companion.context').length) return call('companion.context');
  if (!receipts(input, 'companion.keep').length) return call('companion.keep', { reason: '下一站已在室内，保留全部安排。' });
  if (!receipts(input, 'companion.preview').length) return call('companion.preview', { placeId: DEMO_PLACE_IDS.shanghaiLibrary, targetStopId: 'stop1' });
  if (!receipts(input, 'companion.apply').length) return call('companion.apply', { previewId: receipts(input, 'companion.preview').at(-1).result.candidates[0].previewId });
  return modelTurn([], '已把后续户外的武康大楼改为室内图书馆，书院原时段保留。');
}));

test('模型达到输出上限但没有有效结果时扩大一次预算继续工具调用，不退回空白预设回复', () => fixture(async ({ api, plan, send, request }: any) => {
  const result = await send(request('rest')); assert.equal(result.assistantMessage.companionDelegation.status, 'applied');
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 1);
}, input => {
  if (receipts(input, 'companion.preview').length && !receipts(input, 'companion.apply').length) {
    if (input.maxOutputTokens === 8192) return { toolCalls: [], finishReason: 'length', usage: { inputTokens: 100, outputTokens: 3000 } };
    assert.equal(input.maxOutputTokens, 16384); assert.equal(input.timeoutMs, 60000);
  }
  return restModel(input);
}));
