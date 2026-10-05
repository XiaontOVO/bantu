import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { DemoPlaceProvider, type RouteProvider } from '../src/providers/travel.js';
import { DEMO_PLACE_IDS } from '../src/demo/demo-data.js';
import { modelTurn, toolCall } from '../src/providers/model.js';

const instant = '2026-09-28T03:00:00Z';
const road: RouteProvider = { providerName: 'agent_road_fixture', async plan(input) { return { departureSupport: 'current_only', leg: { legId: 'agent-road', fromStopId: 'origin', toStopId: 'destination', transportMode: input.transportMode, durationMinutes: 10, distanceMeters: 800, geometry: [{ lat: 31.19, lng: 121.44 }, { lat: 31.195, lng: 121.438 }], geometryCrs: 'WGS84' } }; } };
async function fixture(run: (f: any) => Promise<void>, withModel = false) {
  let calls = 0;
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => instant, placeProvider: new DemoPlaceProvider(), routeProvider: road,
    ...(withModel ? { modelProvider: { providerName: 'explanation_fixture', modelName: 'test', async generateTurn(input: any) { calls++; assert.deepEqual(input.tools, []); return modelTurn([toolCall('unsafe', 'plans.edit', { action: 'delete' })], '已修改计划'); } } } : {}),
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
    const plan = await api('plans', { name: '今天的散步', kind: 'plan', localDate: '2026-09-28', cityCode: '310100', timezone: 'Asia/Shanghai', snapshot: {
      stops: [DEMO_PLACE_IDS.xujiahuiLibrary, DEMO_PLACE_IDS.shanghaiLibrary, DEMO_PLACE_IDS.wukang].map((placeId, index) => ({ stopId: `stop${index}`, placeId, place: { placeId, name: `地点${index}` }, startMinutes: 720 + index * 90, endMinutes: 780 + index * 90, plannedDurationMinutes: 60, minDurationMinutes: 15, status: 'planned' })), routeLegs: [], plannedCharges: [],
    } });
    const position = { lat: 31.19, lng: 121.44, accuracyMeters: 15, measuredAt: Date.parse(instant) };
    const start = (change: string, extra = {}) => ({ action: 'start', planId: plan.id, expectedRevision: 0, stopId: 'stop0', transportMode: 'walking', change, ...extra });
    const send = (companionRequest: unknown, clientMessageId = crypto.randomUUID(), actor = cookie) => api('agent/chat', { text: '请帮助调整当前行程', companionRequest, clientMessageId, location: position }, actor);
    await run({ api, plan, send, start, guest, modelCalls: () => calls });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('首页四个意图进入 Agent，参数追问和候选预览都不改变安排', () => fixture(async ({ api, plan, send, start }: any) => {
  const before = JSON.stringify(await api('plans'));
  for (const change of ['rest', 'time', 'rain', 'replace']) {
    const reply = await send(start(change));
    const adjustment = reply.assistantMessage.companionAdjustment;
    assert.equal(adjustment.planId, plan.id); assert.equal(adjustment.change, change);
    if (['rest', 'time'].includes(change)) {
      assert.equal(adjustment.status, 'needs_input');
      const preview = await send({ action: 'preview', sourceMessageId: reply.assistantMessage.messageId, ...(change === 'rest' ? { minutes: 30 } : { deadlineMinutes: 1000 }) });
      assert.ok(['preview', 'unavailable'].includes(preview.assistantMessage.companionAdjustment.status));
    }
  }
  assert.equal(JSON.stringify(await api('plans')), before);
}));

test('Agent 中显式确认才更新，重复消息和再次确认不重复修改', () => fixture(async ({ api, plan, send, start }: any) => {
  const question = await send(start('rest'));
  const preview = await send({ action: 'preview', sourceMessageId: question.assistantMessage.messageId, minutes: 30 });
  const candidate = preview.assistantMessage.companionAdjustment.candidates[0]; assert.ok(candidate);
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 0);
  const request = { action: 'apply', sourceMessageId: preview.assistantMessage.messageId, previewId: candidate.previewId };
  const applied = await send(request, 'agent-companion-apply-once');
  assert.equal(applied.assistantMessage.companionAdjustment.status, 'applied');
  assert.deepEqual(applied.command.refresh, ['plans']);
  const saved = (await api('plans')).find((p: any) => p.id === plan.id);
  assert.equal(saved.revision, 1); assert.deepEqual(saved.executionEvents, []);
  const replay = await send(request, 'agent-companion-apply-once');
  assert.equal(replay.assistantMessage.messageId, applied.assistantMessage.messageId);
  await send(request);
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 1);
}));

test('调整对话属于当前身份，取消后旧候选不能再采用', () => fixture(async ({ api, plan, send, start, guest }: any) => {
  const question = await send(start('rest'));
  const preview = await send({ action: 'preview', sourceMessageId: question.assistantMessage.messageId, minutes: 15 });
  const request = { action: 'apply', sourceMessageId: preview.assistantMessage.messageId, previewId: preview.assistantMessage.companionAdjustment.candidates[0].previewId };
  const other = await guest();
  const foreign = await send(request, 'foreign-companion', other); assert.match(foreign.assistantMessage.text, /找不到/);
  await send({ action: 'cancel', sourceMessageId: preview.assistantMessage.messageId });
  const cancelled = await send(request); assert.match(cancelled.assistantMessage.text, /已取消/);
  assert.equal((await api('plans')).find((p: any) => p.id === plan.id).revision, 0);
}));

test('开始调整绑定版本和当前站点，模型解释不获得写入工具', () => fixture(async ({ api, send, start, modelCalls }: any) => {
  const stale = await send(start('rest', { expectedRevision: 9 })); assert.match(stale.assistantMessage.text, /变化/);
  const wrongStop = await send(start('rest', { stopId: 'stop1' })); assert.match(wrongStop.assistantMessage.text, /站点/);
  const before = JSON.stringify(await api('plans'));
  const question = await send(start('rest'));
  const preview = await send({ action: 'preview', sourceMessageId: question.assistantMessage.messageId, minutes: 15 });
  assert.equal(preview.assistantMessage.companionAdjustment.status, 'preview');
  assert.equal(modelCalls(), 1); assert.doesNotMatch(preview.assistantMessage.text, /已修改计划/);
  assert.equal(JSON.stringify(await api('plans')), before);
}, true));

test('计划在预览后变化时拒绝旧确认，同一消息标识不能切换意图', () => fixture(async ({ api, plan, send, start }: any) => {
  const question = await send(start('rest'), 'fixed-companion-intent');
  await assert.rejects(send(start('time'), 'fixed-companion-intent'), /同一条消息/);
  const preview = await send({ action: 'preview', sourceMessageId: question.assistantMessage.messageId, minutes: 15 });
  const candidate = preview.assistantMessage.companionAdjustment.candidates[0]; assert.ok(candidate);
  await api('plans/' + plan.id, { name: '另一页的新安排', kind: 'plan', localDate: plan.localDate, timezone: plan.timezone, cityCode: plan.cityCode,
    expectedRevision: 0, snapshot: { stops: plan.stops, routeLegs: plan.routeLegs, plannedCharges: plan.plannedCharges } }, undefined, 'PUT');
  const before = JSON.stringify(await api('plans'));
  const reply = await send({ action: 'apply', sourceMessageId: preview.assistantMessage.messageId, previewId: candidate.previewId });
  assert.match(reply.assistantMessage.text, /变化/);
  assert.equal(JSON.stringify(await api('plans')), before);
}));
