import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanLibraryService } from '../src/services/plan-library.js';
import { PersonalMemoriesService } from '../src/services/personal-memories-service.js';
import type { SavedPlan } from '../src/services/plan-library.js';

const stop = (id: string, status = 'planned') => ({ stopId: id, placeId: id, place: { placeId: id, name: id }, startMinutes: 600, endMinutes: 660,
  departureMinutes: 660, plannedDurationMinutes: 60, status });
const past = (): SavedPlan => ({ id: 'old', ownerId: 'owner', kind: 'plan', name: '昨天的散步', localDate: '2026-09-19', timezone: 'Asia/Shanghai',
  cityCode: '310100', savedAt: '2026-09-19T00:00:00Z', source: 'draft', stops: [stop('a'), stop('b')], routeLegs: [], plannedCharges: [], revision: 3,
  versions: [{ revision: 2, name: '原计划', cityCode: '310100', createdAt: '2026-09-18T00:00:00Z', stops: [stop('a')], routeLegs: [], plannedCharges: [] }], executionEvents: [] });
function setup() {
  const clock = { now: '2026-09-20T10:00:00+08:00' };
  const plans = new PlanLibraryService(() => clock.now);
  plans.loadSerialized(JSON.stringify([past()]));
  return { plans, clock };
}

test('expired daily plans retain their original content, versions, and ownership in permanent history', () => {
  const { plans } = setup();
  assert.equal(plans.list('owner').some(item => item.id === 'old'), false);
  const history = plans.historyDetail('owner', 'old');
  assert.equal(history.stops.length, 2); assert.equal(history.versions?.[0].name, '原计划'); assert.equal(history.revision, 3);
  assert.equal(history.canEditHistory, true); assert.equal(history.historyEditUntilDate, '2026-10-19');
  assert.throws(() => plans.get('owner', 'old'), /找不到/);
  assert.throws(() => plans.historyDetail('other', 'old'), /不属于/);
  assert.deepEqual(plans.history('other'), []);
});

test('history archive is idempotent, survives serialized recovery, and reads never change its revision', () => {
  const { plans, clock } = setup();
  plans.list('owner'); const before = plans.historyDetail('owner', 'old');
  assert.equal(plans.purgePastDatedPlans('owner'), 0);
  const recovered = new PlanLibraryService(() => clock.now); recovered.loadSerialized(plans.serialize());
  assert.equal(recovered.history('owner').length, 1);
  assert.deepEqual(recovered.historyDetail('owner', 'old'), before);
  assert.equal(recovered.historyDetail('owner', 'old').revision, 3);
});

test('completed legacy facts and untouched partial history are not lost when one missing visit is backfilled', () => {
  const { plans } = setup(), plan = past(); plan.stops = [stop('a'), stop('b', 'completed')];
  plans.loadSerialized(JSON.stringify([plan]));
  const before = plans.historyDetail('owner', 'old');
  const updated = plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', occurredAt: '2026-09-19T11:00:00+08:00', expectedRevision: 3 });
  assert.equal((updated.stops[0] as any).status, 'completed');
  assert.deepEqual(updated.stops[1], before.stops[1]);
  assert.equal(updated.executionEvents?.length, 1);
  assert.equal((updated.stops[0] as any).actualArrivalMinutes == null, true, 'no arrival timestamp is invented');
  assert.equal(updated.revision, 4);
});

test('historical arrival and completion are committed together without modifying today or another historical stop', () => {
  const { plans } = setup();
  const today = plans.save('owner', { kind: 'plan', name: '今天', localDate: '2026-09-20', snapshot: { stops: [stop('today')], routeLegs: [], plannedCharges: [] } });
  plans.recordExecution('owner', today.id, { stopId: 'today', type: 'depart', occurredAt: '2026-09-20T09:55:00+08:00' });
  const beforeToday = structuredClone(plans.get('owner', today.id)), beforeOther = plans.historyDetail('owner', 'old').stops[1];
  const updated = plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', arrivedAt: '2026-09-19T10:15:00+08:00', occurredAt: '2026-09-19T11:45:00+08:00', expectedRevision: 3 });
  assert.deepEqual(updated.executionEvents?.map(event => event.type), ['arrive', 'complete']);
  assert.equal((updated.stops[0] as any).status, 'completed');
  assert.deepEqual(updated.stops[1], beforeOther);
  assert.deepEqual(plans.get('owner', today.id), beforeToday);
  assert.equal(plans.history('owner').length, 1);
});

test('invalid, future, wrong-day, and reversed historical timestamps leave no partial event or revision', () => {
  for (const input of [
    { occurredAt: 'not-a-date' }, { occurredAt: '2026-09-21T11:00:00+08:00' }, { occurredAt: '2026-09-18T11:00:00+08:00' },
    { arrivedAt: '2026-09-19T12:00:00+08:00', occurredAt: '2026-09-19T11:00:00+08:00' },
  ]) {
    const { plans } = setup(); const before = plans.historyDetail('owner', 'old');
    assert.throws(() => plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', expectedRevision: 3, ...input }));
    assert.deepEqual(plans.historyDetail('owner', 'old'), before);
  }
});

test('history writes require the current revision, do not permit live progress, and reject duplicate completion', () => {
  const { plans } = setup();
  assert.throws(() => plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', occurredAt: '2026-09-19T11:00:00+08:00', expectedRevision: 2 }), /变化/);
  assert.throws(() => plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'arrive' as any, occurredAt: '2026-09-19T11:00:00+08:00', expectedRevision: 3 }), /实时/);
  const updated = plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', occurredAt: '2026-09-19T11:00:00+08:00', expectedRevision: 3 });
  assert.throws(() => plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', occurredAt: '2026-09-19T11:00:00+08:00', expectedRevision: 4 }), /纠正/);
  assert.throws(() => plans.correctHistory('owner', 'old', { eventId: updated.executionEvents![0].executionEventId, status: 'visiting' as any, expectedRevision: 4 }), /实时/);
});

test('historical correction retains the original event and supports a later explicit backfill', () => {
  const { plans } = setup();
  const filled = plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', occurredAt: '2026-09-19T10:00:00+08:00', expectedRevision: 3 });
  const event = filled.executionEvents![0];
  const corrected = plans.correctHistory('owner', 'old', { eventId: event.executionEventId, status: 'planned', reason: '误记', expectedRevision: 4 });
  assert.deepEqual(corrected.executionEvents![0], event);
  assert.equal(corrected.executionEvents![1].correctsEventId, event.executionEventId);
  assert.equal((corrected.stops[0] as any).status, 'planned');
  const completed = plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', arrivedAt: '2026-09-19T10:30:00+08:00', occurredAt: '2026-09-19T11:00:00+08:00', expectedRevision: 5 });
  assert.equal(completed.executionEvents?.length, 4); assert.equal((completed.stops[0] as any).status, 'completed');
});

test('the 30-day correction cutoff follows the plan timezone and old records remain readable', () => {
  const { plans, clock } = setup();
  clock.now = '2026-10-19T23:59:00+08:00'; assert.equal(plans.historyDetail('owner', 'old').canEditHistory, true);
  clock.now = '2026-10-20T00:00:00+08:00'; assert.equal(plans.historyDetail('owner', 'old').canEditHistory, false);
  assert.throws(() => plans.backfillHistory('owner', 'old', { stopId: 'a', type: 'complete', occurredAt: '2026-09-19T11:00:00+08:00', expectedRevision: 3 }), /30 天/);
  assert.equal(plans.historyDetail('owner', 'old').stops.length, 2);
});

test('an unfinished overnight visit stays live and moves into history only after completion', () => {
  let now = '2026-09-19T22:00:00+08:00'; const plans = new PlanLibraryService(() => now);
  const saved = plans.save('owner', { kind: 'plan', name: '夜游', localDate: '2026-09-19', snapshot: { stops: [{ ...stop('night'), startMinutes: 1410, endMinutes: 1500 }], routeLegs: [], plannedCharges: [] } });
  plans.recordExecution('owner', saved.id, { stopId: 'night', type: 'arrive', occurredAt: '2026-09-19T23:30:00+08:00' });
  now = '2026-09-20T00:50:00+08:00'; assert.equal(plans.history('owner').length, 0);
  plans.recordExecution('owner', saved.id, { stopId: 'night', type: 'complete', occurredAt: now });
  assert.equal(plans.history('owner').length, 1);
  assert.deepEqual(plans.historyDetail('owner', saved.id).executionEvents?.map(event => event.type), ['arrive', 'complete']);
});

test('deleting history requires ownership and current revision and leaves reusable content alone', () => {
  const { plans } = setup(); plans.history('owner'); const reusable = plans.list('owner');
  assert.throws(() => plans.removeHistory('other', 'old', 3));
  assert.throws(() => plans.removeHistory('owner', 'old', 2));
  plans.removeHistory('owner', 'old', 3);
  assert.deepEqual(plans.history('owner'), []); assert.deepEqual(plans.list('owner'), reusable);
});

test('marking a journey snapshot changed preserves the private note and survives storage recovery', () => {
  const memories = new PersonalMemoriesService(() => '2026-09-20T00:00:00Z');
  const generated = memories.createJourney('owner', { plan: past(), places: [{ stopId: 'a', placeId: 'a', name: 'a' }], firstEventAt: null, completedAt: null, elapsedMinutes: null, generatedBy: 'expiry' });
  assert.equal(generated.ok, true); if (!generated.ok) return;
  const original = generated.value;
  memories.markJourneyChanged('owner', 'old');
  const recovered = new PersonalMemoriesService(); recovered.loadSerialized(memories.serialize());
  const note = recovered.list('owner')[0];
  assert.equal(note.userText, original.userText); assert.deepEqual(note.journey, original.journey);
  assert.ok(note.staleAt); assert.equal(note.entryVersion, original.entryVersion + 1);
  const edited = recovered.patch('owner', note.memoryId, { userText: '那天的感受\n依然记得很开心。' });
  assert.equal(edited.ok, true); if (!edited.ok) return;
  assert.equal(edited.value.userText, '那天的感受\n依然记得很开心。');
  assert.deepEqual(edited.value.journey, original.journey, 'editing feelings never rewrites the old route snapshot');
  assert.equal(edited.value.staleAt, note.staleAt, 'editing feelings cannot make an old snapshot current again');
});
