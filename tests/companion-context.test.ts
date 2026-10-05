import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { readCompanionContext } from '../src/services/companion-context.js';
import { DemoPlaceProvider, type RouteProvider } from '../src/providers/travel.js';
import { DEMO_PLACE_IDS } from '../src/demo/demo-data.js';

const instant = '2026-09-28T03:00:00.000Z';
function fixture(route?: RouteProvider) {
  const ctx = createServerContext({ now: () => instant, placeProvider: new DemoPlaceProvider(), ...(route ? { routeProvider: route } : {}) });
  const plan = ctx.planLibrary.save('owner', { name: '随行测试', kind: 'plan', localDate: '2026-09-28', cityCode: '310100', timezone: 'Asia/Shanghai', snapshot: {
    stops: [{ stopId: 'next', placeId: DEMO_PLACE_IDS.xujiahuiLibrary, startMinutes: 720, endMinutes: 780, plannedDurationMinutes: 60, status: 'planned' }], routeLegs: [], plannedCharges: [],
  } });
  const input = { expectedRevision: plan.revision || 0, stopId: 'next', transportMode: 'walking', position: { lat: 31.19, lng: 121.44, accuracyMeters: 15, measuredAt: Date.parse(instant) } };
  return { ctx, plan, input };
}

function road(onCall: () => void = () => {}): RouteProvider {
  return { providerName: 'test_road_fixture', async plan(input) {
    onCall();
    return { departureSupport: 'current_only', leg: { legId: 'road', fromStopId: 'origin', toStopId: 'next', transportMode: input.transportMode, durationSeconds: 600, distanceMeters: 800, geometry: [{ lat: 31.19, lng: 121.44 }, { lat: 31.195, lng: 121.438 }], geometryCrs: 'WGS84' } };
  } };
}

test('随行道路 ETA 是只读视图，不写计划版本或执行事实', async () => {
  const { ctx, plan, input } = fixture(road());
  const before = ctx.planLibrary.serialize();
  const result = await readCompanionContext(ctx, 'owner', plan.id, input);
  assert.equal(result.routeUnknown, false);
  assert.equal(result.eta, '2026-09-28T03:10:00.000Z');
  assert.equal(result.originLabel, '当前位置');
  assert.equal(ctx.planLibrary.serialize(), before);
  assert.equal(result.phase, 'ready');
});

test('过期、粗略、未来及伪造的位置不查询路线，也不补固定时间', async () => {
  let calls = 0;
  const { ctx, plan, input } = fixture(road(() => calls++));
  for (const position of [undefined, { ...input.position, measuredAt: Date.parse(instant) - 120001 }, { ...input.position, measuredAt: Date.parse(instant) + 1 }, { ...input.position, accuracyMeters: 201 }, { ...input.position, accuracyMeters: 0 }, { ...input.position, lat: 91 }]) {
    const result = await readCompanionContext(ctx, 'owner', plan.id, { ...input, position });
    assert.equal(result.routeUnknown, true);
    assert.equal(result.eta, null);
  }
  assert.equal(calls, 0);
});

test('演示路线不能充当随行道路预计时间', async () => {
  const { ctx, plan, input } = fixture();
  const result = await readCompanionContext(ctx, 'owner', plan.id, input);
  assert.equal(result.routeUnknown, true);
  assert.match(result.routeReason, /演示/);
  assert.equal(result.eta, null);
});

test('供应商失败及不匹配交通方式保持预计未知', async () => {
  for (const route of [
    { providerName: 'failed_road', async plan() { throw new Error('Unavailable'); } } as RouteProvider,
    { providerName: 'wrong_mode', async plan() { return { departureSupport: 'live', leg: { legId: 'road', fromStopId: 'origin', toStopId: 'next', transportMode: 'driving', durationMinutes: 10 } }; } } as RouteProvider,
  ]) {
    const { ctx, plan, input } = fixture(route);
    const result = await readCompanionContext(ctx, 'owner', plan.id, input);
    assert.equal(result.eta, null);
    assert.equal(result.routeUnknown, true);
  }
});

test('随行校验归属、站点与版本，不能查看另一身份的私有计划', async () => {
  const { ctx, plan, input } = fixture(road());
  await assert.rejects(readCompanionContext(ctx, 'other', plan.id, input), /不存在/);
  await assert.rejects(readCompanionContext(ctx, 'owner', plan.id, { ...input, expectedRevision: 20 }), /变化/);
  await assert.rejects(readCompanionContext(ctx, 'owner', plan.id, { ...input, stopId: 'elsewhere' }), /变化/);
});

test('路线等待期间记录到达时，旧预计结果必须拒绝', async () => {
  let resolve!: (value: any) => void;
  let started!: () => void;
  const ready = new Promise<void>(r => started = r);
  const { ctx, plan, input } = fixture({ providerName: 'delayed_road', plan: () => { started(); return new Promise(r => resolve = r); } });
  const departed = ctx.planLibrary.recordExecution('owner', plan.id, { stopId: 'next', type: 'depart', expectedRevision: 0, occurredAt: instant });
  const query = readCompanionContext(ctx, 'owner', plan.id, { ...input, expectedRevision: departed.revision });
  await ready;
  ctx.planLibrary.recordExecution('owner', plan.id, { stopId: 'next', type: 'arrive', expectedRevision: departed.revision, occurredAt: instant });
  resolve({ departureSupport: 'live', leg: { legId: 'road', fromStopId: 'origin', toStopId: 'next', transportMode: 'walking', durationMinutes: 10 } });
  await assert.rejects(query, /进度已变化/);
});

test('未来计划可参考当前道路耗时，但不生成未来预计到达', async () => {
  const { ctx, plan, input } = fixture(road());
  ctx.planLibrary.get('owner', plan.id).localDate = '2026-09-30';
  const result = await readCompanionContext(ctx, 'owner', plan.id, input);
  assert.equal(result.previewOnly, true);
  assert.equal(result.routeUnknown, false);
  assert.equal(result.eta, null);
  assert.equal(result.validUntil, '2026-09-28T03:02:00.000Z');
});
