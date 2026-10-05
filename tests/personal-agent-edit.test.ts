import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { editAgentPlan } from '../src/services/personal-agent-edit.js';

test('replacing a place never deletes existing payment facts', async () => {
  const ctx = createServerContext({ seedDemo: false });
  const replacement = (await ctx.options.placeProvider!.search({ cityCode: '310100', query: '武康大楼' })).places[0];
  const plan = ctx.planLibrary.save('owner', { name: '已有付款', kind: 'scheme', days: [{ dayIndex: 0, stops: [
    { stopId: 'paid', place: { placeId: 'old', name: '原地点' }, status: 'planned', startMinutes: 840, endMinutes: 900 },
  ], routeLegs: [], plannedCharges: [{ chargeId: 'ticket', stopId: 'paid', quantity: 1, paymentStatus: 'paid' }] }] });
  const before = ctx.planLibrary.serialize();
  await assert.rejects(editAgentPlan(ctx, 'owner', { action: 'replace_place', planId: plan.id, expectedRevision: 0, dayIndex: 0, stopId: 'paid', placeId: replacement.placeId }), /付款记录/);
  assert.equal(ctx.planLibrary.serialize(), before);
});

test('agent replaces one pending place atomically, keeps times and rejects missing or stale targets', async () => {
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T10:00:00+08:00' });
  const places = await ctx.options.placeProvider!.search({ cityCode: '310100', query: '徐家汇书院' });
  const replacement = places.places[0];
  const plan = ctx.planLibrary.save('owner', { name: '雨天调整', kind: 'plan', localDate: '2026-09-22', snapshot: { stops: [
    { stopId: 'park', place: { placeId: 'old', name: '公园' }, status: 'planned', startMinutes: 840, endMinutes: 900 },
    { stopId: 'later', place: { placeId: 'later-place', name: '后续地点' }, status: 'planned', startMinutes: 960, endMinutes: 1020 },
  ], routeLegs: [], plannedCharges: [{ chargeId: 'old-ticket', stopId: 'park', quantity: 1, paymentStatus: 'unpaid' }] } });
  const original = ctx.planLibrary.serialize();
  const args = { action: 'replace_place', planId: plan.id, expectedRevision: 0, stopId: 'park', placeId: replacement.placeId };
  await assert.rejects(editAgentPlan(ctx, 'owner', { ...args, placeId: 'missing' }), /不存在/);
  assert.equal(ctx.planLibrary.serialize(), original);
  const saved = await editAgentPlan(ctx, 'owner', args);
  assert.equal(saved.revision, 1, 'one replacement creates one revision, not a removal followed by insertion');
  assert.equal(saved.stops.length, 2);
  assert.equal((saved.stops[0] as any).place.name, replacement.name);
  assert.equal((saved.stops[0] as any).startMinutes, 840);
  assert.equal((saved.stops[0] as any).endMinutes, 900);
  assert.deepEqual(saved.stops[1], plan.stops[1]);
  assert.equal(saved.plannedCharges.length, 0);
  const after = ctx.planLibrary.serialize();
  await assert.rejects(editAgentPlan(ctx, 'owner', args), /已有更新/);
  assert.equal(ctx.planLibrary.serialize(), after);
  const stopId = (saved.stops[0] as any).stopId;
  ctx.planLibrary.recordExecution('owner', plan.id, { stopId, type: 'depart', occurredAt: '2026-09-22T10:00:00+08:00' });
  await assert.rejects(editAgentPlan(ctx, 'owner', { ...args, stopId, expectedRevision: 2 }), /已有进度/);
});

test('agent resizes a scheme and moves a node with its visit charge without changing loaded plans', async () => {
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T10:00:00+08:00' });
  const scheme = ctx.planLibrary.save('owner', { name: '跨天编辑', kind: 'scheme', days: [{ dayIndex: 0, stops: [{ stopId: 'visit', place: { placeId: 'p1', name: '书院' }, status: 'planned', startMinutes: 600, endMinutes: 660 }], routeLegs: [], plannedCharges: [{ chargeId: 'ticket', stopId: 'visit', quantity: 1, paymentStatus: 'unpaid' }] }] });
  const loaded = ctx.planLibrary.loadAsPlans('owner', scheme.id, '2026-09-22').plans![0];
  const original = structuredClone(ctx.planLibrary.get('owner', loaded.id));
  const expanded = await editAgentPlan(ctx, 'owner', { action: 'set_days', planId: scheme.id, expectedRevision: 0, dayCount: 3 });
  assert.equal(expanded.days!.length, 3);
  const moved = await editAgentPlan(ctx, 'owner', { action: 'move_stop', planId: scheme.id, expectedRevision: 1, dayIndex: 0, targetDayIndex: 2, stopId: 'visit', startMinutes: 840 });
  assert.equal(moved.days![0].stops.length, 0);
  assert.equal(moved.days![2].stops.length, 1);
  const stop = moved.days![2].stops[0] as any;
  assert.equal(stop.stopId, 'visit');
  assert.equal(stop.startMinutes, 840);
  assert.equal(stop.endMinutes, 900);
  assert.equal(moved.days![0].plannedCharges!.length, 0);
  assert.equal((moved.days![2].plannedCharges![0] as any).chargeId, 'ticket');
  assert.deepEqual(ctx.planLibrary.get('owner', loaded.id), original);
  const before = ctx.planLibrary.serialize();
  await assert.rejects(editAgentPlan(ctx, 'owner', { action: 'move_stop', planId: scheme.id, expectedRevision: 2, dayIndex: 2, targetDayIndex: 6, stopId: 'visit' }), /不存在/);
  assert.equal(ctx.planLibrary.serialize(), before);
  const reduced = await editAgentPlan(ctx, 'owner', { action: 'set_days', planId: scheme.id, expectedRevision: 2, dayCount: 2 });
  assert.equal(reduced.days!.length, 2);
  assert.equal(reduced.days!.flatMap(d => d.stops).length, 0);
  assert.deepEqual(ctx.planLibrary.get('owner', loaded.id), original);
});

test('agent adds canonical places to a selected scheme day, renames and removes with revisions', async () => {
  const ctx = createServerContext({ seedDemo: false });
  const scheme = ctx.planLibrary.save('owner', { name: '两天散步', kind: 'scheme', days: [0, 1].map(dayIndex => ({ dayIndex, stops: [], routeLegs: [], plannedCharges: [] })) });
  const directory = await ctx.fallbackPlaceProvider.search({ cityCode: '310100', query: '', limit: 1 });
  const place = directory.places[0];
  assert.ok(place);
  const added = await editAgentPlan(ctx, 'owner', { action: 'add_place', planId: scheme.id, expectedRevision: 0, dayIndex: 1, placeId: place.placeId, startMinutes: 600, durationMinutes: 60 });
  assert.equal(added.days![0].stops.length, 0);
  assert.equal(added.days![1].stops.length, 1);
  const stop = added.days![1].stops[0] as any;
  assert.equal(stop.place.name, place.name);
  assert.equal(added.revision, 1);
  await assert.rejects(editAgentPlan(ctx, 'owner', { action: 'rename', planId: scheme.id, expectedRevision: 0, name: '过时修改' }), /已有更新/);
  const renamed = await editAgentPlan(ctx, 'owner', { action: 'rename', planId: scheme.id, expectedRevision: 1, name: '轻松走两天' });
  assert.equal(renamed.name, '轻松走两天');
  assert.equal(renamed.days![1].stops.length, 1);
  await assert.rejects(editAgentPlan(ctx, 'other', { action: 'rename', planId: scheme.id, expectedRevision: 2, name: '越权修改' }), /不属于/);
  const removed = await editAgentPlan(ctx, 'owner', { action: 'remove_stop', planId: scheme.id, expectedRevision: 2, dayIndex: 1, stopId: stop.stopId });
  assert.equal(removed.days![1].stops.length, 0);
  assert.equal(removed.revision, 3);
});

test('agent cannot remove active nodes and preserves progress when renaming', async () => {
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T10:30:00+08:00' });
  const plan = ctx.planLibrary.save('owner', { name: '今天散步', kind: 'plan', localDate: '2026-09-22', snapshot: { stops: [{ stopId: 'visit', place: { placeId: 'p1', name: '书院' }, status: 'planned', startMinutes: 600, endMinutes: 660 }], routeLegs: [], plannedCharges: [] } });
  ctx.planLibrary.recordExecution('owner', plan.id, { stopId: 'visit', type: 'depart', occurredAt: '2026-09-22T10:00:00+08:00' });
  const events = structuredClone(ctx.planLibrary.get('owner', plan.id).executionEvents);
  const before = ctx.planLibrary.serialize();
  await assert.rejects(editAgentPlan(ctx, 'owner', { action: 'remove_stop', planId: plan.id, expectedRevision: 1, stopId: 'visit' }), /已有进度/);
  assert.equal(ctx.planLibrary.serialize(), before);
  const renamed = await editAgentPlan(ctx, 'owner', { action: 'rename', planId: plan.id, expectedRevision: 1, name: '今天徐汇散步' });
  assert.deepEqual(renamed.executionEvents, events);
});
