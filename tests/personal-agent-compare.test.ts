import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { compareAgentSchemes } from '../src/services/personal-agent-compare.js';

test('scheme comparison uses canonical places and distinguishes missing travel from zero', async () => {
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T12:00:00+08:00' });
  const places = (await ctx.fallbackPlaceProvider.search({ cityCode: '310100', limit: 2 })).places;
  const day = { dayIndex: 0, stops: places.map((place, i) => ({ stopId: `s${i}`, placeId: place.placeId, place: { placeId: place.placeId, name: '错误的旧名称' }, status: 'planned', startMinutes: 600 + 120 * i, endMinutes: 660 + 120 * i })), routeLegs: [], plannedCharges: [] };
  const a = ctx.planLibrary.save('owner', { name: '有路线', kind: 'scheme', days: [{ ...day, routeLegs: [{ legId: 'route', fromStopId: 's0', toStopId: 's1', transportMode: 'walking', durationMinutes: 20, bufferMinutes: 5, distanceMeters: 1800, departureSupport: 'current_only' }] }] });
  const b = ctx.planLibrary.save('owner', { name: '未算路线', kind: 'scheme', days: [structuredClone(day), { dayIndex: 1, stops: [], routeLegs: [], plannedCharges: [] }] });
  const before = ctx.planLibrary.serialize();
  const { comparisons } = await compareAgentSchemes(ctx, 'owner', [a.id, b.id]);
  assert.equal(comparisons[0].visitMinutes, 120);
  assert.equal(comparisons[0].travelMinutes, 25);
  assert.equal(comparisons[0].distanceMeters, 1800);
  assert.equal(comparisons[0].days[0].stops[0].name, places[0].name);
  assert.equal(comparisons[1].travelMinutes, null);
  assert.equal(comparisons[1].distanceMeters, null);
  assert.equal(comparisons[1].dayCount, 2);
  assert.equal(comparisons[1].emptyDays, 1);
  assert.equal(ctx.planLibrary.serialize(), before);
  await assert.rejects(compareAgentSchemes(ctx, 'other', [a.id, b.id]), /不属于/);
  await assert.rejects(compareAgentSchemes(ctx, 'owner', [a.id, a.id]), /不同/);
});

test('expired routes remain unknown and concurrent edits invalidate comparison', async () => {
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T12:00:00+08:00' });
  const places = (await ctx.fallbackPlaceProvider.search({ cityCode: '310100', limit: 2 })).places;
  const day = { dayIndex: 0, stops: places.map((place, i) => ({ stopId: `s${i}`, placeId: place.placeId, place, status: 'planned', startMinutes: 600 + 120 * i, endMinutes: 660 + 120 * i })), routeLegs: [{ legId: 'expired', fromStopId: 's0', toStopId: 's1', transportMode: 'walking', durationMinutes: 20, distanceMeters: 1000, expiresAt: '2026-09-21T12:00:00+08:00' }], plannedCharges: [] };
  const a = ctx.planLibrary.save('owner', { name: '甲', kind: 'scheme', days: [day] });
  const b = ctx.planLibrary.save('owner', { name: '乙', kind: 'scheme', days: [structuredClone(day)] });
  const result = await compareAgentSchemes(ctx, 'owner', [a.id, b.id]);
  assert.equal(result.comparisons[0].travelMinutes, null);
  assert.equal(result.comparisons[0].days[0].segments[0].expired, true);
  const original = ctx.options.placeProvider!.detail.bind(ctx.options.placeProvider);
  let changed = false;
  ctx.options.placeProvider!.detail = async id => {
    if (!changed) { changed = true; ctx.planLibrary.update('owner', a.id, { name: '修改后的甲', days: a.days }); }
    return original(id);
  };
  await assert.rejects(compareAgentSchemes(ctx, 'owner', [a.id, b.id]), /已变化/);
});
