import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { createCompanionAdvice, applyCompanionAdvice } from '../src/services/companion-advice.js';
import { DemoPlaceProvider, type RouteProvider } from '../src/providers/travel.js';
import { DEMO_PLACE_IDS } from '../src/demo/demo-data.js';
import { PlanLibraryService } from '../src/services/plan-library.js';

const instant = '2026-09-28T03:00:00Z';
const road: RouteProvider = { providerName: 'test_road_fixture', async plan(input) { return { departureSupport: 'current_only', leg: { legId: 'road', fromStopId: 'origin', toStopId: 'destination', transportMode: input.transportMode, durationMinutes: 10, distanceMeters: 800, geometry: [{ lat: 31.19, lng: 121.44 }, { lat: 31.195, lng: 121.438 }], geometryCrs: 'WGS84' } }; } };
function fixture(route: RouteProvider = road) {
  const clock = { value: instant };
  const ctx = createServerContext({ now: () => clock.value, placeProvider: new DemoPlaceProvider(), routeProvider: route });
  const plan = ctx.planLibrary.save('owner', { name: '随行建议测试', kind: 'plan', localDate: '2026-09-28', cityCode: '310100', timezone: 'Asia/Shanghai', snapshot: {
    stops: [DEMO_PLACE_IDS.xujiahuiLibrary, DEMO_PLACE_IDS.shanghaiLibrary, DEMO_PLACE_IDS.wukang].map((placeId, index) => ({ stopId: `stop${index}`, placeId, place: { placeId, name: `地点${index}` }, startMinutes: 720 + index * 90, endMinutes: 780 + index * 90, plannedDurationMinutes: 60, minDurationMinutes: 15, status: 'planned' })), routeLegs: [], plannedCharges: [],
  } });
  const input = { expectedRevision: 0, change: 'rest', minutes: 15, transportMode: 'walking', position: { lat: 31.19, lng: 121.44, accuracyMeters: 15, measuredAt: Date.parse(instant) } };
  return { ctx, plan, input, clock };
}
const applyInput = (candidate: any, actionKey = 'confirm_advice_001') => ({ previewId: candidate.previewId, expectedRevision: candidate.revision, params: candidate.params, actionKey });

test('四种变化都生成有限、带影响的确定性候选，预览不修改计划', async () => {
  for (const change of ['rest', 'rain', 'time', 'replace']) {
    const { ctx, plan, input } = fixture();
    const before = ctx.planLibrary.serialize();
    const result = await createCompanionAdvice(ctx, 'owner', plan.id, { ...input, change, ...(change === 'time' ? { deadlineMinutes: 850 } : {}) });
    assert.ok(result.candidates.length > 0, `${change}: ${result.reasons.join(';')}`);
    assert.ok(result.candidates.length <= 3);
    for (const candidate of result.candidates) {
      assert.ok(candidate.changes.length > 0);
      assert.ok(candidate.impact.roadMinutesAfter > 0);
      assert.match(candidate.impact.fees, /未报价/);
      assert.ok(candidate.warnings.some(warning => warning.includes('目录')));
      assert.equal('stops' in candidate, false);
      assert.equal('signature' in candidate, false);
    }
    assert.equal(ctx.planLibrary.serialize(), before);
  }
});

test('采用一次保存新版本，重复确认与恢复后重试返回原回执、不二次偏移', async () => {
  const { ctx, plan, input } = fixture();
  const result = await createCompanionAdvice(ctx, 'owner', plan.id, input);
  const body = applyInput(result.candidates[0]);
  const receipt = applyCompanionAdvice(ctx, 'owner', plan.id, body);
  const saved = ctx.planLibrary.serialize();
  assert.equal(receipt.appliedRevision, 1);
  assert.deepEqual(applyCompanionAdvice(ctx, 'owner', plan.id, body), receipt);
  assert.throws(() => applyCompanionAdvice(ctx, 'owner', plan.id, { ...body, params: { ...body.params, minutes: 60 } }), /参数/);
  assert.equal(ctx.planLibrary.serialize(), saved);
  const recovered = new PlanLibraryService(() => instant);
  recovered.loadSerialized(saved);
  const recoveredCtx = { ...ctx, planLibrary: recovered };
  assert.deepEqual(applyCompanionAdvice(recoveredCtx, 'owner', plan.id, body), receipt);
  assert.equal(recovered.serialize(), saved);
});

test('采用参数篡改、版本变化和过期候选必须拒绝且保持原数据', async () => {
  const { ctx, plan, input, clock } = fixture();
  const candidate = (await createCompanionAdvice(ctx, 'owner', plan.id, input)).candidates[0]!;
  const original = ctx.planLibrary.serialize();
  assert.throws(() => applyCompanionAdvice(ctx, 'owner', plan.id, { ...applyInput(candidate), params: { ...candidate.params, minutes: 60 } }), /参数/);
  assert.equal(ctx.planLibrary.serialize(), original);
  clock.value = '2026-09-28T03:06:00Z';
  assert.throws(() => applyCompanionAdvice(ctx, 'owner', plan.id, applyInput(candidate)), /过期/);
  assert.equal(ctx.planLibrary.serialize(), original);
});

test('预览之后出发会使建议失效，保留执行事件与计划', async () => {
  const { ctx, plan, input } = fixture();
  const candidate = (await createCompanionAdvice(ctx, 'owner', plan.id, input)).candidates[0]!;
  ctx.planLibrary.recordExecution('owner', plan.id, { stopId: 'stop0', type: 'depart', expectedRevision: 0, occurredAt: instant });
  const before = ctx.planLibrary.serialize();
  assert.throws(() => applyCompanionAdvice(ctx, 'owner', plan.id, applyInput(candidate)), /变化/);
  assert.equal(ctx.planLibrary.serialize(), before);
});

test('访馆休息只调整尚未开始的后续安排，实际事实完整保留', async () => {
  const { ctx, plan, input } = fixture();
  ctx.planLibrary.recordExecution('owner', plan.id, { stopId: 'stop0', type: 'depart', expectedRevision: 0, occurredAt: instant });
  const arrived = ctx.planLibrary.recordExecution('owner', plan.id, { stopId: 'stop0', type: 'arrive', expectedRevision: 1, occurredAt: instant });
  const events = structuredClone(arrived.executionEvents);
  const result = await createCompanionAdvice(ctx, 'owner', plan.id, { ...input, expectedRevision: arrived.revision, position: undefined });
  assert.ok(result.candidates.length, result.reasons.join(';'));
  assert.ok(result.candidates[0]!.warnings.some(warning => warning.includes('已确认到达')));
  applyCompanionAdvice(ctx, 'owner', plan.id, applyInput(result.candidates[0]));
  const saved = ctx.planLibrary.list('owner').find(item => item.id === plan.id)!;
  assert.deepEqual(saved.executionEvents, events);
  assert.equal((saved.stops[0] as any).status, 'visiting');
});

test('预约、必留和付款地点保护；未知道路不允许冒充可行候选', async () => {
  const { ctx, plan, input } = fixture();
  const raw = ctx.planLibrary.get('owner', plan.id);
  for (const stop of raw.stops as any[]) stop.retain = true;
  const before = ctx.planLibrary.serialize();
  const rain = await createCompanionAdvice(ctx, 'owner', plan.id, { ...input, change: 'rain' });
  assert.equal(rain.candidates.length, 0);
  assert.match(rain.reasons.join(';'), /保护/);
  const rest = await createCompanionAdvice(ctx, 'owner', plan.id, input);
  assert.equal(rest.candidates.length, 0);
  assert.equal(ctx.planLibrary.serialize(), before);
  const fail = fixture({ providerName: 'unavailable_road', async plan() { throw new Error('道路不可用'); } });
  const result = await createCompanionAdvice(fail.ctx, 'owner', fail.plan.id, fail.input);
  assert.equal(result.candidates.length, 0);
  assert.match(result.reasons.join(';'), /道路/);
});

test('只有样例路线时不产生可采用的临时建议，身份隔离不泄漏预览', async () => {
  const { ctx, plan, input } = fixture();
  const candidate = (await createCompanionAdvice(ctx, 'owner', plan.id, input)).candidates[0]!;
  await assert.rejects(createCompanionAdvice(ctx, 'other', plan.id, input), /不存在/);
  assert.throws(() => applyCompanionAdvice(ctx, 'other', plan.id, applyInput(candidate)), /不属于/);
  const previous = ctx.planLibrary.serialize();
  assert.throws(() => applyCompanionAdvice(ctx, 'owner', plan.id, { ...applyInput(candidate), previewId: 'unknown' }), /失效/);
  assert.equal(ctx.planLibrary.serialize(), previous);
});

test('已付款及付款状态未知的地点、费用与源方案在建议应用后完整保留', async () => {
  for (const paymentStatus of ['paid', 'unknown']) {
    const { ctx, plan, input } = fixture();
    const raw = ctx.planLibrary.get('owner', plan.id);
    raw.plannedCharges = [{ chargeId: 'protected-ticket', stopId: 'stop0', quantity: 1, paymentStatus, costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 5000, upperMinor: 5000, certainty: 'known' } }];
    const source = ctx.planLibrary.save('owner', { name: '源静态方案', kind: 'scheme', days: [{ dayIndex: 0, stops: raw.stops, routeLegs: [], plannedCharges: raw.plannedCharges }] });
    raw.sourceSchemeId = source.id; raw.sourceDayIndex = 0;
    const sourceBefore = JSON.stringify(ctx.planLibrary.get('owner', source.id));
    const protectedStop = structuredClone(raw.stops[0]);
    const fees = structuredClone(raw.plannedCharges);
    const result = await createCompanionAdvice(ctx, 'owner', plan.id, { ...input, change: 'time', deadlineMinutes: 850 });
    assert.ok(result.candidates.length, result.reasons.join(';'));
    applyCompanionAdvice(ctx, 'owner', plan.id, applyInput(result.candidates[0]));
    const saved = ctx.planLibrary.get('owner', plan.id);
    for (const field of ['placeId', 'startMinutes', 'endMinutes']) assert.equal((saved.stops[0] as any)[field], (protectedStop as any)[field]);
    assert.deepEqual(saved.plannedCharges, fees);
    assert.equal(JSON.stringify(ctx.planLibrary.get('owner', source.id)), sourceBefore);
  }
});

test('位置明显变化及同版本下事实摘要变化时，旧预览仍必须拒绝', async () => {
  const { ctx, plan, input } = fixture();
  const candidate = (await createCompanionAdvice(ctx, 'owner', plan.id, input)).candidates[0]!;
  const before = ctx.planLibrary.serialize();
  assert.throws(() => applyCompanionAdvice(ctx, 'owner', plan.id, { ...applyInput(candidate), position: { ...input.position, lat: 31.3 } }), /位置已经变化/);
  assert.equal(ctx.planLibrary.serialize(), before);
  (ctx.planLibrary.get('owner', plan.id).stops[0] as any).retain = true;
  const altered = ctx.planLibrary.serialize();
  assert.throws(() => applyCompanionAdvice(ctx, 'owner', plan.id, applyInput(candidate)), /执行记录已变化/);
  assert.equal(ctx.planLibrary.serialize(), altered);
});
