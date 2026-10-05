import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { modelTurn, toolCall, type ModelToolCall } from '../src/providers/model.js';

test('model-reported departure uses fresh device location and saved transport mode, historical or missing fixes stay unknown', async () => {
  for (const scenario of ['fresh', 'missing', 'historical']) {
    let calls = 0, next: ModelToolCall | undefined;
    const now = '2026-09-22T04:00:00Z';
    const ctx = createServerContext({ seedDemo: false, now: () => now, routeProvider: { providerName: 'progress_road_fixture', async plan(input) {
      calls++; assert.equal(input.transportMode, 'driving'); assert.deepEqual(input.origin, { lat: 31.19, lng: 121.44 });
      return { departureSupport: 'current_only', leg: { legId: 'departure', fromStopId: 'origin', toStopId: 'visit', transportMode: input.transportMode, durationMinutes: 17, distanceMeters: 800, geometry: [{ lat: 31.19, lng: 121.44 }, { lat: 31.2, lng: 121.45 }], geometryCrs: 'WGS84' } };
    } }, modelProvider: { providerName: 'progress_model_fixture', modelName: 'test', async generateTurn() { if (next) { const value = next; next = undefined; return modelTurn([value]); } return modelTurn([], '已记录。'); } } });
    const plan = ctx.planLibrary.save('owner', { name: '出发估时', kind: 'plan', localDate: '2026-09-22', snapshot: { stops: [{ stopId: 'visit', placeId: 'place', place: { placeId: 'place', name: '目的地', coordinates: { lat: 31.2, lng: 121.45 } }, preferredTransportMode: 'driving', status: 'planned', startMinutes: 720, endMinutes: 780 }], routeLegs: [], plannedCharges: [] } });
    next = toolCall('depart', 'progress.record', { planId: plan.id, stopId: 'visit', expectedRevision: 0, action: 'depart', ...(scenario === 'historical' ? { occurredAt: '2026-09-22T03:30:00Z' } : {}) });
    const result = await runPersonalAgent(ctx, 'owner', '我已出发', [], [], scenario === 'missing' ? undefined : { lat: 31.19, lng: 121.44, accuracyMeters: 10, measuredAt: Date.parse(now) });
    assert.equal(result.steps[0].ok, true);
    const stop = ctx.planLibrary.get('owner', plan.id).stops[0] as any;
    assert.equal(stop.estimatedTransportMode, 'driving'); assert.equal(calls, scenario === 'fresh' ? 1 : 0);
    assert.equal(stop.estimatedTravelMinutes, scenario === 'fresh' ? 17 : undefined);
  }
});

test('agent edits note fields with version and ownership checks', async () => {
  let next: ModelToolCall | undefined;
  const ctx = createServerContext({ seedDemo: false, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
    if (next) { const call = next; next = undefined; return modelTurn([call]); }
    return modelTurn([], '处理结束。');
  } } });
  const created = ctx.personalMemoriesService.create('owner', { userText: '原标题\n原正文', localDate: '2026-09-22' });
  assert.ok(created.ok);
  const args = { memoryId: created.value.memoryId, expectedVersion: created.value.entryVersion, title: '新标题', clearDate: true };
  const invoke = async (actor: string, data = args) => {
    next = toolCall('edit', 'memories.edit', data);
    return runPersonalAgent(ctx, actor, '修改笔记标题并清除日期', []);
  };
  assert.equal((await invoke('other')).steps[0].ok, false);
  assert.equal((await invoke('owner')).steps[0].ok, true);
  const saved = ctx.personalMemoriesService.list('owner')[0];
  assert.equal(saved.title, '新标题');
  assert.equal(saved.content, '原正文');
  assert.equal(saved.localDate, undefined);
  assert.equal(saved.entryVersion, created.value.entryVersion + 1);
  assert.equal((await invoke('owner')).steps[0].ok, false);
  assert.deepEqual(ctx.personalMemoriesService.list('owner')[0], saved);
});

test('agent records user times, corrects a timestamp and rejects future, stale and foreign corrections', async () => {
  let next: ModelToolCall | undefined;
  let lastReceipt: any;
  const ctx = createServerContext({ seedDemo: false, now: () => '2026-09-22T12:00:00+08:00', modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request) {
      if (next) { const call = next; next = undefined; return modelTurn([call]); }
      lastReceipt = JSON.parse(request.messages.at(-1)!.content!);
      return modelTurn([], '处理结束。');
    },
  } });
  const plan = ctx.planLibrary.save('owner', { name: '今天', kind: 'plan', localDate: '2026-09-22', snapshot: { stops: [
    { stopId: 'visit', place: { placeId: 'p1', name: '书院' }, startMinutes: 540, endMinutes: 660, status: 'planned' },
    { stopId: 'next', place: { placeId: 'p2', name: '公园' }, startMinutes: 780, endMinutes: 840, status: 'planned' },
  ], routeLegs: [], plannedCharges: [] } });
  const invoke = async (name: string, args: Record<string, unknown>, actor = 'owner') => {
    next = toolCall('test-call', name, args);
    return runPersonalAgent(ctx, actor, '按我报告的实际时间纠正记录', []);
  };
  for (const [i, action] of ['depart', 'arrive', 'complete'].entries()) {
    const result = await invoke('progress.record', { planId: plan.id, stopId: 'visit', expectedRevision: i, action, occurredAt: `2026-09-22T${['09:00', '09:10', '10:00'][i]}:00+08:00` });
    assert.equal(result.steps[0].ok, true);
  }
  const completed = ctx.planLibrary.get('owner', plan.id).executionEvents!.at(-1)!;
  assert.equal(completed.occurredAt, '2026-09-22T10:00:00+08:00');
  const correction = { planId: plan.id, eventId: completed.executionEventId, expectedRevision: 3, action: 'complete', status: 'completed', occurredAt: '2026-09-22T10:15:00+08:00', reason: '刚才记错了' };
  const before = ctx.planLibrary.serialize();
  const future = await invoke('progress.correct', { ...correction, occurredAt: '2026-09-22T13:00:00+08:00' });
  assert.equal(future.steps[0].ok, false);
  assert.match(future.steps[0].error!, /尚未发生/);
  assert.equal(ctx.planLibrary.serialize(), before);
  const foreign = await invoke('progress.correct', correction, 'other');
  assert.equal(foreign.steps[0].ok, false);
  assert.equal(ctx.planLibrary.serialize(), before);
  const success = await invoke('progress.correct', correction);
  assert.equal(success.steps[0].ok, true);
  assert.deepEqual(success.refresh, ['plans', 'memories']);
  const events = ctx.planLibrary.get('owner', plan.id).executionEvents!;
  assert.equal(events.length, 4);
  assert.equal(events[3].correctsEventId, completed.executionEventId);
  assert.equal(events[3].occurredAt, correction.occurredAt);
  assert.equal(events[2].occurredAt, completed.occurredAt, 'original fact is retained in correction history');
  const stale = await invoke('progress.correct', correction);
  assert.equal(stale.steps[0].ok, false);
  assert.equal(ctx.planLibrary.get('owner', plan.id).executionEvents!.length, 4);
  const adjusted = await invoke('plans.adjust_stop', { planId: plan.id, stopId: 'next', expectedRevision: 4, startMinutes: 810, durationMinutes: 60 });
  assert.equal(adjusted.steps[0].ok, true, 'editing a pending stop uses the replayed progress of other stops');
  assert.equal(lastReceipt.result.stops.find((stop: any) => stop.stopId === 'visit').status, 'completed', 'model receives completed progress after editing another stop');
  assert.equal(lastReceipt.result.stops.find((stop: any) => stop.stopId === 'next').status, 'planned');
  assert.equal(ctx.planLibrary.get('owner', plan.id).executionEvents!.length, 4);
  const renamed = await invoke('plans.edit', { planId: plan.id, expectedRevision: lastReceipt.result.revision, action: 'rename', name: '午后散步' });
  assert.equal(renamed.steps[0].ok, true);
  assert.equal(lastReceipt.result.name, '午后散步');
  assert.deepEqual(lastReceipt.result, ctx.planLibrary.list('owner').find(p => p.id === plan.id));
  const historical = ctx.planLibrary.versions('owner', plan.id)[0];
  const restored = await invoke('plans.restore', { planId: plan.id, expectedRevision: lastReceipt.result.revision, versionRevision: historical.revision });
  assert.equal(restored.steps[0].ok, true);
  assert.equal(lastReceipt.result.stops.find((stop: any) => stop.stopId === 'visit').status, 'completed');
  assert.deepEqual(lastReceipt.result, ctx.planLibrary.list('owner').find(p => p.id === plan.id));
});
