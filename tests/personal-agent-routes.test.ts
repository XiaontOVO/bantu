import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { planAgentRoutes } from '../src/services/personal-agent-routes.js';

test('route updates replace stale fare estimates, preserve visit charges and refuse to rewrite paid transport', async () => {
  let requests = 0;
  const estimate = { currency: 'CNY', basis: 'per_vehicle' as const, lowerMinor: 2000, upperMinor: 3000, certainty: 'bounded' as const };
  const ctx = createServerContext({ seedDemo: false, routeProvider: { providerName: 'test', async plan(input) {
    requests++;
    return { departureSupport: 'current_only' as const, leg: { legId: 'provider', fromStopId: '', toStopId: '', transportMode: input.transportMode, durationMinutes: 10, costEstimate: estimate } };
  } } });
  const places = (await ctx.fallbackPlaceProvider.search({ cityCode: '310100', limit: 2 })).places;
  const day = { dayIndex: 0, stops: places.map((place, i) => ({ stopId: `s${i}`, placeId: place.placeId, place, status: 'planned', startMinutes: 600 + 120 * i, endMinutes: 660 + 120 * i })), routeLegs: [{ legId: 'old-route', fromStopId: 's0', toStopId: 's1', transportMode: 'walking', durationMinutes: 20 }], plannedCharges: [
    { chargeId: 'old-fare', routeLegRef: 'old-route', quantity: 1, costEstimate: { ...estimate, lowerMinor: 200, upperMinor: 200 }, paymentStatus: 'unpaid' },
    { chargeId: 'ticket', stopId: 's1', quantity: 1, costEstimate: estimate, paymentStatus: 'paid' },
  ] };
  const plan = ctx.planLibrary.save('owner', { name: '费用调整', kind: 'scheme', days: [day] });
  const originalTicket = structuredClone(plan.days![0].plannedCharges![1]);
  const saved = await planAgentRoutes(ctx, 'owner', { planId: plan.id, expectedRevision: 0, dayIndex: 0, toStopId: 's1', mode: 'driving' });
  const charges = saved.days![0].plannedCharges as any[];
  assert.equal(charges.length, 2);
  assert.deepEqual(charges.find(c => c.chargeId === 'ticket'), originalTicket);
  assert.equal(charges.some(c => c.chargeId === 'old-fare'), false);
  assert.deepEqual(charges.find(c => c.routeLegRef)?.costEstimate, estimate);
  assert.equal(requests, 1);
  for (const paid of [{ paymentStatus: 'paid' }, { paymentStatus: 'unpaid', includedSpendEventId: 'spent' }]) {
    const next = structuredClone(day);
    Object.assign(next.plannedCharges[0], paid);
    const locked = ctx.planLibrary.save('owner', { name: `付款历史-${paid.paymentStatus}`, kind: 'scheme', days: [next] });
    const before = ctx.planLibrary.serialize();
    await assert.rejects(planAgentRoutes(ctx, 'owner', { planId: locked.id, expectedRevision: 0, dayIndex: 0, mode: 'driving' }), /付款记录/);
    assert.equal(ctx.planLibrary.serialize(), before);
  }
  assert.equal(requests, 1, 'reject before querying external routes');
});

test('one route segment changes mode while subsequent routes retain mode and shift to avoid conflicts', async () => {
  const requests: any[] = [];
  const ctx = createServerContext({ seedDemo: false, routeProvider: { providerName: 'controlled-route', async plan(input) {
    requests.push(input);
    return { departureSupport: 'current_only' as const, leg: { legId: 'new', fromStopId: '', toStopId: '', transportMode: input.transportMode, durationMinutes: 70, bufferMinutes: 5 } };
  } } });
  const places = (await ctx.fallbackPlaceProvider.search({ cityCode: '310100', limit: 3 })).places;
  const plan = ctx.planLibrary.save('owner', { kind: 'scheme', name: '分段调整', days: [{ dayIndex: 0, stops: places.map((place, index) => ({ stopId: `s${index}`, placeId: place.placeId, place, status: 'planned', startMinutes: 600 + index * 90, endMinutes: 660 + index * 90 })), routeLegs: [
    { legId: 'first', fromStopId: 's0', toStopId: 's1', transportMode: 'walking', durationMinutes: 20 },
    { legId: 'second', fromStopId: 's1', toStopId: 's2', transportMode: 'walking', durationMinutes: 20, bufferMinutes: 5 },
  ], plannedCharges: [] }] });
  const args = { planId: plan.id, expectedRevision: 0, dayIndex: 0, toStopId: 's1', mode: 'driving' };
  const original = ctx.planLibrary.serialize();
  const beforeDay = structuredClone(plan.days![0]);
  await assert.rejects(planAgentRoutes(ctx, 'owner', { ...args, toStopId: 'missing' }), /请选择/);
  await assert.rejects(planAgentRoutes(ctx, 'owner', { ...args, toStopId: 's0' }), /请选择/);
  assert.equal(requests.length, 0);
  assert.equal(ctx.planLibrary.serialize(), original);
  const saved = await planAgentRoutes(ctx, 'owner', args);
  const day = saved.days![0];
  assert.equal(requests.length, 1);
  assert.equal(requests[0].destination.placeId, places[1].placeId);
  assert.equal((day.routeLegs.find((leg: any) => leg.legId === 'first') as any).transportMode, 'driving');
  assert.deepEqual(day.routeLegs.find((leg: any) => leg.legId === 'second'), beforeDay.routeLegs[1]);
  assert.deepEqual(day.stops[0], beforeDay.stops[0]);
  assert.equal((day.stops[1] as any).startMinutes, 735);
  assert.equal((day.stops[2] as any).startMinutes, 820);
  assert.equal((day.stops[2] as any).endMinutes, 880);
});

test('route planning bypasses skipped nodes and preserves completed execution history', async () => {
  const requests: any[] = [];
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T11:00:00+08:00', routeProvider: {
    providerName: 'test-route', async plan(input) {
      requests.push(input);
      return { departureSupport: 'current_only' as const, leg: { legId: 'route', fromStopId: '', toStopId: '', transportMode: 'walking' as const, durationMinutes: 20, bufferMinutes: 5 } };
    },
  } });
  const places = (await ctx.fallbackPlaceProvider.search({ cityCode: '310100', limit: 3 })).places;
  let plan = ctx.planLibrary.save('owner', { name: '跳过中间站', kind: 'plan', localDate: '2026-09-22', snapshot: {
    stops: places.map((place, i) => ({ stopId: `s${i}`, placeId: place.placeId, place, status: 'planned', startMinutes: 540 + i * 120, endMinutes: 600 + i * 120 })),
    routeLegs: [{ legId: 'old-incoming', fromStopId: 's1', toStopId: 's2', transportMode: 'walking', durationMinutes: 20 }], plannedCharges: [],
  } });
  for (const [type, stopId, occurredAt] of [
    ['depart', 's0', '2026-09-22T09:00:00+08:00'],
    ['arrive', 's0', '2026-09-22T09:10:00+08:00'],
    ['complete', 's0', '2026-09-22T09:50:00+08:00'],
    ['skip', 's1', '2026-09-22T10:00:00+08:00'],
  ] as const) plan = ctx.planLibrary.recordExecution('owner', plan.id, { type, stopId, occurredAt, expectedRevision: plan.revision || 0 });
  const before = ctx.planLibrary.list('owner').find(p => p.id === plan.id)!;
  const saved = await planAgentRoutes(ctx, 'owner', { planId: plan.id, expectedRevision: plan.revision || 0, mode: 'walking' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].origin.placeId, places[0].placeId);
  assert.equal(requests[0].destination.placeId, places[2].placeId);
  assert.equal(saved.routeLegs.length, 1);
  assert.equal((saved.routeLegs[0] as any).fromStopId, 's0');
  assert.equal((saved.routeLegs[0] as any).toStopId, 's2');
  assert.deepEqual(saved.executionEvents, before.executionEvents);
  for (const stopId of ['s0', 's1']) assert.deepEqual(saved.stops.find(s => (s as any).stopId === stopId), before.stops.find(s => (s as any).stopId === stopId));
});

test('route tool persists geometry, shifts visits and rejects stale and foreign writes', async () => {
  let duringQuery = () => {};
  let fail = false;
  let resultError = false;
  const ctx = createServerContext({ seedDemo: false, routeProvider: {
    providerName: 'test-route', async plan() {
      duringQuery();
      if (fail) throw new Error('路线服务不可用');
      return { departureSupport: 'current_only' as const, ...(resultError ? { error: { code: 'UNAVAILABLE', message: '路线返回错误' } } : {}), leg: { legId: 'provider', fromStopId: '', toStopId: '', transportMode: 'walking' as const, durationSeconds: 1800, bufferMinutes: 5, distanceMeters: 1800, geometry: [{ lat: 31.2, lng: 121.4 }, { lat: 31.21, lng: 121.41 }] } };
    },
  } });
  const places = (await ctx.fallbackPlaceProvider.search({ cityCode: '310100', limit: 5 })).places;
  const plan = ctx.planLibrary.save('owner', { name: '路线方案', kind: 'scheme', days: [{ dayIndex: 0, stops: places.slice(0, 2).map((p, i) => ({ stopId: `stop${i}`, placeId: p.placeId, place: p, status: 'planned', startMinutes: 540 + i * 60, endMinutes: 600 + i * 60 })), routeLegs: [], plannedCharges: [] }] });
  const args = { planId: plan.id, expectedRevision: plan.revision || 0, dayIndex: 0, mode: 'walking' };
  await assert.rejects(planAgentRoutes(ctx, 'other', args), /不存在/);
  const saved = await planAgentRoutes(ctx, 'owner', args);
  assert.equal(saved.days![0].routeLegs.length, 1);
  assert.equal((saved.days![0].routeLegs[0] as any).geometry.length, 2);
  assert.equal((saved.days![0].stops[1] as any).startMinutes, 635);
  assert.equal((saved.days![0].stops[1] as any).endMinutes, 695);
  await assert.rejects(planAgentRoutes(ctx, 'owner', args), /已有更新/);
  args.expectedRevision = saved.revision || 0;
  fail = true;
  await assert.rejects(planAgentRoutes(ctx, 'owner', args), /不可用/);
  assert.deepEqual(ctx.planLibrary.get('owner', plan.id), saved);
  fail = false;
  resultError = true;
  await assert.rejects(planAgentRoutes(ctx, 'owner', args), /路线返回错误/);
  assert.deepEqual(ctx.planLibrary.get('owner', plan.id), saved);
  resultError = false;
  duringQuery = () => { ctx.planLibrary.update('owner', plan.id, { name: '用户改名', days: saved.days }); };
  await assert.rejects(planAgentRoutes(ctx, 'owner', args), /查询路线期间/);
  assert.equal(ctx.planLibrary.get('owner', plan.id).name, '用户改名');
});
