import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService, SavedPlanRevisionConflictError } from '../src/services/plan-library.js';
import { daytimePlanPreview } from '../src/services/plan-daytime.js';

const date = '2099-09-29', next = '2099-09-30';
const visit = (id: string, start: number, duration = 60, extra = {}) => ({ stopId: id, place: { placeId: 'same-place', name: '同一个地点' },
  status: 'planned', startMinutes: start, endMinutes: start + duration, plannedDurationMinutes: duration, ...extra });
const fixture = () => {
  let now = '2099-09-29T09:00:00+08:00';
  const library = new PlanLibraryService(() => now);
  const save = (name: string, localDate: string, stops: unknown[], routeLegs: unknown[] = [], plannedCharges: unknown[] = []) =>
    library.save('owner', { kind: 'plan', name, localDate, timezone: 'Asia/Shanghai', snapshot: { stops, routeLegs, plannedCharges } });
  return { library, save, advance: (value: string) => { now = value; } };
};

test('daytime preview and apply preserve source facts, fixed appointments and destination arrangements', () => {
  const { library, save, advance } = fixture();
  const source = save('原日', date, [visit('fact', 540), visit('b', 660), visit('fixed', 780, 60, { visitWindow: { startMinutes: 780, endMinutes: 840 } }), visit('repeat', 900)]);
  library.recordExecution('owner', source.id, { stopId: 'fact', type: 'arrive', occurredAt: '2099-09-29T09:00:00+08:00', expectedRevision: 0 });
  library.recordExecution('owner', source.id, { stopId: 'fact', type: 'complete', occurredAt: '2099-09-29T09:50:00+08:00', expectedRevision: 1 });
  advance('2099-09-29T22:00:00+08:00');
  const target = save('次日原有预约', next, [visit('existing', 600, 120, { timeLocked: true })]);
  const before = library.serialize(), facts = structuredClone(source.executionEvents), originalTarget = structuredClone(target.stops);
  const preview = library.previewDaytime('owner', source.id, { stopId: 'b', expectedRevision: 2 });
  assert.equal(library.serialize(), before, 'preview must not write');
  assert.deepEqual(preview.destinations[0].stops.map(stop => [stop.stopId, stop.startMinutes]), [['b', 720], ['repeat', 780]]);
  assert.deepEqual(preview.visitLabels.map(visit => [visit.stopId, visit.visitNumber, visit.totalVisits, visit.openingKnown]), [['b', 2, 4, false], ['repeat', 4, 4, false]]);
  assert.deepEqual(preview.preserved.map(stop => stop.stopId), ['fact', 'fixed']);
  const result = library.applyDaytime('owner', source.id, { stopId: 'b', expectedRevision: 2, previewKey: preview.previewKey });
  assert.equal(result.movedCount, 2);
  assert.deepEqual(library.get('owner', source.id).executionEvents, facts);
  assert.deepEqual(library.get('owner', source.id).stops.map((stop: any) => stop.stopId), ['fact', 'fixed']);
  const after = library.get('owner', target.id);
  assert.deepEqual(after.stops.filter((stop: any) => stop.stopId === 'existing'), originalTarget);
  assert.equal(after.executionEvents?.length, 0);
});

test('full days and opening hours split visits into daytime dates without modifying occupied days', () => {
  const { library, save } = fixture();
  const source = save('原日', date, [visit('a', 660, 120, { openingIntervals: [{ startMinutes: 600, endMinutes: 780 }] }), visit('b', 840, 120, { openingIntervals: [{ startMinutes: 540, endMinutes: 660 }] })]);
  const target = save('次日满额', next, [visit('full', 540, 660)]), targetBefore = structuredClone(target);
  const preview = library.previewDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0 });
  assert.deepEqual(preview.destinations.map(day => [day.date, day.stops[0].startMinutes]), [['2099-10-01', 600], ['2099-10-02', 540]]);
  assert.ok(preview.visitLabels.every(visit => visit.openingKnown));
  assert.ok(preview.expectedCarryTargets.some(target => target.planId === targetBefore.id));
  library.applyDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0, previewKey: preview.previewKey });
  assert.deepEqual(library.get('owner', target.id), targetBefore);
  for (const day of preview.destinations) assert.equal(library.list('owner').find(plan => plan.localDate === day.date)?.stops.length, 1);
});

test('existing next-day active visits and previous-day overnight occupancy cannot be overwritten', () => {
  const { library, save } = fixture();
  const source = save('原日', date, [visit('a', 660)]);
  const running = save('次日正在游览', next, [visit('running', 600)]);
  // Legacy persisted snapshots may carry an explicit status without an event log.
  const legacy = JSON.parse(library.serialize());
  legacy.find((plan: any) => plan.id === running.id).stops[0].status = 'visiting';
  library.loadSerialized(JSON.stringify(legacy));
  const preview = library.previewDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0 });
  assert.equal(preview.destinations[0].date, '2099-10-01');
  const raw = { ...source, stops: [visit('overnight', 1380, 900, { timeLocked: true }), visit('a', 2400)] };
  const carried = daytimePlanPreview(raw as any, [raw] as any, 'a', next);
  assert.equal(carried.destinations[0].stops[0].startMinutes, 840);
});

test('fixed, skipped and aborted visits do not migrate and impossible daytime opening hours reject unchanged', () => {
  const { library, save } = fixture();
  const source = save('原日', date, [visit('fixed', 540, 60, { lockTime: true }), visit('a', 660), visit('night-only', 840, 60, { openingIntervals: [{ startMinutes: 1200, endMinutes: 1320 }] })]);
  const before = library.serialize();
  assert.throws(() => library.previewDaytime('owner', source.id, { stopId: 'fixed', expectedRevision: 0 }), /固定时段/);
  assert.throws(() => library.previewDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0 }), /开放时段/);
  assert.equal(library.serialize(), before);
  const raw = { ...source, stops: [visit('a', 660), visit('aborted', 840), visit('skip', 900, 60, { status: 'skipped' })], executionEvents: [{ stopId: 'aborted' }] };
  const preview = daytimePlanPreview(raw as any, [raw] as any, 'a', next);
  assert.deepEqual(preview.destinations[0].stops.map(stop => stop.stopId), ['a']);
  assert.deepEqual(preview.preserved.map(stop => stop.stopId), ['aborted', 'skip']);
});

test('a changed or newly created target, an edited source, and a forged preview reject without any writes', () => {
  for (const conflict of ['target', 'source', 'created', 'forged']) {
    const { library, save } = fixture();
    const source = save('原日', date, [visit('a', 660)]);
    const target = conflict !== 'created' ? save('次日', next, [visit('existing', 540)]) : null;
    const preview = library.previewDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0 });
    if (conflict === 'target' || conflict === 'source') {
      const changed = conflict === 'target' ? target! : source;
      library.update('owner', changed.id, { name: changed.name + '变化', snapshot: changed });
    } else if (conflict === 'created') save('后来新建', next, [visit('new', 540)]);
    const before = library.serialize();
    assert.throws(() => library.applyDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0, previewKey: conflict === 'forged' ? 'fake' : preview.previewKey }), SavedPlanRevisionConflictError);
    assert.equal(library.serialize(), before);
  }
});

test('generic route buffers survive on the moved date, invalid origins and live estimates become unknown', () => {
  const { library, save } = fixture();
  const routes = [{ legId: 'old-origin', fromStopId: 'origin', toStopId: 'a', transportMode: 'walking', durationMinutes: 30 },
    { legId: 'adjacent', fromStopId: 'a', toStopId: 'b', transportMode: 'walking', durationSeconds: 1201, bufferMinutes: 5 }];
  const source = save('原日', date, [visit('a', 660), visit('b', 840)], routes, [{ chargeId: 'fare', routeLegRef: 'adjacent', amountMinor: 0, paymentStatus: 'unpaid' }]);
  const preview = library.previewDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0 });
  assert.equal(preview.destinations[0].stops[1].startMinutes, 626);
  assert.deepEqual(preview.snapshot.routeLegs.map(route => route.legId), ['adjacent']);
  library.applyDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0, previewKey: preview.previewKey });
  const target = library.list('owner').find(plan => plan.localDate === next)!;
  assert.equal(target.plannedCharges.length, 1); assert.equal(library.get('owner', source.id).plannedCharges.length, 0);
  const live = { ...source, stops: [visit('a', 660), visit('b', 840)], routeLegs: [{ ...routes[1], departureSupport: 'live' }], plannedCharges: [] };
  assert.equal(daytimePlanPreview(live as any, [live] as any, 'a', next).snapshot.routeLegs.length, 0);
});

test('dated tickets and paid or unchecked invalid traffic costs block, explicit unpaid estimates may be removed', () => {
  for (const charge of [
    { chargeId: 'ticket', stopId: 'a', date, paymentStatus: 'paid', amountMinor: 200 },
    { chargeId: 'fare', routeLegRef: 'origin', paymentStatus: 'paid', status: 'unpaid', amountMinor: 200 },
    { chargeId: 'unknown', routeLegRef: 'origin', amountMinor: 200 },
  ]) {
    const { library, save } = fixture();
    const source = save('原日', date, [visit('a', 660)], [{ legId: 'origin', fromStopId: 'origin', toStopId: 'a', transportMode: 'walking' }], [charge]);
    const before = library.serialize(); assert.throws(() => library.previewDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0 }), /费用/); assert.equal(library.serialize(), before);
  }
  const { library, save } = fixture();
  const source = save('原日', date, [visit('a', 660)], [{ legId: 'origin', fromStopId: 'origin', toStopId: 'a', transportMode: 'walking' }], [{ chargeId: 'unpaid', routeLegRef: 'origin', paymentStatus: 'unpaid', amountMinor: 200 }]);
  const preview = library.previewDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0 });
  assert.equal(preview.discardedUnpaidCharges, 1); assert.deepEqual(preview.snapshot.plannedCharges, []);
});

test('same-date morning adjustment preserves earlier facts and appointments without creating another date', () => {
  const { library, save } = fixture();
  const source = save('凌晨安排', next, [visit('a', 60), visit('appointment', 600, 60, { timeLocked: true }), visit('b', 840)]);
  const preview = library.previewDaytime('owner', source.id, { stopId: 'a', firstDate: next, expectedRevision: 0 });
  assert.equal(preview.destinations[0].stops[0].startMinutes, 660);
  library.applyDaytime('owner', source.id, { stopId: 'a', firstDate: next, expectedRevision: 0, previewKey: preview.previewKey });
  assert.equal(library.list('owner').length, 1);
  assert.equal((library.get('owner', source.id).stops.find((stop: any) => stop.stopId === 'appointment') as any).startMinutes, 600);
});

test('same-date adjustments fit a future half-hour and advance to tomorrow when daytime is already over', () => {
  const { library, save, advance } = fixture();
  const source = save('今天凌晨安排', date, [visit('a', 60)]);
  advance('2099-09-29T14:10:00+08:00');
  const afternoon = library.previewDaytime('owner', source.id, { stopId: 'a', firstDate: date, expectedRevision: 0 });
  assert.equal(afternoon.destinations[0].date, date); assert.equal(afternoon.destinations[0].stops[0].startMinutes, 870);
  advance('2099-09-29T22:00:00+08:00');
  const night = library.previewDaytime('owner', source.id, { stopId: 'a', firstDate: date, expectedRevision: 0 });
  assert.equal(night.destinations[0].date, next); assert.equal(night.destinations[0].stops[0].startMinutes, 540);
  const before = library.serialize();
  assert.throws(() => library.applyDaytime('owner', source.id, { stopId: 'a', firstDate: date, expectedRevision: 0, previewKey: afternoon.previewKey }), SavedPlanRevisionConflictError);
  assert.equal(library.serialize(), before);
});

test('a later migration conflict rolls back every destination, including already validated earlier dates', () => {
  const { library, save } = fixture();
  const source = save('原日', date, [visit('a', 660), visit('b', 840)]);
  const target = save('次日', next, [visit('existing', 540)]);
  save('后日固定预约', '2099-10-01', [visit('fixed', 600, 60, { timeLocked: true })]);
  const before = library.serialize();
  assert.throws(() => library.update('owner', source.id, { name: source.name, expectedRevision: 0,
    snapshot: { stops: [visit('a', 1440 + 660), visit('b', 2880 + 570, 60)], routeLegs: [], plannedCharges: [] } }), /固定时段/);
  assert.equal(library.serialize(), before); assert.equal(library.get('owner', target.id).revision, 0);
  const fresh = fixture();
  fresh.save('次日', next, [visit('existing', 540)]);
  fresh.save('后日固定预约', '2099-10-01', [visit('fixed', 600, 60, { timeLocked: true })]);
  const beforeNew = fresh.library.serialize();
  assert.throws(() => fresh.save('跨日新建也不可残留', date, [visit('new-a', 1440 + 660), visit('new-b', 2880 + 570)]), /固定时段/);
  assert.equal(fresh.library.serialize(), beforeNew);
});

test('daytime API refuses another owner, missing revision, past dates and non-day plans', () => {
  const { library, save } = fixture();
  const source = save('原日', date, [visit('a', 660)]);
  assert.throws(() => library.previewDaytime('other', source.id, { stopId: 'a', expectedRevision: 0 }), /不属于/);
  assert.throws(() => library.previewDaytime('owner', source.id, { stopId: 'a' }), /版本/);
  assert.throws(() => library.previewDaytime('owner', source.id, { stopId: 'a', expectedRevision: 0, firstDate: '2099-09-28' }), /有效日期/);
  const scheme = library.save('owner', { kind: 'scheme', name: '方案', days: [{ stops: [visit('a', 660)] }] });
  assert.throws(() => library.previewDaytime('owner', scheme.id, { stopId: 'a', expectedRevision: 0 }), /日计划/);
});
