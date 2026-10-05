import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';

const now = () => '2026-09-23T12:00:00+08:00';
function setup() {
  const service = new PlanLibraryService(now);
  const plan = service.save('owner', { name: '按实际进度调整', kind: 'plan', localDate: '2026-09-23', timezone: 'Asia/Shanghai', snapshot: {
    stops: ['a', 'b', 'c'].map((stopId, i) => ({ stopId, startMinutes: 540 + i * 80, endMinutes: 600 + i * 80, plannedDurationMinutes: 60, status: 'planned' })), routeLegs: [], plannedCharges: [],
  } });
  const record = (stopId: string, type: 'arrive' | 'complete' | 'skip', clock: string) => service.recordExecution('owner', plan.id, { stopId, type, occurredAt: `2026-09-23T${clock}:00+08:00` });
  return { service, plan, record };
}

for (const [finish, delta] of [['09:40', -20], ['10:20', 20]] as const) test(`completion ${finish} shifts remaining times by ${Math.max(delta, 0)} (只延后不提前) exactly once`, () => {
  const { service, plan, record } = setup();
  record('a', 'arrive', '09:00');
  const done = record('a', 'complete', finish);
  const applied = Math.max(delta, 0);
  const stops = done.stops as any[];
  assert.equal(stops.find(s => s.stopId === 'a').endMinutes, 600 + delta);
  assert.equal(stops.find(s => s.stopId === 'b').startMinutes, 620 + applied);
  assert.equal(stops.find(s => s.stopId === 'c').startMinutes, 700 + applied);
  assert.equal(stops.find(s => s.stopId === 'b').endMinutes - stops.find(s => s.stopId === 'b').startMinutes, 60);
  const saved = service.serialize();
  const restarted = new PlanLibraryService(now); restarted.loadSerialized(saved);
  assert.deepEqual(restarted.list('owner')[0].stops, done.stops);
  restarted.list('owner'); restarted.list('owner');
  assert.equal(restarted.serialize(), saved);
  assert.throws(() => restarted.recordExecution('owner', plan.id, { stopId: 'a', type: 'complete', occurredAt: `2026-09-23T${finish}:00+08:00` }));
  assert.equal(restarted.serialize(), saved);
});

test('arrival delay shifts once; early completion does not pull later stops earlier; skipped stops do not block later shifts', () => {
  const { record } = setup();
  record('b', 'skip', '08:50');
  const arrived = record('a', 'arrive', '09:10');
  assert.equal((arrived.stops as any[]).find(s => s.stopId === 'c').startMinutes, 710);
  const completed = record('a', 'complete', '09:40');
  assert.equal((completed.stops as any[]).find(s => s.stopId === 'c').startMinutes, 710);
  assert.equal((completed.stops as any[]).find(s => s.stopId === 'b').status, 'skipped');
});

test('correcting completion shifts by the correction difference and preserves already completed facts', () => {
  const { service, plan, record } = setup();
  record('a', 'arrive', '09:00');
  const completed = record('a', 'complete', '09:40');
  const event = completed.executionEvents!.find(event => event.type === 'complete')!;
  const corrected = service.correctExecution('owner', plan.id, { eventId: event.executionEventId, type: 'complete', status: 'completed', occurredAt: '2026-09-23T09:50:00+08:00' });
  assert.equal((corrected.stops as any[]).find(s => s.stopId === 'b').startMinutes, 630);
  assert.equal((corrected.stops as any[]).find(s => s.stopId === 'c').startMinutes, 710);
  record('b', 'arrive', '10:10');
  const second = record('b', 'complete', '10:40');
  assert.equal((second.stops as any[]).find(s => s.stopId === 'a').endMinutes, 590);
  assert.equal((second.stops as any[]).find(s => s.stopId === 'c').startMinutes, 710);
});
