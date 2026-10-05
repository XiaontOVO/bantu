import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';
import { applyExecutionEvent } from '../src/domain/execution.js';
import type { PlanStop, TripSnapshot } from '../src/domain/types.js';

const stop = (stopId: string, startMinutes: number, endMinutes: number): PlanStop =>
  ({ stopId, startMinutes, endMinutes, plannedDurationMinutes: endMinutes - startMinutes, status: 'planned' });
function fixture(clock = '2026-09-28T09:00:00+08:00') {
  const time = { value: clock };
  const service = new PlanLibraryService(() => time.value);
  const save = (name: string, date: string, stops: PlanStop[], routeLegs: any[] = []) => service.save('owner', {
    name, kind: 'plan', localDate: date, timezone: 'Asia/Shanghai', snapshot: { stops, routeLegs, plannedCharges: [] },
  });
  return { time, service, save };
}
test('an overdue overnight visit survives cleanup and records the actual completion', () => {
  const { time, service, save } = fixture('2026-09-28T23:30:00+08:00');
  const plan = save('夜游', '2026-09-28', [stop('night', 1410, 1450)]);
  service.recordExecution('owner', plan.id, { stopId: 'night', type: 'arrive', occurredAt: time.value });
  time.value = '2026-09-29T00:20:00+08:00';
  assert.ok(service.list('owner').some(item => item.id === plan.id));
  const result = service.recordExecution('owner', plan.id, { stopId: 'night', type: 'complete', occurredAt: time.value });
  assert.equal((result.stops as PlanStop[])[0].endMinutes, 1460);
  assert.equal((result.stops as PlanStop[])[0].status, 'completed');
});
test('a visit over 24 hours preserves its actual timestamps until explicitly completed', () => {
  const { time, service, save } = fixture();
  const plan = save('超时访问', '2026-09-28', [stop('a', 540, 600)]);
  service.recordExecution('owner', plan.id, { stopId: 'a', type: 'arrive', occurredAt: time.value });
  time.value = '2026-09-29T15:00:00+08:00';
  const ongoing = service.list('owner').find(item => item.id === plan.id)!;
  assert.ok(ongoing);
  assert.equal((ongoing.stops as any[])[0].executionOverdue, true);
  const result = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'complete', occurredAt: time.value });
  assert.equal((result.stops as PlanStop[])[0].endMinutes, 2340, '真实结束时间不截断成 24 小时');
});
test('a user cannot start or correct another day into active while an overnight visit is active', () => {
  const { time, service, save } = fixture('2026-09-28T23:30:00+08:00');
  const previous = save('昨晚', '2026-09-28', [stop('a', 1410, 1490)]);
  const next = save('今天', '2026-09-29', [stop('b', 30, 90)]);
  service.recordExecution('owner', previous.id, { stopId: 'a', type: 'arrive', occurredAt: time.value });
  time.value = '2026-09-29T00:05:00+08:00';
  for (const type of ['depart', 'arrive'] as const) {
    assert.throws(() => service.recordExecution('owner', next.id, { stopId: 'b', type, occurredAt: time.value }), /正在|进行中/);
  }
  const skipped = service.recordExecution('owner', next.id, { stopId: 'b', type: 'skip', occurredAt: time.value });
  assert.throws(() => service.correctExecution('owner', next.id, { eventId: skipped.executionEvents![0].executionEventId,
    type: 'arrive', status: 'visiting' }), /正在|进行中/);
  assert.equal(service.get('owner', next.id).executionEvents!.length, 1, '拒绝操作不能追加执行事实');
});
test('aborting an out-of-order departure restores pending order without erasing recorded delay', () => {
  const { time, service, save } = fixture();
  const plan = save('中止', '2026-09-28', [stop('a', 540, 600), stop('b', 620, 680)]);
  service.recordExecution('owner', plan.id, { stopId: 'b', type: 'depart', occurredAt: time.value });
  time.value = '2026-09-28T09:05:00+08:00';
  const result = service.recordExecution('owner', plan.id, { stopId: 'b', type: 'abort', occurredAt: time.value });
  assert.deepEqual((result.stops as PlanStop[]).map(item => item.stopId), ['a', 'b']);
  assert.ok((result.stops as PlanStop[]).every(item => item.status === 'planned'));
  assert.equal(result.executionEvents!.length, 2);
});
test('direct completion before the planned visit records an unknown arrival and an actual completion point', () => {
  const { time, service, save } = fixture('2026-09-28T12:00:00+08:00');
  const plan = save('补记', '2026-09-28', [stop('a', 840, 900)]);
  const result = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'complete', occurredAt: time.value });
  const completed = (result.stops as any[])[0];
  assert.equal(completed.startMinutes, 720);
  assert.equal(completed.endMinutes, 720);
  assert.equal(completed.actualArrivalMinutes, undefined);
  assert.equal(completed.actualCompletionMinutes, 720);
});
test('departure delay uses arrival minus travel time and arrival does not apply the same delay twice', () => {
  const { time, service, save } = fixture('2026-09-28T10:20:00+08:00');
  const plan = save('实际出发基准', '2026-09-28', [stop('a', 600, 660), stop('b', 720, 780)]);
  const departed = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'depart', occurredAt: time.value,
    estimatedTravelMinutes: 30, estimatedTransportMode: 'walking' });
  const pending = (departed.stops as any[]).find(item => item.stopId === 'b');
  assert.equal(pending.startMinutes, 770, '计划 09:30 出发，10:20 出发晚 50 分钟');
  assert.equal((departed.stops as any[]).find(item => item.stopId === 'a').forecastStartMinutes, 650);
  time.value = '2026-09-28T10:50:00+08:00';
  const arrived = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'arrive', occurredAt: time.value });
  assert.equal((arrived.stops as any[]).find(item => item.stopId === 'b').startMinutes, 770, '到达时不再重复顺延 50 分钟');
});
test('known transfer time and buffer protect the next visit while unknown routes remain explicitly unknown', () => {
  const { time, service, save } = fixture('2026-09-28T14:00:00+08:00');
  const plan = save('交通可达', '2026-09-28', [stop('a', 840, 900), stop('b', 900, 960), stop('c', 1000, 1060)],
    [{ legId: 'ab', fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationSeconds: 1800, bufferMinutes: 5 }]);
  service.recordExecution('owner', plan.id, { stopId: 'a', type: 'arrive', occurredAt: time.value });
  time.value = '2026-09-28T15:00:00+08:00';
  const done = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'complete', occurredAt: time.value });
  const b = (done.stops as any[]).find(item => item.stopId === 'b');
  assert.ok(b.startMinutes >= 935, '下一站至少留出 30 分钟交通和 5 分钟缓冲');
  assert.equal((done.stops as any[]).find(item => item.stopId === 'c').transferTimeUnknown, true);
});
test('active route forecasts shift the displayed future window without overwriting its planned window', () => {
  const { time, service, save } = fixture('2026-09-28T08:50:00+08:00');
  const plan = save('预测与事实分离', '2026-09-28', [stop('a', 540, 600), stop('b', 600, 660)],
    [{ legId: 'origin-a', fromStopId: 'origin', toStopId: 'a', transportMode: 'walking', durationSeconds: 600 }]);
  const result = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'depart', occurredAt: time.value,
    estimatedTravelMinutes: 45, estimatedTransportMode: 'walking' });
  const pending = (result.stops as any[]).find(item => item.stopId === 'b');
  assert.equal(pending.startMinutes, 600, '原计划出发未迟到，路线变化不能冒充实际到达改写计划');
  assert.equal(pending.forecastStartMinutes, 635, '本次路线变为 45 分钟，仅预测窗口延后');
  assert.equal((result.stops as any[]).find(item => item.stopId === 'a').status, 'en_route');
  assert.equal((result.stops as any[]).find(item => item.stopId === 'a').actualArrivalMinutes, undefined);
  time.value = '2026-09-28T09:35:00+08:00';
  const arrived = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'arrive', occurredAt: time.value });
  assert.equal((arrived.stops as any[]).find(item => item.stopId === 'b').startMinutes, 635, '真实到达后只落实一次延误');
});
test('completion before the recorded arrival is rejected rather than silently clamped', () => {
  const snapshot = { tripId: 't', localDate: '2026-09-28', timezone: 'Asia/Shanghai',
    stops: [stop('a', 600, 660)], routeLegs: [], executionEvents: [] } as TripSnapshot;
  const arrived = applyExecutionEvent(snapshot, { stopId: 'a', type: 'arrive', occurredAt: '2026-09-28T10:00:00+08:00' });
  const invalid = applyExecutionEvent(arrived.snapshot!, { stopId: 'a', type: 'complete', occurredAt: '2026-09-28T09:50:00+08:00' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, 'EXECUTION_TIME_CONFLICT');
});

test('editing a running plan retains the departure delay and discards view-only forecasts', () => {
  const { time, service, save } = fixture('2026-09-28T10:20:00+08:00');
  const plan = save('编辑期间的进度', '2026-09-28', [stop('a', 600, 660), stop('b', 720, 780)]);
  const departed = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'depart', occurredAt: time.value, estimatedTravelMinutes: 30 });
  service.update('owner', plan.id, { name: '改名', kind: 'plan', localDate: plan.localDate,
    snapshot: { stops: departed.stops, routeLegs: [], plannedCharges: [] } });
  time.value = '2026-09-28T10:50:00+08:00';
  const arrived = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'arrive', occurredAt: time.value });
  assert.equal((arrived.stops as PlanStop[]).find(item => item.stopId === 'b')!.startMinutes, 770);
  assert.equal((service.get('owner', plan.id).stops as PlanStop[])[0].forecastStartMinutes, undefined);
});

test('aborting and departing again propagates only newly added delay', () => {
  const { time, service, save } = fixture('2026-09-28T10:20:00+08:00');
  const plan = save('重试出发', '2026-09-28', [stop('a', 600, 660), stop('b', 720, 780)],
    [{ legId: 'origin-a', fromStopId: 'origin', toStopId: 'a', transportMode: 'walking', durationSeconds: 1800 }]);
  const record = (type: 'depart' | 'abort' | 'arrive') => service.recordExecution('owner', plan.id, {
    stopId: 'a', type, occurredAt: time.value, ...(type === 'depart' ? { estimatedTravelMinutes: 30 } : {}),
  });
  record('depart');
  time.value = '2026-09-28T10:21:00+08:00'; record('abort');
  time.value = '2026-09-28T10:25:00+08:00';
  assert.equal((record('depart').stops as PlanStop[]).find(item => item.stopId === 'b')!.startMinutes, 775, '保留原 50 分钟延误，只再增加 5 分钟');
  time.value = '2026-09-28T10:55:00+08:00';
  assert.equal((record('arrive').stops as PlanStop[]).find(item => item.stopId === 'b')!.startMinutes, 775, '到达不能重复传播');
});

test('a route forecast preserves a fixed appointment and clearly flags its conflict', () => {
  const { time, service, save } = fixture('2026-09-28T08:50:00+08:00');
  const plan = save('固定预约', '2026-09-28', [stop('a', 540, 600), { ...stop('b', 600, 660), lockTime: true }],
    [{ legId: 'origin-a', fromStopId: 'origin', toStopId: 'a', transportMode: 'walking', durationSeconds: 600 }]);
  const departed = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'depart', occurredAt: time.value, estimatedTravelMinutes: 45 });
  const fixed = (departed.stops as PlanStop[]).find(item => item.stopId === 'b')!;
  assert.equal(fixed.startMinutes, 600);
  assert.equal(fixed.forecastStartMinutes, 600);
  assert.equal(fixed.forecastConflict, true);
  assert.equal(departed.needsReview, true);
});

test('correcting completion into an ongoing visit preserves the existing actual arrival', () => {
  const { time, service, save } = fixture('2026-09-28T09:00:00+08:00');
  const plan = save('继续游览', '2026-09-28', [stop('a', 540, 600)]);
  service.recordExecution('owner', plan.id, { stopId: 'a', type: 'arrive', occurredAt: time.value });
  time.value = '2026-09-28T09:30:00+08:00';
  const completed = service.recordExecution('owner', plan.id, { stopId: 'a', type: 'complete', occurredAt: time.value });
  const corrected = service.correctExecution('owner', plan.id, { eventId: completed.executionEvents!.at(-1)!.executionEventId,
    type: 'complete', status: 'visiting' });
  assert.equal((corrected.stops as PlanStop[])[0].actualArrivalMinutes, 540);
  assert.equal((corrected.stops as PlanStop[])[0].actualCompletionMinutes, undefined);
});
