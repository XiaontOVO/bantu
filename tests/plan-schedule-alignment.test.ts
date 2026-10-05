import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';
import { DEMO_SHANGHAI_PLACES } from '../src/demo/demo-data.js';

const load = async (relativePath: string) => { const { join } = await import('node:path'); const { pathToFileURL } = await import('node:url'); return import(pathToFileURL(join(process.cwd(), relativePath)).href); };

// docs/计划与进度三态转换逻辑.md 的调度对齐测试：
// T3/T4 出发顺延、T6 乱序消解、T7 跨天归日。
const now = () => '2026-09-23T12:00:00+08:00';
function setup() {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: '调度对齐', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: ['a', 'b', 'c'].map((stopId, i) => ({ stopId, startMinutes: 540 + i * 80, endMinutes: 600 + i * 80, plannedDurationMinutes: 60, status: 'planned' })), routeLegs: [], plannedCharges: [],
  } });
  const record = (stopId: string, type: 'depart' | 'arrive' | 'complete' | 'skip', clock: string) => service.recordExecution('owner', plan.id, { stopId, type, occurredAt: `2026-09-23T${clock}:00+08:00` });
  return { service, plan, record };
}

test('T3: 提前出发只记录实际出发时刻，后续站点不动', () => {
  const { record } = setup();
  const departed = record('a', 'depart', '08:50');
  const stops = departed.stops as any[];
  assert.equal(stops.find(s => s.stopId === 'a').travelStartMinutes, 530);
  assert.equal(stops.find(s => s.stopId === 'b').startMinutes, 620);
  assert.equal(stops.find(s => s.stopId === 'c').startMinutes, 700);
});

test('T4: 延后出发把后续计划站点整体顺延相同的量', () => {
  const { record } = setup();
  // 没有路线时以计划开始 09:00 为最晚出发基准；10:10 出发 → b/c 各 +70。
  const departed = record('a', 'depart', '10:10');
  const stops = departed.stops as any[];
  assert.equal(stops.find(s => s.stopId === 'a').travelStartMinutes, 610);
  assert.equal(stops.find(s => s.stopId === 'b').startMinutes, 690);
  assert.equal(stops.find(s => s.stopId === 'c').startMinutes, 770);
  assert.equal(stops.find(s => s.stopId === 'b').endMinutes - stops.find(s => s.stopId === 'b').startMinutes, 60);
});

test('T6: 不按顺序先去 c，队列自动重排且不再报时间重叠', () => {
  const { record } = setup();
  // 直接到达 c（计划 11:40 开始），a/b 仍是计划；到达时刻落在 c 的计划区间内。
  const arrived = record('c', 'arrive', '11:50');
  const stops = arrived.stops as any[];
  assert.equal(stops.find(s => s.stopId === 'c').status, 'visiting');
  assert.equal(stops.find(s => s.stopId === 'c').startMinutes, 710);
  // c 实际占用 11:50–12:50；按执行顺序重排后，未触发的 a/b 排在后面并消解重叠。
  // （计划的展示队列按开始时间排序，重排结果以时间序呈现。）
  const queue = [...stops].sort((l, r) => l.startMinutes - r.startMinutes).map(s => s.stopId as string);
  assert.deepEqual(queue, ['c', 'a', 'b']);
  for (const stopId of ['a', 'b']) {
    assert.equal(stops.find(s => s.stopId === stopId).endMinutes - stops.find(s => s.stopId === stopId).startMinutes, 60, '时长守恒');
  }
  for (let i = 1; i < queue.length; i += 1) {
    const prev = stops.find(s => s.stopId === queue[i - 1]);
    const cur = stops.find(s => s.stopId === queue[i]);
    assert.ok(cur.startMinutes >= prev.endMinutes, '区间递增且不重叠');
  }
});

test('T7/边界: 起始仍在当天的跨午夜站点不迁移，结束落在次日按跨日延续执行', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: '深夜行程', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: [
      { stopId: 'late-a', startMinutes: 1380, endMinutes: 1430, departureMinutes: 1430, plannedDurationMinutes: 50, status: 'planned' },
      { stopId: 'cross-b', startMinutes: 1430, endMinutes: 1490, departureMinutes: 1490, plannedDurationMinutes: 60, status: 'planned' },
    ], routeLegs: [], plannedCharges: [],
  } });
  const record = (stopId: string, type: 'arrive' | 'complete', occurredAt: string) => service.recordExecution('owner', plan.id, { stopId, type, occurredAt });
  record('late-a', 'arrive', '2026-09-23T23:05:00+08:00');
  record('late-a', 'complete', '2026-09-23T23:50:00+08:00');
  // cross-b 顺延后的计划起始 23:55 仍在当天（结束 00:55 落在次日）：不迁移，跨日延续执行。
  const migrated = record('cross-b', 'arrive', '2026-09-24T00:30:00+08:00');
  assert.equal(migrated.migratedNextDayStops, 0);
  const todayStops = migrated.stops as any[];
  assert.equal(todayStops.find(s => s.stopId === 'cross-b').status, 'visiting');
  assert.equal((service.list('owner').find(item => item.id === plan.id)!.stops as any[]).length, 2);
});

// ---- 覆盖缺口补充（2026-09-24）：逐条对应文档 §1–§7 ----
import { applyExecutionEvent } from '../src/domain/execution.js';
import type { TripSnapshot } from '../src/domain/types.js';

test('T5/T6: 跳过的站点不占时间，级联越过它继续顺延后面的站点', () => {
  const { record } = setup();
  record('b', 'skip', '08:50');
  const departed = record('a', 'depart', '10:10');
  const stops = departed.stops as any[];
  assert.equal(stops.find(s => s.stopId === 'b').status, 'skipped');
  assert.equal(stops.find(s => s.stopId === 'c').startMinutes, 770, 'c 越过跳过的 b 继续顺延 70 分钟');
});

test('Q4: 锁定的站点不顺延，也不中断其后站点的顺延', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: '锁定站', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: [
      { stopId: 'a', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 60, status: 'planned' },
      { stopId: 'fixed', startMinutes: 620, endMinutes: 680, departureMinutes: 680, plannedDurationMinutes: 60, status: 'planned', lockTime: true },
      { stopId: 'c', startMinutes: 700, endMinutes: 760, departureMinutes: 760, plannedDurationMinutes: 60, status: 'planned' },
    ], routeLegs: [], plannedCharges: [],
  } });
  const arrived = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'arrive', occurredAt: '2026-09-23T09:10:00+08:00' });
  const stops = arrived.stops as any[];
  assert.equal(stops.find(s => s.stopId === 'fixed').startMinutes, 620, '锁定站不移动');
  assert.equal(stops.find(s => s.stopId === 'c').startMinutes, 710, '锁定站之后的站点继续顺延');
});

test('T6/needs_review: 与事实站点无法消解的重叠标记 needs_review 而不是拒绝', () => {
  const snapshot = {
    schemaVersion: 1, tripId: 't', lifecycle: 'active', planningStatus: 'validated',
    timezone: 'Asia/Shanghai', travelDate: '2026-09-23', localDate: '2026-09-23',
    tripSettings: { localDate: '2026-09-23', timezone: 'Asia/Shanghai' },
    stops: [
      { stopId: 'a', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 60, status: 'planned' },
      { stopId: 'fixed', startMinutes: 560, endMinutes: 620, departureMinutes: 620, plannedDurationMinutes: 60, status: 'planned', lockTime: true },
      { stopId: 'c', startMinutes: 700, endMinutes: 760, departureMinutes: 760, plannedDurationMinutes: 60, status: 'planned' },
    ],
    routeLegs: [], plannedCharges: [], executionEvents: [], version: 0,
  } as unknown as TripSnapshot;
  // a 到达 11:00（窗口 660–720），压过锁定的 fixed（560–620）：事件成功、计划标 needs_review。
  const result = applyExecutionEvent(snapshot, { stopId: 'a', type: 'arrive', occurredAt: '2026-09-23T11:00:00+08:00' });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot?.planningStatus, 'needs_review');
  assert.equal(result.snapshot?.stops?.find(s => s.stopId === 'fixed')!.startMinutes, 560, '锁定站不被移动');
  assert.equal(result.snapshot?.stops?.find(s => s.stopId === 'c')!.startMinutes, 820, '后面的站点仍顺延');
});

test('纠正为更早的完成时刻：后续站点不被提前（只延后不提前）', () => {
  const { service, plan, record } = setup();
  record('a', 'arrive', '09:00');
  const completed = record('a', 'complete', '10:20');
  assert.equal((completed.stops as any[]).find(s => s.stopId === 'b').startMinutes, 640);
  const event = completed.executionEvents!.find(e => e.type === 'complete')!;
  const corrected = service.correctExecution('owner', plan.id, { eventId: event.executionEventId, type: 'complete', status: 'completed', occurredAt: '2026-09-23T09:50:00+08:00' });
  assert.equal((corrected.stops as any[]).find(s => s.stopId === 'b').startMinutes, 640, '负向纠正差不平移');
  assert.equal((corrected.stops as any[]).find(s => s.stopId === 'c').startMinutes, 720);
});

test('P2: 前往中的站点未完成前不能出发下一站（服务层）', () => {
  const { record } = setup();
  record('a', 'depart', '09:00');
  assert.throws(() => record('b', 'depart', '09:30'), /在进行中/);
});

test('T7: 级联把未开始站点的起始推过午夜时迁入次日计划；进行中的站点钉在当天', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: '深夜行程', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: [
      { stopId: 'night-a', startMinutes: 1380, endMinutes: 1430, departureMinutes: 1430, plannedDurationMinutes: 50, status: 'planned' },
      { stopId: 'cross-b', startMinutes: 1430, endMinutes: 1490, departureMinutes: 1490, plannedDurationMinutes: 60, status: 'planned' },
    ], routeLegs: [], plannedCharges: [],
  } });
  // a 在 23:50 到达（计划窗口 23:00–23:50），离开时刻顺延 b 的计划起始 +60：
  // cross-b 尚未开始、起始时间落到次日 00:50 → 迁入次日的计划；a 进行中，钉在当天。
  const arrived = service.recordExecution('owner', plan.id, { stopId: 'night-a', type: 'arrive', occurredAt: '2026-09-23T23:50:00+08:00' });
  assert.equal(arrived.migratedNextDayStops, 1);
  const todayStops = arrived.stops as any[];
  assert.ok(todayStops.some(s => s.stopId === 'night-a' && s.status === 'visiting'), '进行中的站点钉在当天');
  assert.equal(todayStops.some(s => s.stopId === 'cross-b'), false, '起始被推过午夜的未开始站点迁出当天');
  const nextDay = service.list('owner').find(item => item.kind === 'plan' && item.localDate === '2026-09-24');
  assert.ok(nextDay, '次日没有计划时自动创建');
  assert.equal((nextDay!.stops as any[]).find(s => s.stopId === 'cross-b')!.startMinutes, 40, '分钟数归一化到次日 00:40');
  const nextEvents = (nextDay!.executionEvents || []) as any[];
  assert.equal(nextEvents.length, 0, '尚未执行的站点没有事实需要迁移');
  // a 的完成发生在次日凌晨：站点已完成并钉在当天（跨午夜计划保持可执行）。
  const done = service.recordExecution('owner', plan.id, { stopId: 'night-a', type: 'complete', occurredAt: '2026-09-24T00:40:00+08:00' });
  assert.equal((done.stops as any[]).find(s => s.stopId === 'night-a').status, 'completed');
  assert.equal((service.list('owner').find(item => item.id === plan.id)!.stops as any[]).length, 1, '当天计划保留已完成的站点');
});

test('T8: 跨日记录只允许落在该节点区间内的延续时间', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: '单站', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: [{ stopId: 's', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 60, status: 'planned' }], routeLegs: [], plannedCharges: [],
  } });
  assert.throws(
    () => service.recordExecution('owner', plan.id, { stopId: 's', type: 'arrive', occurredAt: '2026-09-24T03:00:00+08:00' }),
    /进度时间必须属于/,
    '超出节点跨日延续范围的次日记录被拒绝',
  );
  assert.throws(
    () => service.recordExecution('owner', plan.id, { stopId: 's', type: 'arrive', occurredAt: '2026-09-24T00:30:00+08:00' }),
    /进度时间必须属于/,
  );
});

test('R24: 游览恰满 24 小时的真实完成被记录，结束归档后不能重复补记', () => {
  let clock = '2026-09-23T09:00:00+08:00';
  const service = new PlanLibraryService(() => clock);
  const plan = service.save('owner', { name: '超时游览', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: [{ stopId: 'long', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 1440, status: 'planned' }], routeLegs: [], plannedCharges: [],
  } });
  service.recordExecution('owner', plan.id, { stopId: 'long', type: 'arrive', occurredAt: '2026-09-23T09:00:00+08:00' });
  // 游览窗口跨日延续到次日 09:00（计划时长 24h）：此刻补记完成合法，且时长恰好封顶 24h。
  clock = '2026-09-24T09:00:00+08:00';
  const completed = service.recordExecution('owner', plan.id, { stopId: 'long', type: 'complete', occurredAt: '2026-09-24T09:00:00+08:00' });
  const stop = (completed.stops as any[]).find(s => s.stopId === 'long');
  assert.equal(stop.status, 'completed');
  assert.equal(stop.endMinutes, 540 + 1440, '真实结束恰好在 24 小时处');
  // 已结束的过期计划归档后，重复完成仍被拒绝；未结束访问允许超时继续记录。
  clock = '2026-09-24T15:00:00+08:00';
  assert.throws(
    () => service.recordExecution('owner', plan.id, { stopId: 'long', type: 'complete', occurredAt: '2026-09-24T15:00:00+08:00' }),
    /找不到这个方案|进度时间必须属于/,
  );
});

test('R24: 实际完成超过 24h 时保留真实完成时刻（域层）', () => {
  const snapshot = {
    schemaVersion: 1, tripId: 't', lifecycle: 'active', planningStatus: 'validated',
    timezone: 'Asia/Shanghai', travelDate: '2026-09-23', localDate: '2026-09-23',
    tripSettings: { localDate: '2026-09-23', timezone: 'Asia/Shanghai' },
    stops: [{ stopId: 'a', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 60, status: 'planned' }],
    routeLegs: [], plannedCharges: [], executionEvents: [], version: 0,
  } as unknown as TripSnapshot;
  const arrived = applyExecutionEvent(snapshot, { stopId: 'a', type: 'arrive', occurredAt: '2026-09-23T09:00:00+08:00' });
  const completed = applyExecutionEvent(arrived.snapshot!, { stopId: 'a', type: 'complete', occurredAt: '2026-09-24T15:00:00+08:00' });
  assert.equal(completed.ok, true);
  assert.equal(completed.snapshot?.stops?.[0].endMinutes, 2340, '实际完成次日 15:00，不截断真实事实');
});

test('R24: 计划游览时长超过 24h 的部分在到达时截断（域层）', () => {
  const snapshot = {
    schemaVersion: 1, tripId: 't', lifecycle: 'active', planningStatus: 'validated',
    timezone: 'Asia/Shanghai', travelDate: '2026-09-23', localDate: '2026-09-23',
    tripSettings: { localDate: '2026-09-23', timezone: 'Asia/Shanghai' },
    stops: [{ stopId: 'a', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 1500, status: 'planned' }],
    routeLegs: [], plannedCharges: [], executionEvents: [], version: 0,
  } as unknown as TripSnapshot;
  const arrived = applyExecutionEvent(snapshot, { stopId: 'a', type: 'arrive', occurredAt: '2026-09-23T09:00:00+08:00' });
  assert.equal(arrived.snapshot?.stops?.[0].endMinutes, 540 + 1440, '计划时长按 24 小时截断');
});

// ---- 端到端场景（用户视角："我不按顺序出发/延后出发/提前出发/跨一天游览，会怎样？"）----

test('场景A: 不按顺序出发（先 c 后 a）——队列重排为执行顺序，时长守恒', () => {
  const { service, plan, record } = setup();
  // 先去 c：09:30 出发、10:00 到达、10:40 完成（c 原计划 11:40 开始）
  record('c', 'depart', '09:30');
  record('c', 'arrive', '10:00');
  record('c', 'complete', '10:40');
  // 再回头去 a：11:00 出发、11:10 到达、12:10 完成
  record('a', 'depart', '11:00');
  record('a', 'arrive', '11:10');
  record('a', 'complete', '12:10');
  const view = service.get('owner', plan.id);
  const stops = (view.stops as any[]).map(s => ({ id: s.stopId, start: s.startMinutes, end: s.endMinutes, dur: s.endMinutes - s.startMinutes }));
  const queue = [...stops].sort((l, r) => l.start - r.start).map(s => s.id);
  assert.deepEqual(queue, ['c', 'a', 'b'], '队列按实际执行顺序重排：c → a → b');
  // c 的实际游览按真实到达/完成记录（10:00–10:40 = 40 分钟）；a/b 是计划站点，顺延后时长守恒。
  assert.equal(stops.find(s => s.id === 'c')!.dur, 40, 'c 实际游览 40 分钟');
  assert.equal(stops.find(s => s.id === 'a')!.dur, 60, 'a 时长守恒');
  assert.equal(stops.find(s => s.id === 'b')!.dur, 60, 'b 时长守恒');
  const sorted = [...stops].sort((l, r) => l.start - r.start);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].start >= sorted[i - 1].end, '区间递增且不重叠');
  }
  assert.equal((view.stops as any[]).find(s => s.stopId === 'b')!.status, 'planned', '未触发的 b 仍是计划');
});

test('场景B: 延后出发（10:10）再到达（10:20）——后续按文档公式顺延且不重叠', () => {
  const { service, plan, record } = setup();
  record('a', 'depart', '10:10');            // 相对计划开始晚 70 分钟 → b/c 顺延 70 分钟
  let stops = (service.get('owner', plan.id).stops as any[]);
  assert.equal(stops.find(s => s.stopId === 'b').startMinutes, 690);
  assert.equal(stops.find(s => s.stopId === 'c').startMinutes, 770);
  const arrived = record('a', 'arrive', '10:20');   // 实际开始 10:20，游览 60 分钟
  stops = arrived.stops as any[];
  const a = stops.find(s => s.stopId === 'a');
  assert.equal(a.startMinutes, 620);
  assert.equal(a.endMinutes, 680);
  assert.equal(stops.find(s => s.stopId === 'b').startMinutes, 700, '到达总延误 80 分钟，扣除出发已传播的 70 分钟');
  assert.equal(stops.find(s => s.stopId === 'c').startMinutes, 780);
  const sorted = [...stops].sort((l, r) => l.startMinutes - r.startMinutes);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].startMinutes >= sorted[i - 1].endMinutes, '区间递增且不重叠');
  }
});

test('场景C: 跨一天的游览（23:30 出发，次日 00:10 到达、00:50 完成）', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: '跨午夜夜游', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: [
      { stopId: 'n-a', startMinutes: 1380, endMinutes: 1430, departureMinutes: 1430, plannedDurationMinutes: 50, status: 'planned' },
      { stopId: 'n-b', startMinutes: 1430, endMinutes: 1490, departureMinutes: 1490, plannedDurationMinutes: 60, status: 'planned' },
    ], routeLegs: [], plannedCharges: [],
  } });
  const record = (stopId: string, type: 'depart' | 'arrive' | 'complete', occurredAt: string) => service.recordExecution('owner', plan.id, { stopId, type, occurredAt });
  const departed = record('n-a', 'depart', '2026-09-23T23:30:00+08:00'); // 晚于计划开始 30 分钟
  assert.equal(departed.migratedNextDayStops, 1, '出发时已把 n-b 起始推过午夜，迁入次日');
  const arrived = record('n-a', 'arrive', '2026-09-24T00:10:00+08:00');  // 跨午夜到达，可补记
  const aAfterArrive = (arrived.stops as any[]).find(s => s.stopId === 'n-a');
  assert.equal(aAfterArrive.status, 'visiting');
  assert.equal(aAfterArrive.startMinutes, 1450, '实际开始 00:10（次日）');
  assert.equal(arrived.migratedNextDayStops, 0, '已迁入次日的站点不会重复迁移');
  const done = record('n-a', 'complete', '2026-09-24T00:50:00+08:00');   // 游览 40 分钟后完成
  const aDone = (done.stops as any[]).find(s => s.stopId === 'n-a');
  assert.equal(aDone.status, 'completed');
  assert.equal(aDone.endMinutes, 1490, '实际结束 00:50（次日 1490 分钟）；站点钉在起始当天');
  assert.equal(service.get('owner', plan.id).executionEvents!.length, 3, '出发/到达/完成事实完整保留');
});

test('T9 边界: 前往中超过 24 小时仍可记录真实到达，不能自动结束', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: '超时到达', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: [{ stopId: 'a', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 60, status: 'planned' }], routeLegs: [], plannedCharges: [],
  } });
  service.recordExecution('owner', plan.id, { stopId: 'a', type: 'depart', occurredAt: '2026-09-23T09:00:00+08:00' });
  const arrived = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'arrive', occurredAt: '2026-09-24T09:10:00+08:00' });
  assert.equal((arrived.stops as any[])[0].startMinutes, 1990);
  assert.equal((arrived.stops as any[])[0].status, 'visiting');
});

// ---- 方案改期与执行事实的钉扎（用户场景：11-18 计划错位）----
test('方案改期: 已完成站点钉在实际日期并与方案解绑，未开始站点跟随改期', () => {
  let clock = '2026-09-23T09:00:00+08:00';
  const service = new PlanLibraryService(() => clock);
  const scheme = service.save('owner', { name: '两日方案', kind: 'scheme', cityCode: '310100', timezone: 'Asia/Shanghai', days: [
    { dayIndex: 0, stops: [
      { stopId: 'done', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 60, status: 'planned' },
      { stopId: 'todo', startMinutes: 620, endMinutes: 680, departureMinutes: 680, plannedDurationMinutes: 60, status: 'planned' },
    ], routeLegs: [] },
    { dayIndex: 1, stops: [
      { stopId: 'far', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 60, status: 'planned' },
    ], routeLegs: [] },
  ] });
  const loaded = service.loadAsPlans('owner', scheme.id, '2026-09-23');
  assert.ok(loaded.plans);
  if (!loaded.plans) return;
  const day1 = loaded.plans[0];
  service.recordExecution('owner', day1.id, { stopId: 'done', type: 'arrive', occurredAt: '2026-09-23T09:00:00+08:00' });
  service.recordExecution('owner', day1.id, { stopId: 'done', type: 'complete', occurredAt: '2026-09-23T10:00:00+08:00' });
  // 方案改期到 09-26（+3 天）：已完成的 done 钉在 09-23；未开始的 todo/far 跟随改期
  clock = '2026-09-23T18:00:00+08:00';
  service.update('owner', scheme.id, { name: '两日方案', localDate: '2026-09-26', days: scheme.days });
  const plans = service.list('owner').filter(item => item.kind === 'plan');
  const history = plans.find(item => (item.stops as any[]).some(s => s.stopId === 'done'));
  assert.ok(history, '已完成站点留在实际日期的计划里');
  assert.equal(history!.localDate, '2026-09-23');
  assert.equal(history!.sourceSchemeId, undefined, '历史副本与方案解绑');
  const events = (history!.executionEvents || []) as any[];
  assert.ok(events.some(e => e.stopId === 'done' && e.type === 'complete'), '完成事实随站点保留');
  const rescheduledTodo = plans.filter(item => item.localDate === '2026-09-26');
  assert.deepEqual(rescheduledTodo.flatMap(item => (item.stops as any[]).map(s => s.stopId)), ['todo'], '第 1 天未开始站点跟随改期');
  const rescheduledFar = plans.find(item => item.localDate === '2026-09-27');
  assert.deepEqual((rescheduledFar!.stops as any[]).map(s => s.stopId), ['far'], '第 2 天保持相对天数顺延');
});

test('方案改期: 全部已执行的副本留在实际日期，不产生未来日期的空壳', () => {
  let clock = '2026-09-23T09:00:00+08:00';
  const service = new PlanLibraryService(() => clock);
  const scheme = service.save('owner', { name: '单日方案', kind: 'scheme', cityCode: '310100', timezone: 'Asia/Shanghai', days: [
    { dayIndex: 0, stops: [
      { stopId: 'all-done', startMinutes: 540, endMinutes: 600, departureMinutes: 600, plannedDurationMinutes: 60, status: 'planned' },
    ], routeLegs: [] },
  ] });
  const loaded = service.loadAsPlans('owner', scheme.id, '2026-09-23');
  assert.ok(loaded.plans);
  if (!loaded.plans) return;
  const day1 = loaded.plans[0];
  service.recordExecution('owner', day1.id, { stopId: 'all-done', type: 'arrive', occurredAt: '2026-09-23T09:00:00+08:00' });
  service.recordExecution('owner', day1.id, { stopId: 'all-done', type: 'complete', occurredAt: '2026-09-23T10:00:00+08:00' });
  clock = '2026-09-23T18:00:00+08:00';
  service.update('owner', scheme.id, { name: '单日方案', localDate: '2026-11-18', days: scheme.days });
  const history = service.list('owner').filter(item => item.kind === 'plan' && (item.stops as any[]).some(s => s.stopId === 'all-done'));
  assert.equal(history.length, 1, '计划只有一份');
  assert.equal(history[0].localDate, '2026-09-23', '整份已执行：钉在实际日期，不搬到未来');
});

// ---- 游览地图与建筑平面图（place-tour）----
test('景点总览: 全部样例地点都有手绘场地底图，且建筑轮廓关联独立室内图入口', async () => {
  const { join } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const module = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour-data.js')).href);
  const overviewModule = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-overview-data.js')).href);
  const tourFor = module.tourFor as (place: { name?: string; category?: string }) => {
    overview: { type: string; buildings?: { id?: string; name: string; secondary?: boolean }[] };
    floorPlanSource?: { label?: string; url?: string } | null;
    floorPlanSources?: { label?: string; url?: string }[];
    buildings?: { id: string; name: string; spaceKind?: string; floors: { name: string; label?: string }[]; floorPlanImages?: { floor: string; kind?: string; src?: string; alt?: string; notice?: string; credit?: string }[] }[];
  };
  for (const place of DEMO_SHANGHAI_PLACES) {
    const tour = tourFor(place);
    assert.notEqual(tour.overview.type, 'missing', `${place.name} 应有整幅场地总览图`);
    assert.equal(Object.hasOwn(tour, 'nodes'), false, `${place.name} 不再保留旧点位图数据`);
    assert.equal(Object.hasOwn(tour, 'route'), false, `${place.name} 不再保留旧点位连线数据`);
    const mapBuildingIds = [...new Set((tour.overview.buildings || []).filter(building => !building.secondary && building.id).map(building => String(building.id)))];
    const tourBuildings = new Map((tour.buildings || []).map(building => [building.id, building]));
    for (const id of mapBuildingIds) {
      const building = tourBuildings.get(id);
      assert.ok(building, `${place.name} 的可点击建筑 ${id} 应有独立资料入口`);
      assert.ok(building && (building.floors.length > 0 || ['exterior','unknown'].includes(building.spaceKind || '')), `${place.name} 的可点击建筑 ${id} 应对应已有楼层或明确的外观／未知资料`);
      assert.ok((building?.floors || []).every(floor => floor.name.trim().length > 0), `${place.name} 的可点击建筑 ${id} 应标出楼层名称`);
    }
    for (const b of tour.buildings || []) {
      assert.ok((b.floors || []).length >= 1 || ['exterior','unknown'].includes(b.spaceKind || ''), `${place.name} 建筑保留楼层记录或明确的外观／未知资料，不补造占位楼层`);
      assert.ok((b.floors || []).every(floor => !Object.hasOwn(floor, 'schematic')), `${place.name} ${b.name} 不应再保留旧房间框示意数据`);
      for (const image of b.floorPlanImages || []) {
        assert.ok((b.floors || []).some(floor => floor.name === image.floor), `${place.name} ${b.name} ${image.floor} 平面图必须关联到已知楼层`);
        assert.match(image.src || '', /^\/images\/places\/floorplan\/[a-z0-9_-]+\.(?:svg|png|jpe?g|webp)$/i, `${place.name} ${b.name} ${image.floor} 必须使用本地平面图文件`);
        const bytes = await readFile(join(process.cwd(), 'public', String(image.src).replace(/^\//, '')));
        assert.ok(bytes.length > 0, `${place.name} ${b.name} ${image.floor} 平面图文件应存在且非空`);
        if (image.src?.toLowerCase().endsWith('.svg')) {
          const svg = bytes.toString('utf8');
          assert.ok(svg.includes('<svg') && !svg.includes('<image') && !svg.includes('href='), `${place.name} ${b.name} ${image.floor} 应是无外链图片的本地 SVG`);
        }
      }
    }
  }
  for (const name of overviewModule.SITE_MAP_NAMES) {
    const tour = tourFor({ name });
    assert.equal(Object.hasOwn(tour, 'nodes'), false, `${name} 的详情地图不再带旧点位图数据`);
    assert.equal(Object.hasOwn(tour, 'route'), false, `${name} 的详情地图不再带旧点位连线数据`);
  }
  const tourDataSource = await readFile(join(process.cwd(), 'public/lib/place-tour-data.js'), 'utf8');
  assert.doesNotMatch(tourDataSource, /^\s*(?:nodes|route|minutes)\s*:/m, '旧点位和游线数据已从景点目录中移除');
  assert.ok(DEMO_SHANGHAI_PLACES.every(place => overviewModule.SITE_MAP_NAMES.includes(place.name)), '每个样例地点都配有本地绘制的总览底图');
  const museumEast = tourFor({ name: '上海博物馆东馆', category: 'culture' });
  assert.notEqual(museumEast.overview.type, 'missing', '固定样例以外的重点场馆也应进入本地景点地图册');
  assert.deepEqual(museumEast.buildings?.[0]?.floors.map(floor => floor.name), ['B1', '1F', '2F', '3F', '4F', '5F'], '上博东馆应覆盖官方导览折页展示的地下层、展厅层和屋顶花园');
  assert.deepEqual(museumEast.buildings?.[0]?.floorPlanImages?.map(image => image.floor), ['B1', '1F', '2F', '3F', '4F', '5F'], '上博东馆六层均应接入本地可放大的平面图');
  assert.match(museumEast.floorPlanSource?.label || '', /官方导览折页（2025）.*B1.*5F.*本地重绘/, '上博东馆平面图应标注导览来源和本地重绘范围');
  const museumEastLabels: Record<string, string[]> = {
    B1: ['学术报告厅', '多功能教室', '数字影院', 'B1 东入口'],
    '1F': ['青铜馆', '第一特展厅', '雕塑馆', '北入口'],
    '2F': ['玉器馆', '玺印篆刻馆', '书法馆', '绘画馆'],
    '3F': ['陶瓷馆', '货币馆', '陶瓷专题馆', '古代文明', '探索宫'],
    '4F': ['江南造物馆', '文物保护修复', '体验馆', '考古馆', '古代文明', '探索宫'],
    '5F': ['屋顶花园', '环形屋面步道', '4F 上行连接'],
  };
  for (const image of museumEast.buildings?.[0]?.floorPlanImages || []) {
    const svg = await readFile(join(process.cwd(), 'public', String(image.src || '').replace(/^\//, '')), 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('上海博物馆东馆'), `${image.floor} 应加载上博东馆本地楼层图`);
    assert.ok(!svg.includes('<image') && !svg.includes('href='), `${image.floor} 应为本地矢量绘制，不嵌入原图或外链`);
    assert.match(image.credit || '', /官方导览折页（2025；伴途重绘）/, `${image.floor} 应标注官方导览折页和本地重绘`);
    for (const label of museumEastLabels[image.floor] || []) assert.ok(svg.includes(label), `${image.floor} 平面图应标出 ${label}`);
  }
  for (const alias of ['上博东馆', '上海博物馆(东馆)', '上海博物馆（东馆）', '上海博物馆东馆（浦东）']) {
    const aliasTour = tourFor({ name: alias, category: 'culture' });
    assert.equal(aliasTour.overview.type, 'campus', `${alias} 应匹配到上海博物馆东馆总览`);
    assert.deepEqual(aliasTour.buildings?.[0]?.floors.map(floor => floor.name), ['B1', '1F', '2F', '3F', '4F', '5F'], `${alias} 应复用同一套楼层图`);
  }
  const naturalHistory = tourFor({ name: '上海自然博物馆', category: 'culture' });
  assert.notEqual(naturalHistory.overview.type, 'missing', '样例目录之外的自然博物馆也应有本地全貌图');
  assert.equal((naturalHistory.overview.buildings?.find(building => building.id === 'main') as any)?.shape, 'geo-building', '自然博物馆总览使用真实建筑坐标轮廓');
  assert.deepEqual(naturalHistory.buildings?.[0]?.floors.map(floor => floor.name), ['L2', 'L1', 'B1', 'B2M', 'B2'], '自然博物馆楼层应与官方楼层导览一致');
  assert.deepEqual(naturalHistory.buildings?.[0]?.floorPlanImages?.map(image => image.floor), ['L2', 'L1', 'B1', 'B2M', 'B2'], '自然博物馆五层都应接入本地重绘平面图');
  assert.match(naturalHistory.floorPlanSource?.label || '', /官网楼层导览.*本地重绘/, '自然博物馆平面图应注明使用馆方楼层导览作本地重绘依据');
  for (const image of naturalHistory.buildings?.[0]?.floorPlanImages || []) {
    const svg = await readFile(join(process.cwd(), 'public', (image.src || '').replace(/^\//, '')), 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('上海自然博物馆'), `${image.floor} 应加载本地绘制的馆内平面图`);
    assert.ok(!svg.includes('href='), `${image.floor} 平面图不得包含外链`);
  }
  for (const alias of ['上海自然博物馆新馆', '上海自然博物馆（静安馆）', '上海自然博物馆(静安馆)']) {
    const aliasTour = tourFor({ name: alias, category: 'culture' });
    assert.equal(aliasTour.overview.type, 'park', `${alias} 应匹配到自然博物馆园区总览`);
    assert.deepEqual(aliasTour.buildings?.[0]?.floors.map(floor => floor.name), ['L2', 'L1', 'B1', 'B2M', 'B2'], `${alias} 应复用自然博物馆楼层图`);
  }
  const childrenMuseum = tourFor({ name: '上海儿童博物馆', category: 'culture' });
  assert.equal((childrenMuseum.overview.buildings?.find(building => building.id === 'main') as any)?.shape, 'geo-building', '儿博馆总览应按真实多翼建筑轮廓提供可点击入口');
  assert.deepEqual(childrenMuseum.buildings?.[0]?.floors.map(floor => floor.name), ['1F', '2F', '3F', 'B1'], '儿博馆楼层应与官网四张彩色平面图一致');
  assert.deepEqual((childrenMuseum.buildings?.[0] as any)?.floorPlanImages?.map((image: any) => image.floor), ['1F', '2F', '3F', 'B1'], '儿博馆每层应显示伴途本地重绘的矢量平面图');
  assert.match(childrenMuseum.floorPlanSource?.label || '', /官网.*彩色平面图/, '儿博馆应保留官方图纸重绘依据');
  for (const alias of ['儿博馆', '上海儿童博物馆（宋园路）', '上海儿童博物馆（宋庆龄陵园）', '宋庆龄儿童博物馆']) {
    const aliasTour = tourFor({ name: alias, category: 'culture' });
    assert.equal(aliasTour.overview.type, 'campus', `${alias} 应匹配儿博馆总览图`);
    assert.deepEqual(aliasTour.buildings?.[0]?.floors.map(floor => floor.name), ['1F', '2F', '3F', 'B1'], `${alias} 应复用儿博馆楼层图`);
  }
  const { readFile: readChildrenPlan } = await import('node:fs/promises');
  const placeTour = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour.js')).href);
  const childrenPlace = { placeId: 'p-children-museum', name: '上海儿童博物馆', category: 'culture' };
  const childrenOverviewHtml = placeTour.tourSectionHtml(childrenPlace);
  assert.ok(childrenOverviewHtml.includes('data-action="open-building-plan"') && childrenOverviewHtml.includes('data-building="main"'), '儿博馆真实建筑轮廓应可点击打开室内平面图');
  for (const image of (childrenMuseum.buildings?.[0] as any)?.floorPlanImages || []) {
    const svg = await readChildrenPlan(join(process.cwd(), 'public', image.src.replace(/^\//, '')), 'utf8');
    assert.match(svg, /<svg[^>]+viewBox="0 0 1200 700"/, `${image.floor} 应是可缩放的伴途自绘矢量图`);
    assert.match(svg, /依据上海儿童博物馆官网/, `${image.floor} 应在图内说明重绘依据`);
    assert.ok(!svg.includes('http://www.shetbwg.cn') && !svg.includes('https://www.shetbwg.cn'), `${image.floor} 不得嵌入官网外链`);
    placeTour.rememberBuildingFloor(childrenPlace, 'main', ['1F', '2F', '3F', 'B1'].indexOf(image.floor));
    const floorSheet = placeTour.buildingSheetHtml(childrenPlace, 'main');
    assert.ok(floorSheet.includes(image.src) && floorSheet.includes('floor-plan-image'), `${image.floor} 点击后应展示对应本地平面图`);
    assert.ok(!floorSheet.includes('href='), `${image.floor} 不得跳转外链`);
  }
  const xujiahuiPark = tourFor({ name: '徐家汇公园', category: 'park' });
  assert.match(xujiahuiPark.floorPlanSource?.label || '', /2024.*导览图.*公厕/, '徐家汇公园来源应明确图源年份和导览内容');
  const longhuaTemple = tourFor({ name: '龙华寺', category: 'culture' });
  assert.match(longhuaTemple.floorPlanSource?.label || '', /2026.*春节.*路线图.*节庆流线/, '龙华寺应将节庆路线图标为季节性参考');
  const guilinPark = tourFor({ name: '桂林公园', category: 'park' });
  assert.match(guilinPark.floorPlanSource?.url || '', /xuhui\.gov\.cn/, '桂林公园应链接到官方导览图来源');
  const xujiahuiLibrary = tourFor({ name: '徐家汇书院', category: 'culture' });
  assert.match(xujiahuiLibrary.floorPlanSource?.label || '', /Wutopia Lab 项目页.*1–3 层.*设计平面图/, '徐家汇书院应明确标出来源页含设计平面图及楼层');
  assert.deepEqual(xujiahuiLibrary.buildings?.[0]?.floorPlanImages?.map(image => image.floor), ['B1', '1F', '2F', '3F'], '徐家汇书院 B1 功能示意与建筑师公开的三层设计平面都应接入本地图片');
  assert.equal(xujiahuiLibrary.buildings?.[0]?.floorPlanImages?.[0]?.kind, 'area-diagram', '没有测绘平面的 B1 应明确标作功能示意，不计作真实楼层平面图');
  const shanghaiLibrary = tourFor({ name: '上海图书馆', category: 'culture' });
  assert.deepEqual(shanghaiLibrary.buildings?.[0]?.floors.map(floor => floor.name), ['1F', '2F', '3F'], '上海图书馆淮海路馆应与官方楼层导览一致');
  assert.deepEqual((shanghaiLibrary.buildings?.[0] as any)?.floorPlanImages?.map((image: any) => image.floor), ['1F', '2F', '3F'], '上海图书馆应使用伴途自绘的三层平面图');
  const libraryMapChecks = [
    ['shanghai-library-1f.svg', ['综合阅览室', '目录大厅', '参考图书室']],
    ['shanghai-library-2f.svg', ['报纸杂志室', '科技图书', '社科图书']],
    ['shanghai-library-3f.svg', ['中文科技期刊阅览室', '剪报服务室', '特种文献服务点']],
  ];
  for (const [file, labels] of libraryMapChecks as [string, string[]][]) {
    const svg = await readFile(join(process.cwd(), 'public/images/places/floorplan', file), 'utf8');
    const visibleText = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
      .map(match => match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, '')).join('');
    assert.ok((svg.match(/class="room /g) || []).length >= 10, `${file} 应按馆方轮廓绘制多个实际空间`);
    assert.ok(!svg.includes('<image') && !svg.includes('href='), `${file} 应由伴途本地矢量绘制，不嵌入外部图片或链接`);
    for (const label of labels) assert.ok(visibleText.includes(label), `${file} 应标注真实楼层分区 ${label}`);
  }
  const westBundMuseum = tourFor({ name: '西岸美术馆', category: 'culture' });
  assert.deepEqual(westBundMuseum.buildings?.[0]?.floors.map(floor => floor.name), ['B1', '1F', '2F'], '西岸美术馆楼层应与馆方开放参观楼层一致');
  const westBundImages = (westBundMuseum.buildings?.[0]?.floorPlanImages || []) as any[];
  assert.deepEqual(westBundImages.map(image => image.floor), ['B1', '1F', '2F'], '西岸美术馆三层均应接入伴途本地矢量平面图');
  assert.match(westBundMuseum.floorPlanSource?.label || '', /David Chipperfield Architects.*本地重绘/, '西岸美术馆楼层图应注明建筑师设计图为依据');
  const westBundPlanLabels: Record<string, string[]> = {
    B1: ['展厅 4', '盒子展厅', '多功能厅', '餐厅', '艺术品库房'],
    '1F': ['中央大厅', '咖啡', '书店', '展厅 0', '龙腾大道入口', '滨江入口'],
    '2F': ['展厅 1', '展厅 2', '展厅 3', '酒吧', '中部挑空'],
  };
  for (const image of westBundImages) {
    const svg = await readFile(join(process.cwd(), 'public', String(image.src || '').replace(/^\//, '')), 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('David Chipperfield Architects'), `${image.floor} 应是依据建筑师项目图重绘的本地矢量图`);
    assert.ok(!svg.includes('<image') && !svg.includes('href='), `${image.floor} 应由伴途本地绘制，不嵌入原图或外链`);
    assert.match(image.credit || '', /David Chipperfield Architects/, `${image.floor} 图旁应署建筑师来源`);
    for (const label of westBundPlanLabels[image.floor] || []) assert.ok(svg.includes(label), `${image.floor} 平面图应标出 ${label}`);
  }
  const longMuseum = tourFor({ name: '龙美术馆（西岸馆）', category: 'culture' });
  assert.deepEqual(longMuseum.buildings?.[0]?.floors.map(floor => floor.name), ['B1', '1F', '2F'], '龙美术馆楼层应覆盖建筑师公开的地下层、首层与二层');
  assert.deepEqual(longMuseum.buildings?.[0]?.floorPlanImages?.map(image => image.floor), ['B1', '1F', '2F'], '龙美术馆三层均应接入本地可放大的矢量平面图');
  assert.match(longMuseum.floorPlanSource?.label || '', /大舍建筑.*楼层平面.*本地重绘/, '龙美术馆楼层图应注明大舍建筑设计平面为重绘依据');
  const longMuseumLabels: Record<string, string[]> = {
    B1: ['21 · 机动车停车区', '19 · 内院', '现代艺术展厅', '古代艺术展厅', '儿童空间'],
    '1F': ['艺术设计商店', '入口大厅', '当代艺术展厅', '中庭 / 挑空', '煤斗桥'],
    '2F': ['艺术设计商店', '多功能厅', '贵宾接待', '江景餐厅', '庭院', '原煤斗桥'],
  };
  for (const image of longMuseum.buildings?.[0]?.floorPlanImages || []) {
    const svg = await readFile(join(process.cwd(), 'public', String(image.src || '').replace(/^\//, '')), 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('龙美术馆西岸馆'), `${image.floor} 应加载龙美术馆本地平面图`);
    assert.ok(!svg.includes('<image') && !svg.includes('href='), `${image.floor} 应为本地矢量绘制，不嵌入原图或外链`);
    assert.match(image.credit || '', /大舍建筑.*伴途重绘/, `${image.floor} 应标明图纸来源与本地重绘`);
    assert.ok((svg.match(/class="[^"]*\b(?:shell|gallery|gallery2|public|service|yard|food)\b[^"]*"/g) || []).length >= 12, `${image.floor} 应重绘出多个相连空间而非信息卡片`);
    const visibleLabels = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(match => match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ''));
    for (const label of longMuseumLabels[image.floor] || []) assert.ok(visibleLabels.some(text => text.includes(label.replace(/\s+/g, ''))), `${image.floor} 平面图应标出 ${label}`);
  }
  const tushanwan = tourFor({ name: '土山湾博物馆', category: 'culture' });
  assert.match(tushanwan.floorPlanSource?.label || '', /二维码/, '土山湾入口应明确是全景导览二维码');
  const policeMuseum = tourFor({ name: '上海公安博物馆', category: 'culture' });
  assert.match(policeMuseum.floorPlanSource?.label || '', /VR 导览楼层坐标/, '公安博物馆平面图应注明重绘所依据的楼层坐标');
  assert.deepEqual(policeMuseum.buildings?.[0]?.floors.map(floor => floor.name), ['1F', '2F', '3F', '4F'], '公安博物馆楼层应覆盖开放参观楼层');
  assert.deepEqual((policeMuseum.buildings?.[0] as any)?.floorPlanImages?.map((image: any) => image.floor), ['1F', '2F', '3F', '4F'], '公安博物馆四层均应使用本地自绘平面图');
  assert.ok((policeMuseum.buildings?.[0] as any)?.floorPlanImages?.every((image: any) => /\/images\/places\/floorplan\/shanghai-police-museum-[1-4]f\.svg$/.test(image.src) && /公开 VR 导览房间坐标自绘/.test(image.notice)), '公安博物馆地图应本地展示真实房间轮廓并说明依据');
  assert.match(policeMuseum.buildings?.[0]?.floors[0]?.label || '', /大厅.*主入口/);
  assert.match(policeMuseum.buildings?.[0]?.floors[3]?.label || '', /消防.*警务交流.*警用装备/);
  const guangqiPark = tourFor({ name: '光启公园', category: 'rest' });
  assert.ok(guangqiPark.buildings?.some(building => building.id === 'museum') && guangqiPark.buildings?.some(building => building.id === 'pavilion'), '光启公园保留纪念馆与六角亭的资料入口，不猜测未对应的轮廓');
  assert.ok(!guangqiPark.overview.buildings?.some(building => building.id === 'tomb') && (guangqiPark.overview as any).labels?.some((label: any) => label.text === '徐光启墓'), '墓地作为室外地标标注，不冒充可查看室内图的建筑');
  assert.match(guangqiPark.buildings?.find(building => building.id === 'museum')?.floors?.[0]?.label || '', /照壁.*厢房.*厅堂/, '纪念馆楼层保留已知功能信息，但不再把它画成未经核实的地图');
  const weatherMuseum = tourFor({ name: '上海气象博物馆（徐家汇观象台）', category: 'culture' });
  assert.match(weatherMuseum.floorPlanSource?.label || '', /二维码页/, '气象博物馆来源应说明其全景入口是二维码');
  assert.match(weatherMuseum.floorPlanSources?.[0]?.label || '', /2021.*展陈楼层介绍.*非平面图/, '气象博物馆楼层信息应注明年份且不可误认为平面图');
  assert.deepEqual(weatherMuseum.buildings?.[0]?.floors.map(floor => floor.name), ['2F', '3F'], '气象博物馆应提供已核实的二、三楼展陈信息');
  assert.match(weatherMuseum.buildings?.[0]?.floors[1]?.label || '', /2021 年资料/, '气象博物馆旧楼层信息应带资料年份');
  const filmMuseum = tourFor({ name: '上海电影博物馆', category: 'culture' });
  assert.match(filmMuseum.floorPlanSource?.label || '', /COORDINATION ASIA.*1F–4F.*本地重绘/, '电影博物馆四层图应注明建筑展陈设计团队的平面依据');
  assert.deepEqual(filmMuseum.buildings?.[0]?.floorPlanImages?.map(image => image.floor), ['1F', '2F', '3F', '4F'], '电影博物馆四层都应接入本地楼层平面图');
  const craftsMuseum = tourFor({ name: '上海工艺美术博物馆', category: 'culture' });
  assert.match(craftsMuseum.floorPlanSource?.label || '', /主楼.*平面图.*2019.*非当前导览/, '工艺美术博物馆历史平面图需标明资料年代与时效限制');
  const craftsImages = craftsMuseum.buildings?.[0]?.floorPlanImages || [];
  assert.deepEqual(craftsImages.map(image => image.floor), ['1F', '2F', '3F'], '工艺美术博物馆三层都应接入本地平面图');
  const craftsLabels: Record<string, string[]> = {
    '1F': ['紫砂', '灯彩展厅'],
    '2F': ['综合展厅', '东展厅'],
    '3F': ['顾绣', '砚刻'],
  };
  for (const image of craftsImages) {
    const svg = await readFile(join(process.cwd(), 'public', String(image.src || '').replace(/^\//, '')), 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('上海工艺美术博物馆'), `${image.floor} 应加载工艺美术博物馆本地楼层图`);
    assert.ok(!svg.includes('<image') && !svg.includes('href='), `${image.floor} 应为本地绘制，不嵌入外链或原始图片`);
    assert.match(image.credit || '', /主楼平面图.*伴途本地重绘/, `${image.floor} 应注明依据与重绘信息`);
    for (const label of craftsLabels[image.floor] || []) assert.ok(svg.includes(label), `${image.floor} 应标出 ${label}`);
  }
  const botanicalGarden = tourFor({ name: '上海植物园', category: 'rest' });
  assert.match(botanicalGarden.floorPlanSources?.[0]?.label || '', /温室.*导览图.*2022/, '上海植物园应提供温室室内导览图来源');
  const botanicalGreenhouses = botanicalGarden.buildings?.filter(building => building.id === 'greenhouse-1' || building.id === 'greenhouse-2') || [];
  assert.equal(botanicalGreenhouses.length, 2, '总览上的两座展览温室分别对应各自室内图入口');
  assert.deepEqual(botanicalGreenhouses.map(building => building.floorPlanImages?.[0]?.src), [
    '/images/places/floorplan/shanghai-botanical-greenhouse-1f.svg',
    '/images/places/floorplan/shanghai-botanical-greenhouse-2f.svg',
  ], '两座温室均接入依据馆方测绘图重绘的本地平面图');
  const photographyCenter = tourFor({ name: '上海摄影艺术中心', category: 'culture' });
  assert.match(photographyCenter.buildings?.[0]?.floors?.[0]?.label || '', /三角庭院.*入口.*交接处/, '摄影艺术中心应显示经建筑师资料核实的单层空间信息');
  assert.match(photographyCenter.floorPlanSource?.label || '', /6 个半椭圆展厅.*未公开测绘平面/, '摄影艺术中心来源应区分已公开的空间关系与未公开的测绘图');
  assert.match(photographyCenter.floorPlanSources?.[0]?.label || '', /Johnston Marklee.*六个体量.*空间关系图/, '本地重绘应依据建筑师公开的空间关系');
  assert.deepEqual(photographyCenter.buildings?.[0]?.floorPlanImages?.map(image => image.floor), ['馆内'], '摄影艺术中心单层应接入本地重绘的空间关系图');
  const starMuseum = tourFor({ name: '星美术馆', category: 'culture' });
  assert.deepEqual(starMuseum.buildings?.[0]?.floors.map(floor => floor.name), ['1F', '夹层', '屋顶'], '星美术馆楼层名称应区分首层、夹层与屋顶平台');
  const starImages = starMuseum.buildings?.[0]?.floorPlanImages || [];
  assert.deepEqual(starImages.map(image => image.floor), ['1F', '屋顶'], '星美术馆接入建筑师公开的首层与屋顶平台平面');
  assert.match(starMuseum.floorPlanSource?.label || '', /Ateliers Jean Nouvel.*首层与平台层.*设计阶段/, '星美术馆需注明建筑师图纸和设计阶段属性');
  for (const image of starImages) {
    const svg = await readFile(join(process.cwd(), 'public', String(image.src || '').replace(/^\//, '')), 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('Ateliers Jean Nouvel'), `${image.floor} 应加载本地重绘的建筑师平面图`);
    assert.ok(!svg.includes('<image') && !svg.includes('href='), `${image.floor} 不嵌入原图或外链`);
  }
  assert.equal(tourFor({ name: '徐汇艺术馆', category: 'culture' }).floorPlanSource, null, '无核实来源时不展示地图入口');
});

test('楼层图: 只显示已核实本地图，缺图楼层不渲染旧房间示意', async () => {
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const data = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour-data.js')).href);
  const renderer = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour.js')).href);
  for (const place of DEMO_SHANGHAI_PLACES) {
    const tour = data.tourFor(place);
    for (const building of tour.buildings || []) {
      for (const [index, floor] of building.floors.entries()) {
        renderer.rememberBuildingFloor(place, building.id, index);
        const sheet = renderer.buildingSheetHtml(place, building.id);
        const image = building.floorPlanImages?.find((item: any) => item.floor === floor.name);
        assert.ok(!sheet.includes('floor-plan-schematic'), `${place.name} ${building.name} ${floor.name} 不得再显示旧房间示意图`);
        assert.ok(!sheet.includes('href='), `${place.name} ${building.name} ${floor.name} 不得跳转外部网页`);
        assert.ok(image ? sheet.includes('floor-plan-image') && sheet.includes(image.src) : sheet.includes('floor-plan-unavailable'), `${place.name} ${building.name} ${floor.name} 应显示本地平面图或明确的待核实提示`);
      }
    }
  }
});

test('上海体育场: 看台图按官方入场导引本地重绘并可在馆内放大', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const data = await load('public/lib/place-tour-data.js');
  const renderer = await load('public/lib/place-tour.js');
  const stadium = data.tourFor({ name: '上海体育场', category: 'culture' });
  const building = stadium.buildings?.[0];
  const image = building?.floorPlanImages?.find((item: any) => item.floor === '观众与比赛层');
  assert.equal(image?.src, '/images/places/floorplan/shanghai-stadium-stands.svg', '上海体育场楼层应连接本地看台导引平面图');
  const svg = await readFile(join(process.cwd(), 'public', String(image?.src || '').replace(/^\//, '')), 'utf8');
  assert.ok(svg.includes('徐汇区政府 2025 年观演指南') && svg.includes('场芯 · 比赛 / 演出区'), '看台图应标明资料年份和可变活动区');
  for (const section of ['01', '08', '16', '24', '32']) assert.ok(svg.includes(`>${section}<`), `看台图应标出 ${section} 号区`);
  for (const stair of ['1 号扶梯', '4 号扶梯', '7 号扶梯']) assert.ok(svg.includes(stair), `看台图应标出${stair}`);
  assert.ok(!svg.includes('<image') && !svg.includes('href='), '看台图应为产品内重绘的本地矢量图');
  const place = { placeId: 'p-stadium', name: '上海体育场', category: 'culture' };
  const sheet = renderer.buildingSheetHtml(place, 'stadium');
  assert.ok(sheet.includes('floor-plan-image') && sheet.includes('zoom-place-image') && sheet.includes(image?.src || ''), '看台图应可在产品中打开和放大');
  assert.ok(!sheet.includes('href='), '看台图不得包含外跳链接');
});

test('上海摄影艺术中心: 单层平面图呈现六个曲面体量与三角玻璃庭院', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const data = await load('public/lib/place-tour-data.js');
  const renderer = await load('public/lib/place-tour.js');
  const place = { placeId: 'p-scop', name: '上海摄影艺术中心', category: 'culture' };
  const tour = data.tourFor(place);
  const image = tour.buildings?.[0]?.floorPlanImages?.find((item: any) => item.floor === '馆内');
  assert.equal(image?.src, '/images/places/floorplan/shanghai-center-of-photography-1f.svg', '单层展厅应连接本地重绘图');
  const svg = await readFile(join(process.cwd(), 'public', String(image?.src || '').replace(/^\//, '')), 'utf8');
  assert.ok(svg.includes('三角形玻璃庭院') && svg.includes('六个椭圆体量'), '图中应标出建筑师公开的核心空间关系');
  assert.equal((svg.match(/<ellipse\b/g) || []).length, 6, '平面图应绘出六个曲面展厅体量');
  assert.ok(!svg.includes('<image') && !svg.includes('href='), '平面图应为产品内绘制的本地矢量图，不加载外部图片');
  const sheet = renderer.buildingSheetHtml(place, 'main');
  assert.ok(sheet.includes('floor-plan-image') && sheet.includes('zoom-place-image') && sheet.includes(image.src), '馆内图应在产品中可查看和放大');
  assert.ok(!sheet.includes('href='), '查看平面图不应外跳');
});

test('景点总览: 楼层图覆盖度如实区分已绘、部分覆盖和待补建筑', async () => {
  const renderer = await load('public/lib/place-tour.js');
  const temple = renderer.tourSectionHtml({ placeId: 'p-longhua', name: '龙华寺', category: 'culture' });
  assert.ok(temple.includes('暂无可展示的楼层平面图'), '龙华寺总览不应把可点击误报为可查看室内图');
  assert.ok(temple.includes('site-map-building is-plan-pending'), '缺少本地楼层图的建筑在总览中应有待补状态');
  assert.ok(temple.includes('data-building="shanmen"') && temple.includes('位置还需核对'), '山门保留资料入口并说明尚未对应真实轮廓');

  const starMuseum = renderer.tourSectionHtml({ placeId: 'p-star', name: '星美术馆', category: 'culture' });
  assert.ok(starMuseum.includes('楼层图 2/3 · 已收录资料'), '部分已收录楼层已有图时显示准确覆盖数');
  assert.ok(starMuseum.includes('site-map-building is-plan-partial'), '部分覆盖的建筑应与待补建筑区分');

  const craftsMuseum = renderer.tourSectionHtml({ placeId: 'p-crafts', name: '上海工艺美术博物馆', category: 'culture' });
  assert.ok(craftsMuseum.includes('楼层图 3/3 · 已收录资料'), '所有已收录楼层均有本地图时应显示覆盖数，不声称是建筑所有实际楼层');
});

test('景点总览: 详情页显示完整场地并将楼宇轮廓作为室内图入口', async () => {
  const render = await load('public/views/place.js');
  const store = await load('public/lib/store.js');
  const prev = { placeDetailId: store.state.placeDetailId, savedPlans: store.state.savedPlans, places: store.state.places, favorites: store.state.favorites };
  store.state.placeDetailId = '12143603120601';
  store.state.places = [{ placeId: '12143603120601', name: '武康大楼', category: 'landmark', cityCode: '310100', coordinates: null, facilityCodes: [], openingIntervals: [], suggestedDurationMinutes: null, costEstimate: null }];
  try {
    const html = render.renderPlace();
    assert.ok(html.includes('place-tour'), '渲染出游览地图区块');
    assert.ok(html.includes('site-map-svg'), '渲染出本地绘制的总览地图');
    assert.ok(html.includes('data-action="open-building-plan"') && html.includes('data-building="main"'), '楼宇轮廓直接打开对应建筑室内图');
    assert.ok(!html.includes('tour-map-marker') && !html.includes('tour-route-line'), '总览中不再绘制编号点与点位路线');
  } finally {
    store.state.placeDetailId = prev.placeDetailId;
    store.state.savedPlans = prev.savedPlans;
    store.state.places = prev.places;
    store.state.favorites = prev.favorites;
  }
});

test('景点总览: 地图内容在伴途内呈现，不向游客跳转外部地图', async () => {
  const { join } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const module = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour.js')).href);
  const { tourFor } = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour-data.js')).href);
  const botanicalGarden = { placeId: 'p-garden', name: '上海植物园', category: 'rest' };
  const section = module.tourSectionHtml(botanicalGarden);
  assert.ok(!section.includes('href='), '地图区不渲染外部跳转链接');
  const botanicalTour = tourFor(botanicalGarden);
  const greenhouseBuildings = botanicalTour.buildings?.filter((building: any) => building.id === 'greenhouse-1' || building.id === 'greenhouse-2') || [];
  assert.equal(greenhouseBuildings.length, 2, '植物园地图分别提供两座展览温室的楼层入口');
  assert.ok(greenhouseBuildings.every((building: any) => building.floorPlanImages?.length === building.floors.length), '两座展览温室均显示本地重绘的测绘导览图');
  const greenhouseOne = module.buildingSheetHtml(botanicalGarden, 'greenhouse-1');
  const greenhouseTwo = module.buildingSheetHtml(botanicalGarden, 'greenhouse-2');
  assert.ok(greenhouseOne.includes('floor-plan-image') && greenhouseOne.includes('shanghai-botanical-greenhouse-1f.svg'), '温室一打开本地重绘平面图');
  assert.ok(greenhouseTwo.includes('floor-plan-image') && greenhouseTwo.includes('shanghai-botanical-greenhouse-2f.svg'), '温室二打开本地重绘平面图');
  const greenhouseOneSvg = await readFile(join(process.cwd(), 'public/images/places/floorplan/shanghai-botanical-greenhouse-1f.svg'), 'utf8');
  const greenhouseTwoSvg = await readFile(join(process.cwd(), 'public/images/places/floorplan/shanghai-botanical-greenhouse-2f.svg'), 'utf8');
  assert.ok(greenhouseOneSvg.includes('热带雨林区') && greenhouseOneSvg.includes('凤梨科') && greenhouseOneSvg.includes('秋海棠科'), '温室一图呈现实测轮廓、热带雨林和四个专类植物区');
  assert.ok(greenhouseTwoSvg.includes('食虫植物区') && greenhouseTwoSvg.includes('中心展示区') && greenhouseTwoSvg.includes('热带珍稀濒危植物区'), '温室二图呈现四座温室、连廊和主题分区');
  assert.ok(!greenhouseOne.includes('href=') && !greenhouseTwo.includes('href='), '楼层弹窗不渲染外部跳转链接');
  const weatherMuseum = { placeId: 'p-weather', name: '上海气象博物馆（徐家汇观象台）', category: 'culture' };
  const weatherSection = module.tourSectionHtml(weatherMuseum);
  const weatherSecondFloor = module.buildingSheetHtml(weatherMuseum, 'main');
  module.rememberBuildingFloor(weatherMuseum, 'main', 1);
  const weatherThirdFloor = module.buildingSheetHtml(weatherMuseum, 'main');
  assert.ok(!weatherSection.includes('href='), '气象馆地图区不再要求游客跳转外链');
  assert.ok(weatherSecondFloor.includes('floor-plan-unavailable') && !weatherSecondFloor.includes('floor-plan-schematic'), '没有可靠平面图时不展示猜测的房间示意');
  assert.ok(weatherSecondFloor.includes('暂不显示推测的房间布局'), '气象馆无图楼层应明确说明当前未展示未经核实的布局');
  assert.ok(weatherSecondFloor.includes('2F') && weatherSecondFloor.includes('3F'), '展馆弹窗展示楼层切换按钮');
  assert.ok(weatherThirdFloor.includes('floor-plan-unavailable') && weatherThirdFloor.includes('尚无可核验的楼层平面图'), '未核实的三层不再把内容卡片画成地图');
  const starMuseum = { placeId: 'p-start-museum', name: '星美术馆', category: 'culture' };
  const starTour = tourFor(starMuseum);
  module.rememberBuildingFloor(starMuseum, 'main', 0);
  const starGroundFloor = module.buildingSheetHtml(starMuseum, 'main');
  assert.ok(starGroundFloor.includes('start-museum-1f.svg') && starGroundFloor.includes('floor-plan-image'), '星美术馆首层打开建筑师平面本地重绘图');
  module.rememberBuildingFloor(starMuseum, 'main', 1);
  const starMezzanine = module.buildingSheetHtml(starMuseum, 'main');
  assert.ok(starMezzanine.includes('floor-plan-unavailable') && !starMezzanine.includes('floor-plan-schematic'), '无夹层图纸时显示待核实提示，不展示旧示意图');
  module.rememberBuildingFloor(starMuseum, 'main', 2);
  const starRoof = module.buildingSheetHtml(starMuseum, 'main');
  assert.ok(starRoof.includes('start-museum-roof.svg') && starRoof.includes('floor-plan-image'), '星美术馆屋顶打开平台层图纸本地重绘图');
  assert.ok([starGroundFloor, starMezzanine, starRoof].every(sheet => !sheet.includes('href=')), '星美术馆楼层地图不出现外部跳转');
  assert.equal(starTour.buildings?.[0]?.floorPlanImages?.length, 2, '只把公开图纸覆盖的两层标记为已绘制');
  const tankSheet = module.buildingSheetHtml({ placeId: 'p-tank', name: '油罐艺术中心', category: 'culture' }, 'tank-1');
  assert.ok(tankSheet.includes('油罐一号') && tankSheet.includes('floor-plan-image') && tankSheet.includes('tank-shanghai-1-1f.svg') && !tankSheet.includes('href='), '一号罐点击后打开独立的本地矢量平面图');
  const tankTour = tourFor({ name: '油罐艺术中心', category: 'culture' });
  const tankBuildings = tankTour.buildings?.filter((building: any) => /^tank-[1-5]$/.test(building.id)) || [];
  assert.equal(tankBuildings.length, 5, '园区总览中的五座油罐都应各自有独立的图纸入口');
  assert.match(tankTour.floorPlanSource?.label || '', /OPEN Architecture.*本地重绘/, '油罐楼层图应注明 OPEN Architecture 设计资料来源');
  assert.equal(tankBuildings.reduce((count: number, building: any) => count + building.floors.length, 0), 9, '五座油罐共提供九个可切换楼层');
  for (const tank of tankBuildings) {
    const floorHtml = module.buildingSheetHtml({ placeId: 'p-tank', name: '油罐艺术中心', category: 'culture' }, tank.id);
    assert.deepEqual(tank.floorPlanImages?.map((image: any) => image.floor), tank.floors.map((floor: any) => floor.name), `${tank.name}每个可切换楼层都必须关联本地图文件`);
    assert.ok(floorHtml.includes('floor-plan-image') && !floorHtml.includes('floor-plan-schematic'), `${tank.name}应打开本地矢量平面图`);
    assert.ok(!floorHtml.includes('href='), '油罐楼层图不跳转外部链接');
    for (const image of tank.floorPlanImages || []) {
      const svg = await readFile(join(process.cwd(), 'public', String(image.src).replace(/^\//, '')), 'utf8');
      assert.ok(svg.includes('<svg') && svg.includes('OPEN Architecture'), `${tank.name} ${image.floor} 应加载依据建筑师设计资料重绘的本地 SVG`);
      assert.ok(!svg.includes('<image') && !svg.includes('href='), `${tank.name} ${image.floor} 不得嵌入原图或外链`);
    }
  }
  const tankMap = module.tourSectionHtml({ placeId: 'p-tank', name: '油罐艺术中心', category: 'culture' });
  assert.ok(tankMap.includes('data-building="tank-1"') && tankMap.includes('data-building="tank-5"'), '五罐全貌图上的各罐轮廓都可点击');
  const guangqiMuseum = module.buildingSheetHtml({ placeId: 'p-guangqi', name: '光启公园', category: 'rest' }, 'museum');
  assert.ok(guangqiMuseum.includes('floor-plan-unavailable') && !guangqiMuseum.includes('floor-plan-schematic'), '光启纪念馆无实测图时应隐藏旧房间框示意并明确提示待核实');
  const filmMuseum = { placeId: 'p-film', name: '上海电影博物馆', category: 'culture' };
  const filmTour = tourFor(filmMuseum);
  assert.deepEqual(filmTour.buildings[0].floorPlanImages?.map((image: any) => image.floor), ['1F', '2F', '3F', '4F'], '电影博物馆楼层切换必须对应四张本地平面图');
  for (const image of filmTour.buildings[0].floorPlanImages || []) {
    const localPath = join(process.cwd(), 'public', image.src.replace(/^\//, ''));
    const svg = await readFile(localPath, 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('伴途根据 COORDINATION ASIA'), `${image.floor} 应加载依据公开设计图重绘的本地 SVG`);
    assert.ok(!svg.includes('href='), `${image.floor} 本地平面图不能跳转外链`);
  }
  module.rememberBuildingFloor(filmMuseum, 'main', 3);
  const filmSheet = module.buildingSheetHtml(filmMuseum, 'main');
  assert.ok(filmSheet.includes('/images/places/floorplan/shanghai-film-museum-4f.svg'), '电影博物馆可切换并查看四层对应本地图');
  const filmFourthFloor = await readFile(join(process.cwd(), 'public/images/places/floorplan/shanghai-film-museum-4f.svg'), 'utf8');
  assert.ok(filmFourthFloor.includes('百年发行放映') && filmFourthFloor.includes('中庭挑空'), '四层平面应保留项目图中的主要展区与中央空间关系');
  assert.ok(!filmSheet.includes('href='), '自绘楼层图不包含外部跳转');
  const library = { placeId: 'p-xujiahui-library', name: '徐家汇书院', category: 'culture' };
  const libraryTour = tourFor(library);
  assert.deepEqual(libraryTour.buildings[0].floorPlanImages?.map((image: any) => image.floor), ['B1', '1F', '2F', '3F'], '徐家汇书院四层均有本地视觉资料，B1 为功能示意');
  const libraryBasement = module.buildingSheetHtml(library, 'main');
  assert.ok(libraryBasement.includes('xujiahui-library-b1.svg') && libraryBasement.includes('功能示意') && libraryBasement.includes('不表示房间边界'), '徐家汇书院 B1 应展示本地功能图并明确没有精确平面');
  assert.ok(!libraryBasement.includes('href='), '徐家汇书院 B1 功能图不得跳转外部链接');
  const basementSvg = await readFile(join(process.cwd(), 'public/images/places/floorplan/xujiahui-library-b1.svg'), 'utf8');
  assert.ok(basementSvg.includes('东西公园') && basementSvg.includes('智能书库') && basementSvg.includes('不表示房间边界'), 'B1 图应只呈现公开确认的功能，不暗示精确空间关系');
  assert.ok(!basementSvg.includes('<image') && !basementSvg.includes('href='), 'B1 图应由项目本地矢量绘制，不嵌入原图或外链');
  const libraryOverview = module.tourSectionHtml(library);
  assert.ok(libraryOverview.includes('楼层图 3/4 · 已收录资料') && libraryOverview.includes('site-map-building is-plan-partial'), 'B1 功能图不能冒充真实楼层平面或提高平面图覆盖数');
  const libraryPlans = [
    ['xujiahui-library-1f.svg', ['入口门厅', '儿童阅览区', '中庭', '咖啡茶饮']],
    ['xujiahui-library-2f.svg', ['北侧阅读区', '西侧阅读区', '东侧阅读区', '自习室', '电子阅览', '中庭']],
    ['xujiahui-library-3f.svg', ['期刊阅览区', '讨论室', '办公区', '珍贵文献阅读', '报告厅', '展示空间']],
  ] as [string, string[]][];
  for (const [index, [file, labels]] of libraryPlans.entries()) {
    module.rememberBuildingFloor(library, 'main', index + 1);
    const sheet = module.buildingSheetHtml(library, 'main');
    const svg = await readFile(join(process.cwd(), 'public/images/places/floorplan', file), 'utf8');
    assert.ok(sheet.includes(file) && sheet.includes('floor-plan-image'), `${index + 1}F 应展示本地平面图`);
    for (const label of labels) assert.ok(svg.includes(label), `${file} 应标出设计图中的 ${label}`);
    assert.ok(!sheet.includes('href='), '书院楼层图不包含外部跳转');
  }
  const shanghaiLibrary = { placeId: 'p-shanghai-library', name: '上海图书馆', category: 'culture' };
  const shanghaiLibraryTour = tourFor(shanghaiLibrary);
  for (const [index, expected] of ['shanghai-library-1f.svg', 'shanghai-library-2f.svg', 'shanghai-library-3f.svg'].entries()) {
    module.rememberBuildingFloor(shanghaiLibrary, 'main', index);
    const sheet = module.buildingSheetHtml(shanghaiLibrary, 'main');
    assert.ok(sheet.includes(expected) && sheet.includes('平面图'), `${shanghaiLibraryTour.buildings[0].floors[index].name} 应打开对应的本地自绘平面图`);
    assert.ok(sheet.includes('data-action="zoom-place-image"') && sheet.includes('点击图面查看大图'), '平面图应支持在伴途内放大查看细节');
    assert.ok(!sheet.includes('href='), '自绘楼层图不包含外部跳转');
  }
  const museumEast = { placeId: 'p-shanghai-museum-east', name: '上海博物馆东馆', category: 'culture' };
  const museumEastTour = tourFor(museumEast);
  for (const [index, image] of (museumEastTour.buildings[0].floorPlanImages || []).entries()) {
    module.rememberBuildingFloor(museumEast, 'main', index);
    const sheet = module.buildingSheetHtml(museumEast, 'main');
    assert.ok(sheet.includes(image.src) && sheet.includes('floor-plan-image'), `上博东馆 ${image.floor} 应打开对应的本地官方布局重绘图`);
    assert.ok(sheet.includes('data-action="zoom-place-image"') && !sheet.includes('href='), '上博东馆楼层图应在伴途内放大查看，不跳转外链');
  }
  const policeMuseum = { placeId: 'p-shanghai-police-museum', name: '上海公安博物馆', category: 'culture' };
  for (const [index, expected] of ['shanghai-police-museum-1f.svg', 'shanghai-police-museum-2f.svg', 'shanghai-police-museum-3f.svg', 'shanghai-police-museum-4f.svg'].entries()) {
    module.rememberBuildingFloor(policeMuseum, 'main', index);
    const sheet = module.buildingSheetHtml(policeMuseum, 'main');
    assert.ok(sheet.includes(expected) && sheet.includes('平面图'), `公安博物馆 ${index + 1}F 应打开对应的本地真实轮廓图`);
    assert.ok(sheet.includes('data-action="zoom-place-image"'), '公安博物馆平面图应可在伴途内放大');
    assert.ok(!sheet.includes('href='), '公安博物馆自绘平面图不包含外部跳转');
  }
  const westBundMuseum = { placeId: 'p-westbund-museum', name: '西岸美术馆', category: 'culture' };
  const westBundTour = tourFor(westBundMuseum);
  const westBundB1 = module.buildingSheetHtml(westBundMuseum, 'main');
  assert.ok(westBundB1.includes('/images/places/floorplan/west-bund-museum-b1.svg'), '西岸美术馆 B1 应打开带真实功能布局的本地平面图');
  module.rememberBuildingFloor(westBundMuseum, 'main', 1);
  const westBundF1 = module.buildingSheetHtml(westBundMuseum, 'main');
  assert.ok(westBundF1.includes('/images/places/floorplan/west-bund-museum-1f.svg'), '西岸美术馆 1F 应打开本地首层平面图');
  module.rememberBuildingFloor(westBundMuseum, 'main', 2);
  const westBundF2 = module.buildingSheetHtml(westBundMuseum, 'main');
  assert.ok(westBundF2.includes('/images/places/floorplan/west-bund-museum-2f.svg') && westBundF2.includes('David Chipperfield Architects'), '西岸美术馆 2F 应打开本地二层平面图并显示来源署名');
  assert.ok([westBundB1, westBundF1, westBundF2].every(sheet => sheet.includes('floor-plan-image') && sheet.includes('zoom-place-image') && !sheet.includes('href=')), '西岸美术馆三层都应能在伴途内查看和放大本地图，不出现外跳链接');
  assert.equal(westBundTour.buildings[0].floors.length, 3, '楼层切换覆盖西岸美术馆公开的三层导览');
  const longMuseumPlace = { placeId: 'p-long-museum-west-bund', name: '龙美术馆（西岸馆）', category: 'culture' };
  const longMuseumTour = tourFor(longMuseumPlace);
  for (const [index, expected] of ['long-museum-west-bund-b1.svg', 'long-museum-west-bund-1f.svg', 'long-museum-west-bund-2f.svg'].entries()) {
    module.rememberBuildingFloor(longMuseumPlace, 'main', index);
    const sheet = module.buildingSheetHtml(longMuseumPlace, 'main');
    assert.ok(sheet.includes(expected) && sheet.includes('floor-plan-image'), `龙美术馆 ${longMuseumTour.buildings[0].floors[index].name} 应打开对应的本地平面图`);
    assert.ok(sheet.includes('data-action="zoom-place-image"') && !sheet.includes('href='), '龙美术馆平面图应在产品内放大查看，不跳转外链');
  }
  const westBundDreamCenter = { placeId: 'p-westbund-dream', name: '西岸梦中心', category: 'culture' };
  const dreamCenterTour: any = tourFor(westBundDreamCenter);
  assert.deepEqual(dreamCenterTour.buildings?.map((building: any) => building.id), ['factory', 'silo'], '场地总览单独展示，只有可点击的 M Factory 与筒仓进入建筑楼层图');
  assert.ok(dreamCenterTour.buildings?.every((building: any) => building.floorPlanImages?.length === building.floors.length), '西岸梦中心两座主要建筑的每层都应使用本地平面图');
  const dreamOverview = module.tourSectionHtml(westBundDreamCenter);
  assert.ok(dreamOverview.includes('site-map-building-secondary') && dreamOverview.includes('data-building="factory"') && dreamOverview.includes('data-building="silo"') && !dreamOverview.includes('data-building="legacy-hall"'), '场地总览保留真实背景轮廓及 M Factory、筒仓的原楼层资料入口');
  assert.equal(dreamCenterTour.buildings?.find((building: any) => building.id === 'silo')?.floorPlanImages?.length, 3, '筒仓各层应接入 MVRDV 公开的三组楼层平面');
  for (const building of dreamCenterTour.buildings || []) {
    for (const [index, floor] of building.floors.entries()) {
      module.rememberBuildingFloor(westBundDreamCenter, building.id, index);
      const sheet = module.buildingSheetHtml(westBundDreamCenter, building.id);
      const image = building.floorPlanImages.find((item: any) => item.floor === floor.name);
      assert.ok(image?.src && sheet.includes(image.src) && sheet.includes('floor-plan-image') && sheet.includes('zoom-place-image'), `${building.name} ${floor.name} 应打开对应的本地可放大平面图`);
      assert.ok(!sheet.includes('href='), `${building.name} ${floor.name} 不应包含外跳链接`);
      const svg = await readFile(join(process.cwd(), 'public', image.src.replace(/^\//, '')), 'utf8');
      assert.ok(svg.includes('<svg') && svg.includes('MVRDV') && !svg.includes('href='), `${building.name} ${floor.name} 应由项目本地 SVG 绘制并标明绘图依据`);
    }
  }
  for (const place of DEMO_SHANGHAI_PLACES) {
    assert.ok(!module.tourSectionHtml(place).includes('href='), `${place.name} 的地图区不得跳转外部链接`);
    const tour = tourFor(place);
    for (const building of tour.buildings || []) {
      assert.ok(!module.buildingSheetHtml(place, building.id).includes('href='), `${place.name} 的楼层图不得跳转外部链接`);
    }
  }
});

// ---- 建筑平面图与楼层切换（R: 点击建筑 → 平面图 → 切楼层）----
test('建筑平面图: 展示本地绘制图，无平面数据时明确提示并保留楼层记忆', async () => {
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const module = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour.js')).href);
  const { buildingSheetHtml, rememberBuildingFloor } = module as any;
  // 未能核实的武康大楼一层布局不可作为实际室内图展示。
  const place = { placeId: 'p-x', name: '武康大楼', category: 'landmark' };
  const wukang = buildingSheetHtml(place, 'main');
  assert.ok(wukang.includes('外观资料'), '仅有外观资料不提供馆内导览');
  assert.ok(wukang.includes('没有已核实的公众室内参观平面资料'), '缺乏公众室内资料时明确说明，不承诺未来开放');
  assert.ok(!wukang.includes('wukang-building-1f.svg'), '不得继续显示未经核实的商铺和公共设施布局');
  assert.ok(!wukang.includes('floor-plan-image'), '没有核实图纸时不生成图片缩放入口');
  // 未核实的地点不应从文化类别虚构馆内布局。
  const generic = buildingSheetHtml({ placeId: 'p-generic', name: '测试地点', category: 'culture' }, 'main');
  assert.ok(generic.includes('暂无可展示的平面资料'), '无场馆平面数据时明确提示当前不可用');
  const genericTour = (await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour-data.js')).href)).tourFor({ name: '测试地点', category: 'culture' });
  assert.equal(genericTour.buildings.length, 0, '分类兜底不生成假楼层');
  // 曾记住旧占位楼层，也不能恢复已撤下的布局或把外观资料当成室内楼层。
  rememberBuildingFloor(place, 'main', 0);
  const remembered = buildingSheetHtml(place, 'main');
  assert.ok(remembered.includes('外观资料') && !remembered.includes('floor-tabs'), '楼层记忆不会恢复已撤下的假图');
});

// ---- T7 编辑路径：日计划内容保存不保留「次日起始」的站点 ----
test('T7/编辑: save() 新建日计划时次日起始的站点自动归入次日计划', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', {
    name: '含次日站点', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai',
    snapshot: {
      stops: [
        { stopId: 'day-a', startMinutes: 540, endMinutes: 600, plannedDurationMinutes: 60, status: 'planned' },
        { stopId: 'night-b', startMinutes: 1500, endMinutes: 1560, plannedDurationMinutes: 60, status: 'planned' },
      ],
      routeLegs: [], plannedCharges: [],
    },
  });
  const stops = plan.stops as any[];
  assert.equal(stops.length, 1, '当天计划不保留次日起始的站点');
  assert.equal(stops[0].stopId, 'day-a');
  const nextDay = service.list('owner').find(item => item.kind === 'plan' && item.localDate === '2026-09-24');
  assert.ok(nextDay, '次日计划自动创建');
  const moved = (nextDay!.stops as any[]).find(stop => stop.stopId === 'night-b');
  assert.equal(moved.startMinutes, 60, '分钟数归一化到次日 01:00');
  assert.equal(moved.endMinutes, 120);
});

test('T7/编辑: update() 顺延推过午夜的站点迁入已有次日计划并按 T1 消解重叠', () => {
  const service = new PlanLibraryService(now);
  const nextDay = service.save('owner', {
    name: '次日已有安排', kind: 'plan', localDate: '2026-09-24', timezone: 'Asia/Shanghai',
    snapshot: {
      stops: [{ stopId: 'next-x', startMinutes: 30, endMinutes: 90, plannedDurationMinutes: 60, status: 'planned' }],
      routeLegs: [], plannedCharges: [],
    },
  });
  const plan = service.save('owner', {
    name: '深夜编辑', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai',
    snapshot: {
      stops: [{ stopId: 'late-a', startMinutes: 1410, endMinutes: 1440, plannedDurationMinutes: 30, status: 'planned' }],
      routeLegs: [], plannedCharges: [],
    },
  });
  // 追加一个与 late-a 重叠的站点：服务端顺延后起始被推过午夜（1440）→ 迁入次日。
  const updated = service.update('owner', plan.id, {
    name: '深夜编辑', cityCode: '310100', timezone: 'Asia/Shanghai', localDate: '2026-09-23',
    snapshot: {
      stops: [
        { stopId: 'late-a', startMinutes: 1410, endMinutes: 1440, plannedDurationMinutes: 30, status: 'planned' },
        { stopId: 'late-b', startMinutes: 1420, endMinutes: 1480, plannedDurationMinutes: 60, status: 'planned' },
      ],
      routeLegs: [], plannedCharges: [],
    },
  });
  const kept = (updated.stops as any[]).map(stop => stop.stopId);
  assert.deepEqual(kept, ['late-a'], '当天只留下起始仍在当天的站点');
  const nextStops = (service.get('owner', nextDay.id).stops as any[]);
  const movedB = nextStops.find(stop => stop.stopId === 'late-b');
  assert.ok(movedB, 'late-b 迁入次日计划');
  assert.equal(movedB.startMinutes, 0, '分钟数归一化到次日 00:00');
  const shiftedX = nextStops.find(stop => stop.stopId === 'next-x');
  assert.ok(shiftedX.startMinutes >= movedB.endMinutes, '次日已有安排按 T1 自动顺延，不重叠');
});

test('状态转移提示: 错误信息使用地点名称与中文状态，不再暴露 stopId', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', {
    name: '提示语', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai',
    snapshot: {
      stops: [
        { stopId: 's1', place: { placeId: 'p1', name: '外滩' }, startMinutes: 540, endMinutes: 600, plannedDurationMinutes: 60, status: 'planned' },
        { stopId: 's2', place: { placeId: 'p2', name: '豫园' }, startMinutes: 660, endMinutes: 720, plannedDurationMinutes: 60, status: 'planned' },
      ],
      routeLegs: [], plannedCharges: [],
    },
  });
  service.recordExecution('owner', plan.id, { stopId: 's1', type: 'depart', occurredAt: '2026-09-23T09:00:00+08:00' });
  // s1 已在前往中：再次出发是非法转移，提示带地点名与当前状态。
  assert.throws(
    () => service.recordExecution('owner', plan.id, { stopId: 's1', type: 'depart', occurredAt: '2026-09-23T09:10:00+08:00' }),
    /「外滩」当前是「前往中」，不能执行「出发」/,
  );
  // s2 想出发但 s1 进行中：单一进行中冲突，提示带地点名与处理建议。
  assert.throws(
    () => service.recordExecution('owner', plan.id, { stopId: 's2', type: 'depart', occurredAt: '2026-09-23T09:20:00+08:00' }),
    /「外滩」正在前往中；同一时间只能有一个地点在进行中/,
  );
});

test('ETA: 出发时写入自动估算的交通耗时与方式，中止后清除', () => {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: 'ETA', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: [{ stopId: 'a', place: { placeId: 'p1', name: '外滩' }, startMinutes: 540, endMinutes: 600, plannedDurationMinutes: 60, status: 'planned' }],
    routeLegs: [], plannedCharges: [],
  } });
  const departed = service.recordExecution('owner', plan.id, {
    stopId: 'a', type: 'depart', occurredAt: '2026-09-23T09:00:00+08:00',
    estimatedTravelMinutes: 22.4, estimatedTransportMode: 'driving',
  });
  const stop = (departed.stops as any[]).find(s => s.stopId === 'a');
  assert.equal(stop.estimatedTravelMinutes, 23, '分钟数向上取整持久化');
  assert.equal(stop.estimatedTransportMode, 'driving');
  const aborted = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'abort', occurredAt: '2026-09-23T09:10:00+08:00' });
  const after = (aborted.stops as any[]).find(s => s.stopId === 'a');
  assert.equal(after.estimatedTravelMinutes, undefined, '中止后估算作废');
  assert.equal(after.estimatedTransportMode, undefined);
});
