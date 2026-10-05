import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { PlanLibraryService } from '../src/services/plan-library.js';

test('完成无 Trip 的日计划后自动生成一次旅行记忆所需的路线素材', () => {
  const generated: Array<{ actorId: string; planId: string; generatedBy: string; details: any }> = [];
  const plans = new PlanLibraryService(
    () => '2026-09-20T12:30:00+08:00',
    (actorId, plan, generatedBy, details) => generated.push({ actorId, planId: plan.id, generatedBy, details }),
  );
  const saved = plans.save('owner', {
    name: '今天的徐汇散步', kind: 'plan', localDate: '2026-09-20', timezone: 'Asia/Shanghai', cityCode: '310104',
    snapshot: { stops: [{ stopId: 'church', placeId: 'p1', place: { placeId: 'p1', name: '徐家汇书院' }, startMinutes: 540, endMinutes: 600, status: 'planned' }], routeLegs: [], plannedCharges: [] },
  });
  plans.recordExecution('owner', saved.id, { stopId: 'church', type: 'depart', occurredAt: '2026-09-20T09:00:00+08:00' });
  plans.recordExecution('owner', saved.id, { stopId: 'church', type: 'arrive', occurredAt: '2026-09-20T09:10:00+08:00' });
  plans.recordExecution('owner', saved.id, { stopId: 'church', type: 'complete', occurredAt: '2026-09-20T10:00:00+08:00' });

  assert.equal(generated.length, 1);
  assert.deepEqual(generated[0], {
    actorId: 'owner', planId: saved.id, generatedBy: 'manual',
    details: {
      places: [{ stopId: 'church', placeId: 'p1', name: '徐家汇书院', arrivedAt: '2026-09-20T09:10:00+08:00', completedAt: '2026-09-20T10:00:00+08:00', visitMinutes: 50 }],
      firstEventAt: '2026-09-20T01:00:00.000Z', completedAt: '2026-09-20T02:00:00.000Z', elapsedMinutes: 60,
    },
  });
});

test('完成无旅行实例的日计划后，记忆接口可直接读到旅行回顾卡片数据', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-20T12:30:00+08:00', stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, {
        method, headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, ...(await response.json() as any) };
    };
    const created = await call('/api/v1/plans', 'POST', {
      name: '徐汇一日', localDate: '2026-09-20', timezone: 'Asia/Shanghai', cityCode: '310104',
      snapshot: { stops: [{ stopId: 'church', placeId: 'p1', place: { placeId: 'p1', name: '徐家汇书院' }, startMinutes: 540, endMinutes: 600, status: 'planned' }], routeLegs: [] },
    });
    assert.equal(created.status, 200);
    let revision = created.data.revision || 0;
    for (const [type, occurredAt] of [['depart', '2026-09-20T09:00:00+08:00'], ['arrive', '2026-09-20T09:10:00+08:00'], ['complete', '2026-09-20T10:00:00+08:00']] as const) {
      const updated = await call(`/api/v1/plans/${encodeURIComponent(created.data.id)}/execution-events`, 'POST', {
        stopId: 'church', type, occurredAt, expectedRevision: revision,
      });
      assert.equal(updated.status, 200);
      revision = updated.data.revision;
    }
    const memories = await call('/api/v1/memories');
    assert.equal(memories.status, 200);
    assert.equal(memories.data.length, 1);
    assert.equal(memories.data[0].journey.places[0].name, '徐家汇书院');
    assert.equal(memories.data[0].journey.generatedBy, 'manual');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('过期日计划清理前会自动留下一份已完成地点的旅行记忆', () => {
  const generated: any[] = [];
  const plans = new PlanLibraryService(
    () => '2026-09-20T00:30:00+08:00',
    (actorId, plan, generatedBy, details) => generated.push({ actorId, planId: plan.id, generatedBy, details }),
  );
  plans.loadSerialized(JSON.stringify([{
    id: 'expired-completed', ownerId: 'owner', kind: 'plan', name: '昨天的行程', localDate: '2026-09-19', timezone: 'Asia/Shanghai', cityCode: '310104', savedAt: '2026-09-19T00:00:00Z',
    stops: [{ stopId: 'library', placeId: 'p1', place: { placeId: 'p1', name: '徐家汇书院' }, startMinutes: 540, endMinutes: 600, status: 'completed' }], routeLegs: [], plannedCharges: [],
  }]));
  plans.list('owner');
  assert.equal(generated.length, 1);
  assert.equal(generated[0].generatedBy, 'expiry');
  assert.equal(generated[0].details.places[0].name, '徐家汇书院');
});

test('past dated plans are purged while timeless schemes remain available', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  plans.loadSerialized(JSON.stringify([
    { id: 'old-day', ownerId: 'owner', kind: 'plan', name: '昨天', localDate: '2026-09-19', savedAt: '2026-09-19T00:00:00Z' },
    { id: 'today', ownerId: 'owner', kind: 'plan', name: '今天', localDate: '2026-09-20', savedAt: '2026-09-19T00:00:00Z' },
    { id: 'future', ownerId: 'owner', kind: 'plan', name: '明天', localDate: '2026-09-21', savedAt: '2026-09-19T00:00:00Z' },
    { id: 'la-today', ownerId: 'owner', kind: 'plan', name: '洛杉矶今天', localDate: '2026-09-19', timezone: 'America/Los_Angeles', savedAt: '2026-09-19T00:00:00Z' },
    { id: 'old-scheme', ownerId: 'owner', kind: 'scheme', name: '静态方案', localDate: '2020-01-01', days: [], savedAt: '2020-01-01T00:00:00Z' },
    { id: 'other-owner-old-day', ownerId: 'other', kind: 'plan', name: '其他人的昨天', localDate: '2026-09-19', savedAt: '2026-09-19T00:00:00Z' },
  ]));

  assert.deepEqual(plans.list('owner').map(plan => plan.id).sort(), ['future', 'la-today', 'old-scheme', 'today']);
  assert.deepEqual(plans.list('other'), []);
});

test('cross-midnight dated plans remain executable until the visit ends', () => {
  let now = '2026-09-20T22:00:00+08:00';
  const plans = new PlanLibraryService(() => now);
  const saved = plans.save('owner', {
    name: '??????', kind: 'plan', localDate: '2026-09-20', timezone: 'Asia/Shanghai', cityCode: '310104',
    snapshot: { stops: [{ stopId: 'late', placeId: 'p1', place: { placeId: 'p1', name: '????' }, startMinutes: 1430, endMinutes: 1490, status: 'planned' }], routeLegs: [], plannedCharges: [] },
  });
  plans.recordExecution('owner', saved.id, { stopId: 'late', type: 'depart', occurredAt: '2026-09-20T23:50:00+08:00' });
  now = '2026-09-21T00:05:00+08:00';
  const arrived = plans.recordExecution('owner', saved.id, { stopId: 'late', type: 'arrive', occurredAt: '2026-09-21T00:05:00+08:00' });
  assert.equal((arrived.stops as any[])[0].status, 'visiting');
  assert.equal(plans.list('owner').some(item => item.id === saved.id), true);
  now = '2026-09-21T00:40:00+08:00';
  const completed = plans.recordExecution('owner', saved.id, { stopId: 'late', type: 'complete', occurredAt: '2026-09-21T00:40:00+08:00' });
  assert.equal((completed.stops as any[])[0].status, 'completed');
  assert.equal(plans.list('owner').some(item => item.id === saved.id), false);
});

test('plan library rejects duplicate or invalid stop IDs and dangling route references on save and update', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  const stop = { stopId: 'stop-1', placeId: 'place-1', place: { placeId: 'place-1', name: '湖边休息点' }, startMinutes: 540, endMinutes: 600 };

  assert.throws(() => plans.save('owner', {
    name: '重复地点', kind: 'scheme',
    days: [{ stops: [stop, { ...stop }] }],
  }), /重复的到访记录 ID/);
  assert.throws(() => plans.save('owner', {
    name: '无 ID 地点', kind: 'scheme', days: [{ stops: [{ placeId: 'place-1' }] }],
  }), /地点 ID 无效/);
  assert.throws(() => plans.save('owner', {
    name: '断开的路线', kind: 'scheme',
    days: [{ stops: [stop], routeLegs: [{ legId: 'route-1', fromStopId: 'missing', toStopId: 'stop-1' }] }],
  }), /路线引用了不存在的地点/);
  assert.throws(() => plans.save('owner', {
    name: '越界坐标', kind: 'scheme',
    days: [{ stops: [{ ...stop, place: { placeId: 'place-1', name: '越界地点', coordinates: { lat: 999, lng: 120 } } }] }],
  }), /坐标超出有效范围/);

  const saved = plans.save('owner', {
    name: '有效方案', kind: 'scheme',
    days: [{ stops: [stop], routeLegs: [{ legId: 'route-1', fromStopId: 'origin', toStopId: 'stop-1' }] }],
  });
  assert.throws(() => plans.update('owner', saved.id, {
    name: '有效方案', days: [{ stops: [stop], routeLegs: [{ legId: 'route-2', fromStopId: 'stop-1', toStopId: 'missing' }] }],
  }), /路线引用了不存在的地点/);
  assert.equal((plans.get('owner', saved.id).days?.[0].routeLegs[0] as any).legId, 'route-1', '拒绝更新时原方案内容保持完整');
});

test('plan create and update reject overlapping visits but allow exact handoffs', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  const stop = (stopId: string, startMinutes: number, endMinutes: number) => ({
    stopId, placeId: `place-${stopId}`, place: { placeId: `place-${stopId}`, name: stopId }, startMinutes, endMinutes,
  });

  assert.throws(() => plans.save('owner', {
    name: '时间重叠的新方案', kind: 'scheme',
    // 输入顺序故意与开始时间相反，重叠校验仍应拒绝。
    days: [{ stops: [stop('overlap', 659, 720), stop('first', 600, 660)] }],
  }), /游览时间重叠/);

  const saved = plans.save('owner', {
    name: '首尾相接的方案', kind: 'scheme',
    days: [
      { stops: [stop('first', 600, 660), stop('touching', 660, 720)] },
      // 不同方案日的时间可以相同，不构成同日重叠。
      { stops: [stop('next-day', 600, 700)] },
    ],
  });
  assert.equal(saved.days?.length, 2);

  assert.throws(() => plans.update('owner', saved.id, {
    name: saved.name,
    days: [{ stops: [stop('first', 600, 660), stop('overlap', 659, 720)] }],
  }), /游览时间重叠/);
  assert.deepEqual(plans.get('owner', saved.id).days?.[0].stops.map((item: any) => item.stopId), ['first', 'touching'],
    '拒绝有重叠的更新后原方案应保持不变');
});

test('editing a dated plan shifts later planned stops on the server', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  const stop = (stopId: string, startMinutes: number, endMinutes: number) => ({
    stopId, placeId: `place-${stopId}`, place: { placeId: `place-${stopId}`, name: stopId }, startMinutes, endMinutes,
  });
  const saved = plans.save('owner', {
    name: '可顺延的日计划', kind: 'plan', localDate: '2026-09-20', timezone: 'Asia/Shanghai',
    snapshot: { stops: [stop('first', 600, 660), stop('second', 700, 760)], routeLegs: [], plannedCharges: [] },
  });
  const updated = plans.update('owner', saved.id, {
    name: saved.name,
    snapshot: { stops: [stop('first', 600, 720), stop('second', 700, 760)], routeLegs: [], plannedCharges: [] },
  });
  assert.deepEqual((updated.stops as any[]).map(item => [item.stopId, item.startMinutes, item.endMinutes]), [
    ['first', 600, 720], ['second', 720, 780],
  ]);
});

test('scheme days reject real-time overlaps across midnight but allow exact handoffs', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  const stop = (stopId: string, startMinutes: number, endMinutes: number) => ({
    stopId, placeId: `place-${stopId}`, place: { placeId: `place-${stopId}`, name: stopId }, startMinutes, endMinutes,
  });
  const overlappingDays = [
    { stops: [stop('late-night', 23 * 60 + 30, 25 * 60)] },
    { stops: [stop('early-morning', 30, 90)] },
  ];

  assert.throws(() => plans.save('owner', {
    name: '跨午夜重叠', kind: 'scheme', days: overlappingDays,
  }), /第 1 天.*第 2 天.*时间重叠/);

  const saved = plans.save('owner', {
    name: '跨午夜恰好衔接', kind: 'scheme',
    days: [
      { stops: [stop('late-night', 23 * 60 + 30, 25 * 60)] },
      { stops: [stop('next-after-handoff', 60, 120)] },
    ],
  });
  assert.equal((saved.days?.[0].stops[0] as any).stopId, 'late-night');
  assert.throws(() => plans.update('owner', saved.id, {
    name: saved.name, days: overlappingDays,
  }), /第 1 天.*第 2 天.*时间重叠/);
  assert.equal((plans.get('owner', saved.id).days?.[1].stops[0] as any).stopId, 'next-after-handoff',
    'a rejected cross-day update must leave the saved scheme unchanged');
});

test('editing an expanded day plan rejects overlap with a neighboring plan and allows an exact handoff', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  const stop = (stopId: string, startMinutes: number, endMinutes: number) => ({
    stopId, placeId: `place-${stopId}`, place: { placeId: `place-${stopId}`, name: stopId }, startMinutes, endMinutes,
  });
  const scheme = plans.save('owner', {
    name: '两日方案', kind: 'scheme',
    days: [
      { stops: [stop('late', 1400, 1430)] },
      { stops: [stop('early', 30, 90)] },
    ],
  });
  const expanded = plans.loadAsPlans('owner', scheme.id, '2026-10-01');
  assert.ok(expanded.plans);
  if (!expanded.plans) return;

  const firstDay = expanded.plans[0];
  const secondDay = expanded.plans[1];
  plans.remove('owner', scheme.id);
  const moved = plans.update('owner', firstDay.id, {
    name: firstDay.name,
    localDate: '2026-10-10',
    snapshot: { stops: [stop('late', 1410, 1500)], routeLegs: [], plannedCharges: [] },
  });
  assert.equal(moved.localDate, '2026-10-10', 'a separate date does not conflict with the neighboring plan');
  assert.throws(() => plans.update('owner', firstDay.id, {
    name: firstDay.name,
    localDate: '2026-10-01',
    snapshot: { stops: [stop('late', 1410, 1500)], routeLegs: [], plannedCharges: [] },
  }), /2026-10-01.*2026-10-02.*时间重叠/);
  assert.equal((plans.get('owner', firstDay.id).stops[0] as any).endMinutes, 1500,
    'a rejected edit keeps the original expanded day plan');
  assert.equal(plans.get('owner', firstDay.id).localDate, '2026-10-10',
    'a rejected edit keeps the original date too');

  const handedOff = plans.update('owner', firstDay.id, {
    name: firstDay.name,
    localDate: '2026-10-01',
    snapshot: { stops: [stop('late', 1410, 1470)], routeLegs: [], plannedCharges: [] },
  });
  assert.equal((handedOff.stops[0] as any).endMinutes, 1470, 'neighboring days may meet exactly at the handoff time');
  assert.equal((plans.get('owner', secondDay.id).stops[0] as any).startMinutes, 30);
});

test('loading a legacy scheme rechecks cross-day overlap with arrival-only time aliases', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  plans.loadSerialized(JSON.stringify([{
    id: 'legacy-cross-day', ownerId: 'owner', kind: 'scheme', name: '旧版跨夜方案', cityCode: '330100',
    savedAt: '2026-09-19T00:00:00Z', source: 'imported', stops: [], routeLegs: [], plannedCharges: [],
    days: [
      { dayIndex: 0, stops: [{
        stopId: 'legacy-late', placeId: 'p-late', place: { placeId: 'p-late', name: '深夜地点' },
        plannedArrivalMinutes: 1410, plannedDurationMinutes: 90, status: 'planned',
      }], routeLegs: [], plannedCharges: [] },
      { dayIndex: 1, stops: [{
        stopId: 'legacy-early', placeId: 'p-early', place: { placeId: 'p-early', name: '凌晨地点' },
        startMinutes: 30, endMinutes: 90, status: 'planned',
      }], routeLegs: [], plannedCharges: [] },
    ],
  }]));

  assert.throws(() => plans.loadAsPlans('owner', 'legacy-cross-day', '2026-10-01'), /第 1 天.*第 2 天.*时间重叠/);
  assert.equal(plans.list('owner').length, 1, 'a rejected legacy load leaves the reusable scheme intact');
});

test('scheme loading detects progress overlap in legacy arrival-plus-duration stops before importing', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  plans.loadSerialized(JSON.stringify([{
    id: 'legacy-duration-scheme', ownerId: 'owner', kind: 'scheme', name: '旧格式时长方案', cityCode: '310100',
    savedAt: '2026-09-19T00:00:00Z', source: 'imported', stops: [], routeLegs: [], plannedCharges: [],
    days: [{ dayIndex: 0, stops: [{
      stopId: 'candidate-stop', placeId: 'candidate-place', place: { placeId: 'candidate-place', name: '候选地点' },
      plannedArrivalMinutes: 600, plannedDurationMinutes: 60, status: 'planned',
    }], routeLegs: [], plannedCharges: [] }],
  }]));
  const progress = [{
    stopId: 'completed-stop', placeId: 'completed-place', place: { placeId: 'completed-place', name: '已完成地点', coordinates: null, facilityCodes: [] },
    date: '2026-10-01', startMinutes: 600, endMinutes: 660, status: 'completed' as const,
  }];

  const conflict = plans.loadAsPlans('owner', 'legacy-duration-scheme', '2026-10-01', false, { stops: progress, revision: 2 });
  assert.equal(conflict.progressConflict, true, 'arrival + duration is enough to detect the time collision');
  assert.equal(conflict.progressConflicts?.[0]?.timeOverlap, true);

  const imported = plans.loadAsPlans('owner', 'legacy-duration-scheme', '2026-10-01', false, {
    stops: progress, revision: 2, confirmed: true, confirmationToken: conflict.confirmationToken,
  });
  assert.ok(imported.plans, 'confirming the collision imports a safely shifted schedule');
  assert.equal(imported.plans?.[0].localDate, '2026-10-01');
  assert.equal((imported.plans?.[0].stops[0] as any).plannedArrivalMinutes, 660);
  assert.equal((imported.plans?.[0].stops[0] as any).plannedDurationMinutes, 60);
});

test('scheme loading projects an active overnight progress interval onto its current date', () => {
  const makePlans = (id: string, startMinutes: number) => {
    const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
    plans.loadSerialized(JSON.stringify([{
      id, ownerId: 'owner', kind: 'scheme', name: `overnight-${id}`, cityCode: '310100',
      savedAt: '2026-09-19T00:00:00Z', source: 'imported', stops: [], routeLegs: [], plannedCharges: [],
      days: [{ dayIndex: 0, stops: [{
        stopId: `candidate-${id}`, placeId: `candidate-place-${id}`,
        place: { placeId: `candidate-place-${id}`, name: `候选地点-${id}` },
        startMinutes, endMinutes: startMinutes + 60, status: 'planned',
      }], routeLegs: [], plannedCharges: [] }],
    }]));
    return plans;
  };
  const afterMidnight = makePlans('just-after-midnight', 15);
  const laterInDay = makePlans('later-in-the-day', 12 * 60);
  const overnightProgress = [{
    stopId: 'active-overnight-stop', placeId: 'active-overnight-place',
    place: { placeId: 'active-overnight-place', name: '跨夜进行中的地点', coordinates: null, facilityCodes: [] },
    date: '2026-10-02', status: 'visiting' as const,
    travelStartMinutes: 1430, startMinutes: 1430, endMinutes: 1490, progressEndMinutes: 10,
  }];

  const conflict = afterMidnight.loadAsPlans('owner', 'just-after-midnight', '2026-10-02', false, {
    stops: overnightProgress, revision: 2,
  });
  assert.equal(conflict.progressConflict, true, '23:50–00:50 should conflict with a 00:15 plan');
  assert.equal(conflict.progressConflicts?.[0]?.timeOverlap, true);
  const shifted = afterMidnight.loadAsPlans('owner', 'just-after-midnight', '2026-10-02', false, {
    stops: overnightProgress, revision: 2, confirmed: true, confirmationToken: conflict.confirmationToken,
  });
  assert.equal((shifted.plans?.[0].stops[0] as any).startMinutes, 50, 'confirmed import should begin after the active stop');

  const later = laterInDay.loadAsPlans('owner', 'later-in-the-day', '2026-10-02', false, {
    stops: overnightProgress, revision: 2,
  });
  assert.equal(later.progressConflict, undefined, 'a noon plan should not collide with an interval that ended at 00:50');
  assert.equal((later.plans?.[0].stops[0] as any).startMinutes, 12 * 60);
});

test('scheme stops are stably sorted by explicit start time on save, update, legacy read and load', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  const stop = (stopId: string, times: Record<string, unknown> = {}) => ({
    stopId, placeId: `place-${stopId}`, place: { placeId: `place-${stopId}`, name: stopId }, ...times,
  });
  const unsorted = [
    stop('untimed-first'),
    stop('planned-start', { plannedStartMinutes: 900, endMinutes: 960 }),
    stop('middle', { startMinutes: 700, endMinutes: 750 }),
    stop('departure-alias', { plannedDepartureMinutes: 600, endMinutes: 650 }),
    stop('arrival-alias', { plannedArrivalMinutes: 650, plannedDepartureMinutes: 720, departureMinutes: 730, endMinutes: 690 }),
    stop('middle-tie', { startMinutes: 700, endMinutes: 760, status: 'skipped' }),
    stop('start-takes-priority', { startMinutes: 800, plannedStartMinutes: 500, endMinutes: 850 }),
    stop('untimed-second'),
  ];
  const expected = [
    'departure-alias', 'arrival-alias', 'middle', 'middle-tie', 'start-takes-priority', 'planned-start', 'untimed-first', 'untimed-second',
  ];
  const routeLegs = [
    { legId: 'leg-to-planned-start', fromStopId: 'origin', toStopId: 'planned-start' },
    { legId: 'leg-to-departure-alias', fromStopId: 'planned-start', toStopId: 'departure-alias' },
  ];
  const plannedCharges = [
    { chargeId: 'charge-for-middle', stopId: 'middle' },
    { chargeId: 'charge-for-route', routeLegRef: 'leg-to-departure-alias' },
  ];
  const saved = plans.save('owner', {
    name: '自动排序方案', kind: 'scheme',
    days: [{ stops: unsorted, routeLegs, plannedCharges }],
  });
  assert.deepEqual(saved.days?.[0].stops.map((item: any) => item.stopId), expected);
  assert.deepEqual(saved.days?.[0].routeLegs.map((item: any) => item.legId), ['leg-to-planned-start', 'leg-to-departure-alias']);
  assert.deepEqual(saved.days?.[0].plannedCharges, plannedCharges, '排序不改路线和费用引用');

  const updated = plans.update('owner', saved.id, {
    name: saved.name,
    days: [{ stops: [...unsorted].reverse(), routeLegs, plannedCharges }],
  });
  assert.deepEqual(updated.days?.[0].stops.map((item: any) => item.stopId), [
    'departure-alias', 'arrival-alias', 'middle-tie', 'middle', 'start-takes-priority', 'planned-start', 'untimed-second', 'untimed-first',
  ], '更新时间相同时和缺失时间地点都保留原相对顺序');

  const legacy = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  legacy.loadSerialized(JSON.stringify([{
    id: 'old-scheme', ownerId: 'owner', kind: 'scheme', name: '旧方案', cityCode: '330100',
    savedAt: '2026-09-19T00:00:00Z', source: 'imported', stops: [], routeLegs: [], plannedCharges: [],
    days: [{ dayIndex: 0, stops: unsorted, routeLegs, plannedCharges }],
  }]));
  assert.deepEqual(legacy.list('owner')[0].days?.[0].stops.map((item: any) => item.stopId), expected,
    '读取旧持久化数据时列表即返回已排序内容');
  const expanded = legacy.loadAsPlans('owner', 'old-scheme', '2026-09-20');
  assert.ok(expanded.plans);
  if (expanded.plans) {
    assert.deepEqual(expanded.plans[0].stops.map((item: any) => item.stopId), expected.filter(id => id !== 'middle-tie'));
    assert.deepEqual(expanded.plans[0].routeLegs.map((item: any) => item.legId), ['leg-to-planned-start', 'leg-to-departure-alias']);
  }
});

test('plan create and update validate explicit time ranges and allow cross-midnight starts', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  const stop = (stopId: string, startMinutes: number, endMinutes: number) => ({
    stopId, placeId: `place-${stopId}`, place: { placeId: `place-${stopId}`, name: stopId }, startMinutes, endMinutes,
  });

  assert.throws(() => plans.save('owner', {
    name: '零时长方案', kind: 'scheme', days: [{ stops: [stop('zero', 600, 600)] }],
  }), /开始或结束时间无效/);
  const overnight = plans.save('owner', {
    name: '?????', kind: 'scheme', days: [{ stops: [stop('late', 1440, 1500)] }],
  });
  assert.equal(overnight.days?.length, 2);
  assert.equal(overnight.days?.[0].stops.length, 0);
  assert.equal((overnight.days?.[1].stops[0] as any).startMinutes, 0);

  const saved = plans.save('owner', {
    name: '可编辑方案', kind: 'scheme', days: [{ stops: [stop('valid', 600, 660)] }],
  });
  assert.throws(() => plans.update('owner', saved.id, {
    name: saved.name, days: [{ stops: [stop('valid', 600, 600)] }],
  }), /开始或结束时间无效/);
  assert.equal((plans.get('owner', saved.id).days?.[0].stops[0] as any).endMinutes, 660,
    '拒绝无效更新后保留原有有效安排');
});

test('reusable schemes reset execution states; loading omits skipped places and dependent records', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  let startMinutes = 600;
  const stop = (stopId: string, status: string) => {
    const value = {
      stopId, placeId: `place-${stopId}`, place: { placeId: `place-${stopId}`, name: stopId },
      startMinutes, endMinutes: startMinutes + 60, status,
    };
    startMinutes += 90;
    return value;
  };
  const scheme = plans.save('owner', {
    name: '带历史状态的方案', kind: 'scheme', cityCode: '330100',
    days: [{
      stops: [stop('completed', 'completed'), stop('visiting', 'visiting'), stop('skipped', 'skipped'), stop('planned', 'planned')],
      routeLegs: [
        { legId: 'route-completed', fromStopId: 'origin', toStopId: 'completed' },
        { legId: 'route-visiting', fromStopId: 'completed', toStopId: 'visiting' },
        { legId: 'route-skipped', fromStopId: 'origin', toStopId: 'skipped' },
        { legId: 'route-planned', fromStopId: 'visiting', toStopId: 'planned' },
      ],
      plannedCharges: [
        { chargeId: 'skip-fee', stopId: 'skipped' },
        { chargeId: 'skip-route-fee', routeLegRef: 'route-skipped' },
        { chargeId: 'keep-fee', stopId: 'planned' },
        { chargeId: 'standalone-fee' },
      ],
    }],
  }, 'current');
  const savedStatuses = (scheme.days?.[0].stops as any[]).map(item => item.status);
  assert.deepEqual(savedStatuses, ['planned', 'planned', 'skipped', 'planned'],
    'execution progress becomes reusable planning; an intentional skip remains a library choice');

  const firstLoad = plans.loadAsPlans('owner', scheme.id, '2026-09-20');
  assert.ok(firstLoad.plans);
  if (!firstLoad.plans) return;
  const dailyPlan = firstLoad.plans[0];
  assert.deepEqual(dailyPlan.stops.map((item: any) => item.stopId), ['completed', 'visiting', 'planned']);
  assert.ok(dailyPlan.stops.every((item: any) => item.status === 'planned'));
  assert.deepEqual(dailyPlan.routeLegs.map((item: any) => item.legId), ['route-completed', 'route-visiting', 'route-planned']);
  assert.deepEqual(dailyPlan.plannedCharges.map((item: any) => item.chargeId), ['keep-fee', 'standalone-fee']);

  const secondLoad = plans.loadAsPlans('owner', scheme.id, '2026-09-20');
  assert.ok(secondLoad.plans);
  assert.equal(plans.list('owner').filter(plan => plan.sourceSchemeId === scheme.id).length, 1,
    'reloading replaces the previous generated copy instead of duplicating it');
});

test('an expired daily plan keeps only unexecuted stops in a named reusable scheme', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  plans.loadSerialized(JSON.stringify([{
    id: 'old-day', ownerId: 'owner', kind: 'plan', name: '西湖漫游及周边景点每日多站安排说明文字超长测试方案名称保持日期', cityCode: '330100',
    localDate: '2026-09-19', savedAt: '2026-09-19T00:00:00Z',
    stops: [
      { stopId: 'pending', date: '2026-09-19', status: 'planned', startMinutes: 600, endMinutes: 660 },
      { stopId: 'done', date: '2026-09-19', status: 'completed', startMinutes: 700, endMinutes: 760 },
    ],
    routeLegs: [
      { legId: 'keep', fromStopId: 'origin', toStopId: 'pending' },
      { legId: 'drop', fromStopId: 'pending', toStopId: 'done' },
    ],
    plannedCharges: [
      { chargeId: 'ticket-pending', stopId: 'pending', quantity: 1, costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 5000, upperMinor: 5000, certainty: 'known' }, paymentStatus: 'unpaid' },
      { chargeId: 'ticket-done', stopId: 'done', quantity: 1, costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 3000, upperMinor: 3000, certainty: 'known' }, paymentStatus: 'paid' },
    ],
  }]));

  assert.equal(plans.purgePastDatedPlans('owner'), 1);
  const [scheme] = plans.list('owner');
  assert.equal(scheme.kind, 'scheme');
  assert.match(scheme.name, /西湖漫游.*未完成.*2026-09-19/);
  assert.ok(scheme.name.length <= 40);
  assert.equal(scheme.localDate, undefined, '归档方案不再绑定过期日期');
  assert.deepEqual(scheme.days?.[0].stops.map((stop: any) => stop.stopId), ['pending']);
  assert.equal((scheme.days?.[0].stops[0] as any).date, undefined);
  assert.deepEqual(scheme.days?.[0].routeLegs.map((leg: any) => leg.legId), ['keep']);
  assert.deepEqual(scheme.days?.[0].plannedCharges?.map((charge: any) => charge.chargeId), ['ticket-pending']);
});

test('a trip archive and its identical expanded day collapse into one reusable scheme', () => {
  let now = '2026-09-19T08:00:00+08:00';
  const plans = new PlanLibraryService(() => now);
  const stop = { stopId: 'same-stop', status: 'planned', startMinutes: 600, endMinutes: 660 };
  const route = { legId: 'same-route', fromStopId: 'origin', toStopId: 'same-stop', durationMinutes: 20 };
  const charge = { chargeId: 'same-charge', stopId: 'same-stop', quantity: 1 };
  plans.loadSerialized(JSON.stringify([
    { id: 'source', ownerId: 'owner', kind: 'scheme', name: '原方案', cityCode: '330100', savedAt: now, days: [
      { dayIndex: 0, stops: [stop], routeLegs: [route], plannedCharges: [charge] },
    ] },
    { id: 'expanded', ownerId: 'owner', kind: 'plan', sourceSchemeId: 'source', sourceDayIndex: 0,
      name: '原方案 · 第 1 天', cityCode: '330100', localDate: '2026-09-19', savedAt: now,
      stops: [stop], routeLegs: [route], plannedCharges: [charge] },
  ]));

  plans.archiveExpiredTripDay({ ownerId: 'owner', tripId: 'trip', cityCode: '330100', timezone: 'Asia/Shanghai',
    date: '2026-09-19', stops: [stop], routeLegs: [route], plannedCharges: [charge] });
  now = '2026-09-20T00:30:00+08:00';
  const archives = plans.list('owner').filter(plan => plan.archiveDate === '2026-09-19');
  assert.equal(archives.length, 1, 'the same day should not be archived twice from trip and plan cleanup');
  assert.deepEqual(archives[0].days?.[0].stops.map((item: any) => item.stopId), ['same-stop']);
});

test('a dated day containing only standalone planned charges is archived too', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  plans.loadSerialized(JSON.stringify([{
    id: 'charge-only', ownerId: 'owner', kind: 'plan', name: '交通预算', cityCode: '330100',
    localDate: '2026-09-19', savedAt: '2026-09-19T00:00:00Z', stops: [], routeLegs: [],
    plannedCharges: [{ chargeId: 'taxi', quantity: 1, paymentStatus: 'unpaid' }],
  }]));

  const [scheme] = plans.list('owner');
  assert.equal(scheme.kind, 'scheme');
  assert.deepEqual(scheme.days?.[0].plannedCharges?.map((charge: any) => charge.chargeId), ['taxi']);
});

test('a stop corrected back to planned is archived after its day expires', () => {
  let now = '2026-09-19T08:00:00+08:00';
  const context = createServerContext({ now: () => now });
  const { principal, session } = context.service.createAnonymousSession();
  const created = context.service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-19', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;
  const planned = context.service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [{ stopId: 'corrected-stop', placeId: 'p1', place: { placeId: 'p1', name: '更正地点', coordinates: null, facilityCodes: [] },
      startMinutes: 600, endMinutes: 660, status: 'planned', date: '2026-09-19' }],
  });
  assert.ok(planned.ok); if (!planned.ok) return;
  now = '2026-09-19T10:00:00+08:00';
  const completed = context.service.recordExecution({
    actorId: principal.principalId, sessionId: session.sessionId, tripId: created.value.trip.tripId,
    stopId: 'corrected-stop', type: 'complete', occurredAt: '2026-09-19T10:00:00+08:00',
    expectedRevision: planned.value.trip.revision,
  });
  assert.ok(completed.ok); if (!completed.ok) return;
  const eventId = completed.value.snapshot.executionEvents?.[0]?.executionEventId;
  assert.ok(eventId);
  const corrected = context.service.recordExecutionCorrection({
    actorId: principal.principalId, tripId: created.value.trip.tripId, eventIdToCorrect: eventId!,
    type: 'complete', statusOverride: 'planned', correctionReason: '误点完成',
    expectedRevision: completed.value.trip.revision,
  });
  assert.ok(corrected.ok); if (!corrected.ok) return;
  assert.equal(corrected.value.snapshot.stops?.[0].status, 'planned');

  now = '2026-09-20T00:30:00+08:00';
  context.service.getTrip(principal.principalId, created.value.trip.tripId);
  const [scheme] = context.planLibrary.list(principal.principalId);
  assert.equal(scheme.kind, 'scheme');
  assert.deepEqual(scheme.days?.[0].stops.map((stop: any) => stop.stopId), ['corrected-stop']);
});

test('an edited day expanded from a scheme is archived before its dated copy is removed', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  plans.loadSerialized(JSON.stringify([
    { id: 'source', ownerId: 'owner', kind: 'scheme', name: '原始方案', cityCode: '330100', savedAt: '2026-09-01T00:00:00Z', days: [
      { dayIndex: 0, stops: [{ stopId: 'original', status: 'planned' }], routeLegs: [] },
    ] },
    { id: 'expanded', ownerId: 'owner', kind: 'plan', sourceSchemeId: 'source', sourceDayIndex: 0, name: '已展开的一天', cityCode: '330100', localDate: '2026-09-19', savedAt: '2026-09-19T00:00:00Z',
      stops: [{ stopId: 'edited-stop', status: 'planned' }], routeLegs: [] },
  ]));

  const saved = plans.list('owner');
  assert.equal(saved.some(plan => plan.id === 'expanded'), false, 'expired dated copy should be removed');
  assert.ok(saved.some(plan => plan.id === 'source'), 'original reusable source remains');
  const archive = saved.find(plan => plan.kind === 'scheme' && plan.name.includes('已展开的一天'));
  assert.ok(archive, 'edited contents must become an independent reusable scheme');
  assert.ok(!archive.name.includes('未完成'), 'a scheme expansion has no execution facts, so its archive must not claim the stops were unfinished');
  assert.deepEqual(archive.days?.[0].stops.map((stop: any) => stop.stopId), ['edited-stop']);
});

test('an edited expanded day is covered by the trip expiry archive after partial execution', () => {
  let now = '2026-09-19T08:00:00+08:00';
  const context = createServerContext({ now: () => now });
  const { principal, session } = context.service.createAnonymousSession();
  const makeStop = (stopId: string, name: string, startMinutes: number) => ({
    stopId,
    placeId: `place-${stopId}`,
    place: { placeId: `place-${stopId}`, name, coordinates: null, facilityCodes: [] },
    startMinutes,
    endMinutes: startMinutes + 60,
    departureMinutes: startMinutes + 60,
    status: 'planned',
  });
  const source = context.planLibrary.save(principal.principalId, {
    name: '三站方案', kind: 'scheme', cityCode: '330100', timezone: 'Asia/Shanghai', localDate: '2026-09-19',
    days: [{ dayIndex: 0, stops: [makeStop('done-stop', '已完成地点', 540), makeStop('pending-a', '待完成地点 A', 660), makeStop('pending-b', '待完成地点 B', 780)], routeLegs: [], plannedCharges: [] }],
  }, 'draft');
  const loaded = context.planLibrary.loadAsPlans(principal.principalId, source.id, '2026-09-19');
  assert.ok(loaded.plans);
  if (!loaded.plans) return;
  const dailyPlan = loaded.plans[0];

  const created = context.service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-19', dataMode: 'demo', timezone: 'Asia/Shanghai',
  });
  assert.ok(created.ok); if (!created.ok) return;
  const mounted = context.service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: dailyPlan.stops.map((stop: any) => ({ ...stop, date: '2026-09-19' })),
  });
  assert.ok(mounted.ok); if (!mounted.ok) return;

  let revision = mounted.value.trip.revision;
  for (const [type, occurredAt] of [
    ['depart', '2026-09-19T09:00:00+08:00'],
    ['arrive', '2026-09-19T09:10:00+08:00'],
    ['complete', '2026-09-19T10:00:00+08:00'],
  ] as const) {
    now = occurredAt;
    const result = context.service.recordExecution({
      actorId: principal.principalId, sessionId: session.sessionId, tripId: created.value.trip.tripId,
      stopId: 'done-stop', type, occurredAt, expectedRevision: revision,
    });
    assert.ok(result.ok, `expected ${type} to succeed: ${JSON.stringify(result)}`);
    if (!result.ok) return;
    revision = result.value.trip.revision;
  }

  // Editing the library copy does not edit the already-mounted execution snapshot.
  const editedStops = dailyPlan.stops.map((stop: any) => stop.stopId === 'pending-a'
    ? { ...stop, startMinutes: 690, endMinutes: 750, departureMinutes: 750 }
    : stop);
  context.planLibrary.update(principal.principalId, dailyPlan.id, {
    name: dailyPlan.name, localDate: dailyPlan.localDate, cityCode: dailyPlan.cityCode,
    timezone: dailyPlan.timezone,
    snapshot: { stops: editedStops, routeLegs: dailyPlan.routeLegs, plannedCharges: dailyPlan.plannedCharges },
  });

  now = '2026-09-20T00:30:00+08:00';
  const expiredTrip = context.service.getTrip(principal.principalId, created.value.trip.tripId);
  assert.ok(expiredTrip.ok); if (!expiredTrip.ok) return;
  const archives = context.planLibrary.list(principal.principalId).filter(plan => plan.archiveDate === '2026-09-19');
  assert.equal(archives.length, 1, 'the trip snapshot archive should cover the changed daily-plan copy');
  assert.match(archives[0].name, /未完成计划.*2026-09-19/);
  assert.deepEqual(archives[0].days?.[0].stops.map((stop: any) => stop.stopId), ['pending-a', 'pending-b']);
  assert.ok(!archives[0].days?.[0].stops.some((stop: any) => stop.stopId === 'done-stop'),
    'the library copy has no progress facts and must not reintroduce the completed stop');
  assert.equal((archives[0].days?.[0].stops.find((stop: any) => stop.stopId === 'pending-a') as any).startMinutes, 670,
    'when library and execution copies differ, the trip snapshot remains the progress-authoritative archive (只延后不提前，到达顺延的 +10 不再被提前完成拉回)');
  assert.equal(context.planLibrary.list(principal.principalId).some(plan => plan.id === dailyPlan.id), false,
    'expired dated copy is removed after cleanup');
});

test('an unchanged expired day expanded from a reusable scheme does not create a duplicate', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T00:30:00+08:00');
  const stop = { stopId: 'same-stop', status: 'planned', startMinutes: 600, endMinutes: 660 };
  plans.loadSerialized(JSON.stringify([
    { id: 'source', ownerId: 'owner', kind: 'scheme', name: '已可复用的原方案', cityCode: '330100', savedAt: '2026-09-01T00:00:00Z', days: [
      { dayIndex: 0, stops: [stop], routeLegs: [], plannedCharges: [] },
    ] },
    { id: 'expanded', ownerId: 'owner', kind: 'plan', sourceSchemeId: 'source', sourceDayIndex: 0,
      name: '已可复用的原方案 · 第 1 天', cityCode: '330100', localDate: '2026-09-19', savedAt: '2026-09-19T00:00:00Z',
      stops: [stop], routeLegs: [], plannedCharges: [] },
  ]));

  const saved = plans.list('owner');
  assert.deepEqual(saved.map(plan => plan.id), ['source']);
});

test('trip expiry archives unexecuted stops before progress cleanup deletes them', () => {
  let now = '2026-09-19T09:00:00+08:00';
  const context = createServerContext({ now: () => now });
  const { principal } = context.service.createAnonymousSession();
  const created = context.service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-19', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;
  const planned = context.service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [{
      stopId: 'not-visited', placeId: 'p1',
      place: { placeId: 'p1', name: '未执行地点', coordinates: null, facilityCodes: [] },
      startMinutes: 600, endMinutes: 660, status: 'planned', date: '2026-09-19',
    }],
    plannedCharges: [{ chargeId: 'ticket', stopId: 'not-visited', quantity: 1,
      costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 5000, upperMinor: 5000, certainty: 'known' }, paymentStatus: 'unpaid' }],
  });
  assert.ok(planned.ok); if (!planned.ok) return;

  now = '2026-09-20T00:30:00+08:00';
  const cleaned = context.service.getTrip(principal.principalId, created.value.trip.tripId);
  assert.ok(cleaned.ok); if (!cleaned.ok) return;
  assert.deepEqual(cleaned.value.snapshot.stops, []);

  const archived = context.planLibrary.list(principal.principalId);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].kind, 'scheme');
  assert.match(archived[0].name, /未完成计划.*2026-09-19/);
  assert.equal(archived[0].localDate, undefined, '归档方案应能按新日期复用');
  assert.deepEqual(archived[0].days?.[0].stops.map((stop: any) => stop.stopId), ['not-visited']);
  assert.deepEqual(archived[0].days?.[0].plannedCharges?.map((charge: any) => charge.chargeId), ['ticket']);

  context.service.purgePastProgress();
  assert.equal(context.planLibrary.list(principal.principalId).length, 1, '重复清理不得生成重复方案');
});

test('a trip-level unassigned charge is archived once across multiple expired days', () => {
  let now = '2026-09-19T08:00:00+08:00';
  const context = createServerContext({ now: () => now });
  const { principal } = context.service.createAnonymousSession();
  const created = context.service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-19', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;
  const planned = context.service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [
      { stopId: 'day-one', date: '2026-09-19', placeId: 'p1', place: { placeId: 'p1', name: '第一天', coordinates: null, facilityCodes: [] }, startMinutes: 600, endMinutes: 660, status: 'planned' },
      { stopId: 'day-two', date: '2026-09-20', placeId: 'p2', place: { placeId: 'p2', name: '第二天', coordinates: null, facilityCodes: [] }, startMinutes: 600, endMinutes: 660, status: 'planned' },
    ],
    plannedCharges: [{ chargeId: 'trip-ticket', quantity: 1,
      costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 5000, upperMinor: 5000, certainty: 'known' },
      paymentStatus: 'unpaid' }],
  });
  assert.ok(planned.ok); if (!planned.ok) return;

  now = '2026-09-21T00:30:00+08:00';
  context.service.getTrip(principal.principalId, created.value.trip.tripId);
  const archives = context.planLibrary.list(principal.principalId).filter(plan => plan.archiveDate);
  assert.equal(archives.length, 2);
  const archivedChargeCount = archives.reduce((total, plan) => total + (plan.days?.[0].plannedCharges?.length || 0), 0);
  assert.equal(archivedChargeCount, 1);
});

test('plan library trip-day archival deduplicates an unbound charge by charge ID across dates', () => {
  const plans = new PlanLibraryService(() => '2026-09-21T00:30:00+08:00');
  const charge = (includedSpendEventId: string) => ({
    chargeId: 'trip-wide-ticket', quantity: 1, includedSpendEventId,
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 5000, upperMinor: 5000, certainty: 'known' },
    paymentStatus: 'unpaid',
  });
  for (const [date, stopId, spendId] of [
    ['2026-09-19', 'first-day-stop', 'spend-first'],
    ['2026-09-20', 'second-day-stop', 'spend-second'],
  ]) {
    const dayCharges = [charge(spendId)];
    if (date === '2026-09-20') dayCharges.push({ ...charge(spendId), chargeId: 'separate-trip-fee' });
    plans.archiveExpiredTripDay({
      ownerId: 'owner', tripId: 'trip', cityCode: '330100', timezone: 'Asia/Shanghai', date,
      stops: [{ stopId, status: 'planned' }], routeLegs: [], plannedCharges: dayCharges,
    });
  }

  const archived = plans.list('owner').filter(plan => plan.tripId === 'trip');
  assert.equal(archived.length, 2, 'each expired day keeps its own reusable plan');
  const copies = archived.flatMap(plan => plan.days?.flatMap(day => day.plannedCharges || []) || [])
    .filter(item => (item as { chargeId?: string }).chargeId === 'trip-wide-ticket');
  assert.equal(copies.length, 1, 'the same trip-level fee must be stored in only one day archive');
  const separateFeeCopies = archived.flatMap(plan => plan.days?.flatMap(day => day.plannedCharges || []) || [])
    .filter(item => (item as { chargeId?: string }).chargeId === 'separate-trip-fee');
  assert.equal(separateFeeCopies.length, 1, 'a different fee ID must remain even when the fee is otherwise identical');
});

test('modified expired days copied from one scheme do not multiply a shared unbound charge', () => {
  const plans = new PlanLibraryService(() => '2026-09-21T00:30:00+08:00');
  const makeCharge = (includedSpendEventId: string) => ({
    chargeId: 'shared-scheme-ticket', quantity: 1, includedSpendEventId,
    costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 5000, upperMinor: 5000, certainty: 'known' },
    paymentStatus: 'unpaid',
  });
  const makeStop = (stopId: string) => ({ stopId, status: 'planned', startMinutes: 600, endMinutes: 660 });
  plans.loadSerialized(JSON.stringify([
    {
      id: 'source', ownerId: 'owner', kind: 'scheme', name: '多日原方案', cityCode: '330100',
      savedAt: '2026-09-01T00:00:00Z', days: [
        { dayIndex: 0, stops: [makeStop('source-first')], routeLegs: [], plannedCharges: [makeCharge('source-first-spend')] },
        { dayIndex: 1, stops: [makeStop('source-second')], routeLegs: [], plannedCharges: [makeCharge('source-second-spend')] },
      ],
    },
    {
      id: 'expanded-first', ownerId: 'owner', kind: 'plan', sourceSchemeId: 'source', sourceDayIndex: 0,
      name: '多日原方案 · 第 1 天', cityCode: '330100', localDate: '2026-09-19', savedAt: '2026-09-19T00:00:00Z',
      stops: [makeStop('edited-first')], routeLegs: [], plannedCharges: [makeCharge('edited-first-spend')],
    },
    {
      id: 'expanded-second', ownerId: 'owner', kind: 'plan', sourceSchemeId: 'source', sourceDayIndex: 1,
      name: '多日原方案 · 第 2 天', cityCode: '330100', localDate: '2026-09-20', savedAt: '2026-09-20T00:00:00Z',
      stops: [makeStop('edited-second')], routeLegs: [], plannedCharges: [makeCharge('edited-second-spend')],
    },
  ]));

  const archived = plans.list('owner').filter(plan => plan.archiveDate);
  assert.equal(archived.length, 2, 'both independently edited days should be retained');
  const copies = archived.flatMap(plan => plan.days?.flatMap(day => day.plannedCharges || []) || [])
    .filter(item => (item as { chargeId?: string }).chargeId === 'shared-scheme-ticket');
  assert.equal(copies.length, 1, 'a shared trip-level charge ID is archived only once even if copied metadata differs');
});

test('server startup persists the original expired plan in history and preserves the reusable scheme', async () => {
  const store = new MemoryStateStore();
  let now = '2026-09-19T09:00:00+08:00';
  const beforeExpiry = createServerContext({ now: () => now });
  const { principal } = beforeExpiry.service.createAnonymousSession();
  const createdTrip = beforeExpiry.service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-19', dataMode: 'demo',
  });
  assert.ok(createdTrip.ok); if (!createdTrip.ok) return;
  const patched = beforeExpiry.service.patchTrip(principal.principalId, createdTrip.value.trip.tripId, {
    expectedRevision: createdTrip.value.trip.revision,
    stops: [{
      stopId: 'pending', placeId: 'p1',
      place: { placeId: 'p1', name: '尚未执行', coordinates: null, facilityCodes: [] },
      startMinutes: 600, endMinutes: 660, status: 'planned', date: '2026-09-19',
    }],
  });
  assert.ok(patched.ok);
  store.set('bantu-trip-service', beforeExpiry.service.serialize());
  store.set('bantu-trip-service:plan-library', JSON.stringify([
    { id: 'expired', ownerId: 'owner', kind: 'plan', name: '过期日计划', localDate: '2026-09-19', savedAt: '2026-09-19T00:00:00Z' },
    { id: 'scheme', ownerId: 'owner', kind: 'scheme', name: '可复用方案', localDate: '2020-01-01', days: [{ dayIndex: 0, stops: [], routeLegs: [] }], savedAt: '2020-01-01T00:00:00Z' },
  ]));
  now = '2026-09-20T00:30:00+08:00';
  const server = createHttpServer({
    seedDemo: false,
    now: () => now,
    stateStore: store,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const saved = JSON.parse(store.get('bantu-trip-service:plan-library') || '[]');
    assert.equal(saved.find((plan: any) => plan.id === 'expired')?.historyArchivedAt, now, '原日计划转入历史，不能删除');
    assert.ok(saved.some((plan: any) => plan.id === 'scheme'));
    const archive = saved.find((plan: any) => plan.kind === 'scheme' && plan.name.includes('未完成计划'));
    assert.ok(archive, '过期未执行站点应在启动清理时归档为静态方案');
    assert.deepEqual(archive.days[0].stops.map((stop: any) => stop.stopId), ['pending']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('plan library works without a trip: create, list, dedupe, ownership and delete', async () => {
  let clockTick=0;
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now:()=> new Date(Date.parse('2026-10-01T01:00:00Z')+clockTick++*1000).toISOString() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const guest = async () => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  try {
    const owner = await guest(); const stranger = await guest();
    const call = async (path: string, cookie: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, ...(await response.json() as any) };
    };

    // 不创建任何旅行，直接保存方案。没有目录城市或明确城市时应标记为未知。
    const created = await call('/api/v1/plans', owner, 'POST', {
      name: '西湖轻松版',
      snapshot: { stops: [{ stopId: 's1', placeId: 'p1', place: { placeId: 'p1', name: '湖边休息点' }, startMinutes: 540, endMinutes: 600, status: 'planned' }], routeLegs: [] },
    });
    assert.equal(created.status, 200);
    assert.ok(created.data.id);
    assert.equal(created.data.localDate, undefined, '日期待定的方案不应被强制要求日期');
    assert.equal(created.data.cityCode, '000000');

    // 带日期的方案。
    const dated = await call('/api/v1/plans', owner, 'POST', {
      name: '博物馆雨天版', localDate: '2026-10-01',
      snapshot: { stops: [], routeLegs: [] },
    });
    assert.equal(dated.status, 200);
    assert.equal(dated.data.localDate, '2026-10-01');

    const duplicateDate = await call('/api/v1/plans', owner, 'POST', {
      name: '同一天的另一份计划', localDate: '2026-10-01', snapshot: { stops: [], routeLegs: [] },
    });
    assert.equal(duplicateDate.status, 409, '同一账号同一天只能保存一份日计划');
    assert.equal(duplicateDate.error.code, 'DATED_PLAN_CONFLICT');
    assert.match(duplicateDate.error.message, /2026-10-01.*博物馆雨天版/);
    const moveIntoOccupiedDate = await call(`/api/v1/plans/${created.data.id}`, owner, 'PUT', {
      name: '原待定计划', localDate: '2026-10-01', snapshot: { stops: [], routeLegs: [] },
    });
    assert.equal(moveIntoOccupiedDate.status, 409, '编辑日期也不能制造同日重复计划');
    const stillUndated = (await call('/api/v1/plans', owner)).data.find((plan: any) => plan.id === created.data.id);
    assert.equal(stillUndated.localDate, undefined, '冲突更新不会改动原计划');
    const otherOwnerSameDate = await call('/api/v1/plans', stranger, 'POST', {
      name: '另一位旅人的计划', localDate: '2026-10-01', snapshot: { stops: [], routeLegs: [] },
    });
    assert.equal(otherOwnerSameDate.status, 200, '日期唯一性按账号隔离');
    await call(`/api/v1/plans/${otherOwnerSameDate.data.id}`, stranger, 'DELETE');

    // 列表按保存时间倒序，且只包含本人方案。
    const list = await call('/api/v1/plans', owner);
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 2);
    assert.equal(list.data[0].name, '博物馆雨天版');

    // 同名去重。
    const dup = await call('/api/v1/plans', owner, 'POST', { name: '西湖轻松版', snapshot: { stops: [] } });
    assert.equal(dup.status, 400);

    // 身份隔离：他人看不到，也删不掉。
    assert.equal((await call('/api/v1/plans', stranger)).data.length, 0);
    const foreignDelete = await call(`/api/v1/plans/${created.data.id}`, stranger, 'DELETE');
    assert.equal(foreignDelete.status, 400);

    // 缺少内容时报错而不是写坏数据。
    const bad = await call('/api/v1/plans', owner, 'POST', { name: '空方案' });
    assert.equal(bad.status, 400);
    // 原地编辑：改名与改内容保持同一个 id；他人不可编辑。
    const renamed = await call(`/api/v1/plans/${created.data.id}`, owner, 'PUT', { name: '西湖轻松版 B', snapshot: { stops: [{ stopId: 's9', placeId: 'p9' }], routeLegs: [] } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.name, '西湖轻松版 B');
    assert.equal(renamed.data.id, created.data.id);
    const foreignPut = await call(`/api/v1/plans/${created.data.id}`, stranger, 'PUT', { name: '抢方案' });
    assert.equal(foreignPut.status, 400);

    // 多天方案：两天集合 + 按起始日期自动展开为带日期的计划。
    const scheme = await call('/api/v1/plans', owner, 'POST', {
      kind: 'scheme', name: '杭州两日',
      days: [
        { dayIndex: 0, stops: [{ stopId: 'd1s1', placeId: 'p1', place: { placeId: 'p1', name: '湖边休息点' } }] },
        { dayIndex: 1, stops: [{ stopId: 'd2s1', placeId: 'p2', place: { placeId: 'p2', name: '城市博物馆' } }] },
      ],
    });
    assert.equal(scheme.status, 200);
    assert.equal(scheme.data.kind, 'scheme');
    assert.equal(scheme.data.days.length, 2);
    const noDays = await call('/api/v1/plans', owner, 'POST', { kind: 'scheme', name: '空的多天方案', days: [] });
    assert.equal(noDays.status, 400);

    // 原地编辑多天方案：改天数保持同一个 id。
    const schemeUpd = await call(`/api/v1/plans/${scheme.data.id}`, owner, 'PUT', { name: '杭州两日', days: [{ dayIndex: 0, stops: [{ stopId: 'only', placeId: 'p1' }] }] });
    assert.equal(schemeUpd.status, 200);
    assert.equal(schemeUpd.data.days.length, 1);

    // 方案的起始日期可选：带日期创建后可按该日期载入；日期待定的方案不能载入。
    const datedScheme = await call('/api/v1/plans', owner, 'POST', {
      kind: 'scheme', name: '带日期的两日', localDate: '2026-11-11',
      days: [{ dayIndex: 0, stops: [{ stopId: 'a', placeId: 'pa' }] }, { dayIndex: 1, stops: [{ stopId: 'b', placeId: 'pb' }] }],
    });
    assert.equal(datedScheme.status, 200);
    assert.equal(datedScheme.data.localDate, '2026-11-11');
    const undatedScheme = await call('/api/v1/plans', owner, 'POST', {
      kind: 'scheme', name: '待定的两日',
      days: [{ dayIndex: 0, stops: [{ stopId: 'c', placeId: 'pc' }] }],
    });
    assert.equal(undatedScheme.status, 200);
    assert.equal(undatedScheme.data.localDate, undefined);
    const loadUndated = await call(`/api/v1/plans/${undatedScheme.data.id}/load`, owner, 'POST', { startDate: '' });
    assert.equal(loadUndated.status, 400, '日期待定的方案不能载入');
    const loadDated = await call(`/api/v1/plans/${datedScheme.data.id}/load`, owner, 'POST', { startDate: '2026-11-11' });
    assert.equal(loadDated.status, 200);
    assert.equal(loadDated.data.plans.length, 2);
    assert.equal(loadDated.data.plans[0].localDate, '2026-11-11');
    assert.equal(loadDated.data.plans[1].localDate, '2026-11-12');

    // 10月1日已被「博物馆雨天版」占用：改用不冲突的 10月5日 起始。
    // schemeUpd 已把方案改成 1 天：载入只生成这一天一份计划。
    const loaded = await call(`/api/v1/plans/${scheme.data.id}/load`, owner, 'POST', { startDate: '2026-10-05' });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.data.plans.length, 1);
    assert.equal(loaded.data.plans[0].localDate, '2026-10-05');
    assert.match(loaded.data.plans[0].name as string, /第 1 天/);
    const listAfterLoad = (await call('/api/v1/plans', owner)).data;
    assert.ok(listAfterLoad.some((p: any) => p.id === scheme.data.id && p.kind === 'scheme'), '载入后方案本体保留在库中');
    // 重复载入同一方案：幂等更新自己的展开，不产生重复计划。
    const reloaded = await call(`/api/v1/plans/${scheme.data.id}/load`, owner, 'POST', { startDate: '2026-10-05' });
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.data.plans.length, 1);
    const afterReload = (await call('/api/v1/plans', owner)).data;
    assert.equal(afterReload.filter((p: any) => p.kind === 'plan' && p.sourceSchemeId === scheme.data.id && p.localDate === '2026-10-05').length, 1, '重复载入不产生重复计划');
    const badLoad = await call(`/api/v1/plans/${scheme.data.id}/load`, owner, 'POST', { startDate: 'not-a-date' });
    assert.equal(badLoad.status, 400);


    // 删除后列表减少，且只影响本人。
    const removed = await call(`/api/v1/plans/${created.data.id}`, owner, 'DELETE');
    assert.equal(removed.status, 200);
    const rest = (await call('/api/v1/plans', owner)).data;
    // 载入过的方案本体保留在库中；删除的只是用户手动删除的那一份。
    assert.equal(rest.length, 7, '删除后其余方案、载入计划与方案本体仍在库中');

    // 载入冲突：目标日期已有计划时返回冲突清单，replace=true 执行替换。
    await call('/api/v1/plans', owner, 'POST', { name: '已有计划', localDate: '2026-12-25', snapshot: { stops: [{ stopId: 'old', placeId: 'p_old' }], routeLegs: [] } });
    const conflictScheme = await call('/api/v1/plans', owner, 'POST', {
      kind: 'scheme', name: '圣诞冲突方案', localDate: '2026-12-25',
      days: [{ dayIndex: 0, stops: [{ stopId: 'x', placeId: 'px' }] }],
    });
    assert.equal(conflictScheme.status, 200);
    const conflict = await call(`/api/v1/plans/${conflictScheme.data.id}/load`, owner, 'POST', { startDate: '2026-12-25' });
    assert.equal(conflict.status, 200);
    assert.equal(conflict.data.conflict, true);
    assert.deepEqual(conflict.data.dates, ['2026-12-25']);
    const replaced = await call(`/api/v1/plans/${conflictScheme.data.id}/load`, owner, 'POST', {
      startDate: '2026-12-25', replace: true, confirmationToken: conflict.data.confirmationToken,
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.data.plans.length, 1);
    assert.equal(replaced.data.plans[0].localDate, '2026-12-25');
    const afterReplace = (await call('/api/v1/plans', owner)).data;
    assert.ok(!afterReplace.some((p: any) => p.name === '已有计划'), '被替换的旧计划应已删除');
    assert.ok(afterReplace.some((p: any) => p.name === '圣诞冲突方案 · 第 1 天'), '替换后的新计划应在库中');
    assert.equal((await call('/api/v1/plans', stranger)).data.length, 0);
  } finally {
    server.close();
  }
});

test('出发进度按选择的交通方式估算路线耗时；没有实际路线时保持未知', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-23T12:30:00+08:00', stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, {
        method, headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, ...(await response.json() as any) };
    };
    const created = await call('/api/v1/plans', 'POST', {
      name: 'ETA 日计划', localDate: '2026-09-23', timezone: 'Asia/Shanghai', cityCode: '310104',
      snapshot: { stops: [
        { stopId: 'a', placeId: 'p1', place: { placeId: 'p1', name: '起点', coordinates: { lat: 31.2, lng: 121.4 } }, startMinutes: 540, endMinutes: 600, plannedDurationMinutes: 60, status: 'planned' },
        { stopId: 'b', placeId: 'p2', place: { placeId: 'p2', name: '终点', coordinates: { lat: 31.21, lng: 121.41 } }, startMinutes: 660, endMinutes: 720, plannedDurationMinutes: 60, status: 'planned' },
        { stopId: 'x', placeId: 'p9', place: { placeId: 'p9', name: '未知地点' }, startMinutes: 780, endMinutes: 840, plannedDurationMinutes: 60, status: 'planned' },
      ], routeLegs: [] },
    });
    assert.equal(created.status, 200);
    const planId = encodeURIComponent(created.data.id);
    const exec = (body: Record<string, unknown>) => call(`/api/v1/plans/${planId}/execution-events`, 'POST', body);
    let revision = created.data.revision || 0;
    for (const [type, occurredAt] of [['depart', '2026-09-23T09:00:00+08:00'], ['arrive', '2026-09-23T09:30:00+08:00'], ['complete', '2026-09-23T10:30:00+08:00']] as const) {
      const updated = await exec({ stopId: 'a', type, occurredAt, expectedRevision: revision });
      assert.equal(updated.status, 200);
      revision = updated.data.revision;
    }
    // 带出发定位与交通方式：按演示路线估算（约 1.5 公里驾车），不是 30 分钟保底。
    const departed = await exec({ stopId: 'b', type: 'depart', occurredAt: '2026-09-23T12:00:00+08:00', expectedRevision: revision, origin: { lat: 31.2, lng: 121.4 }, transportMode: 'driving' });
    assert.equal(departed.status, 200);
    revision = departed.data.revision;
    let stopB = (departed.data.stops as any[]).find(s => s.stopId === 'b');
    assert.equal(stopB.status, 'en_route');
    assert.equal(stopB.estimatedTransportMode, 'driving');
    assert.ok(stopB.estimatedTravelMinutes >= 1 && stopB.estimatedTravelMinutes < 30, `驾车短途应小于保底值，实际 ${stopB.estimatedTravelMinutes}`);
    // 中止后估算作废。
    const aborted = await exec({ stopId: 'b', type: 'abort', occurredAt: '2026-09-23T12:05:00+08:00', expectedRevision: revision });
    assert.equal(aborted.status, 200);
    revision = aborted.data.revision;
    stopB = (aborted.data.stops as any[]).find(s => s.stopId === 'b');
    assert.equal(stopB.estimatedTravelMinutes, undefined);
    // 不带定位再出发：退回最近已游览站点（a）的坐标，按默认步行估算。
    const again = await exec({ stopId: 'b', type: 'depart', occurredAt: '2026-09-23T12:10:00+08:00', expectedRevision: revision });
    assert.equal(again.status, 200);
    revision = again.data.revision;
    stopB = (again.data.stops as any[]).find(s => s.stopId === 'b');
    assert.equal(stopB.estimatedTransportMode, 'walking');
    assert.ok(stopB.estimatedTravelMinutes >= 15 && stopB.estimatedTravelMinutes < 30, `步行约 1.5 公里应低于保底值，实际 ${stopB.estimatedTravelMinutes}`);

    // 终点没有坐标时保留交通方式，但不能用一个固定分钟数假装路线估算成功。
    const abortedAgain = await exec({ stopId: 'b', type: 'abort', occurredAt: '2026-09-23T12:15:00+08:00', expectedRevision: revision });
    assert.equal(abortedAgain.status, 200);
    revision = abortedAgain.data.revision;
    const bareDeparted = await exec({ stopId: 'x', type: 'depart', occurredAt: '2026-09-23T12:20:00+08:00', expectedRevision: revision });
    assert.equal(bareDeparted.status, 200);
    const stopX = (bareDeparted.data.stops as any[]).find(s => s.stopId === 'x');
    assert.equal(stopX.estimatedTravelMinutes, undefined);
    assert.equal(stopX.estimatedTransportMode, 'walking');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('路线服务失败时不把固定 30 分钟保存成预计到达时间', async () => {
  const now = '2026-09-23T12:30:00+08:00';
  const server = createHttpServer({ seedDemo: false, now: () => now, stateStore: new MemoryStateStore(), routeProvider: {
    providerName: 'failed_route_test', supportedModes: ['walking', 'driving'],
    async plan(input) {
      return { departureSupport: 'current_only', leg: { legId: 'failed', fromStopId: '', toStopId: '', transportMode: input.transportMode, durationMinutes: 0 }, error: { code: 'UNAVAILABLE', message: '路线服务不可用' } };
    },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, ...(await response.json() as any) };
    };
    const created = await call('/api/v1/plans', 'POST', { name: '路线失败计划', localDate: '2026-09-23', timezone: 'Asia/Shanghai', cityCode: '310104', snapshot: {
      stops: [{ stopId: 'destination', placeId: 'p2', place: { placeId: 'p2', name: '终点', coordinates: { lat: 31.21, lng: 121.41 } }, startMinutes: 660, endMinutes: 720, status: 'planned' }], routeLegs: [],
    } });
    assert.equal(created.status, 200);
    const departed = await call(`/api/v1/plans/${encodeURIComponent(created.data.id)}/execution-events`, 'POST', {
      stopId: 'destination', type: 'depart', expectedRevision: created.data.revision || 0,
      origin: { lat: 31.2, lng: 121.4 }, transportMode: 'driving',
    });
    assert.equal(departed.status, 200);
    assert.equal(departed.data.stops[0].estimatedTransportMode, 'driving');
    assert.equal(departed.data.stops[0].estimatedTravelMinutes, undefined, '路线失败时不展示虚构的 ETA');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('T8: 编辑当天日计划不能把站点改到当前时刻之前，未改动的过期站点不阻塞其它编辑', () => {
  const plans = new PlanLibraryService(() => '2026-09-20T10:00:00+08:00');
  const stop = (stopId: string, startMinutes: number, endMinutes: number) => ({
    stopId, placeId: `place-${stopId}`, place: { placeId: `place-${stopId}`, name: stopId }, startMinutes, endMinutes,
  });
  const saved = plans.save('owner', {
    name: 'T8 当天计划', kind: 'plan', localDate: '2026-09-20', timezone: 'Asia/Shanghai',
    snapshot: { stops: [stop('morning', 480, 540), stop('noon', 660, 720)], routeLegs: [], plannedCharges: [] },
  });

  // 把尚未开始的 noon 改到 09:20（早于当前 10:00）应被拒绝。
  assert.throws(() => plans.update('owner', saved.id, {
    name: saved.name,
    snapshot: { stops: [stop('morning', 480, 540), stop('noon', 560, 620)], routeLegs: [], plannedCharges: [] },
  }), /不能早于当前时间/);
  assert.equal((plans.get('owner', saved.id).stops as any[]).find(s => s.stopId === 'noon').startMinutes, 660, '被拒绝的编辑不落库');

  // morning（08:00）已过期但未被改动，编辑 noon 到未来时刻仍应成功。
  const moved = plans.update('owner', saved.id, {
    name: saved.name,
    snapshot: { stops: [stop('morning', 480, 540), stop('noon', 620, 680)], routeLegs: [], plannedCharges: [] },
  });
  assert.equal((moved.stops as any[]).find(s => s.stopId === 'noon').startMinutes, 620);

  // 未来日期的计划不受当前时刻限制。
  const future = plans.save('owner', {
    name: 'T8 明日计划', kind: 'plan', localDate: '2026-09-21', timezone: 'Asia/Shanghai',
    snapshot: { stops: [stop('early', 300, 360)], routeLegs: [], plannedCharges: [] },
  });
  const futureMoved = plans.update('owner', future.id, {
    name: future.name,
    snapshot: { stops: [stop('early', 240, 300)], routeLegs: [], plannedCharges: [] },
  });
  assert.equal((futureMoved.stops as any[]).find(s => s.stopId === 'early').startMinutes, 240);
});
