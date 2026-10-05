import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { buildDemoPlanSnapshot } from '../src/demo/demo-data.js';
import { makeStop } from './helpers.js';

function createTripWithStops(service: InMemoryTripService, actorId: string) {
  const created = service.createTrip(actorId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
    partySize: 2,
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('create failed');
  const tripId = created.value.trip.tripId;
  const patched = service.patchTrip(actorId, tripId, {
    expectedRevision: 0,
    stops: [
      makeStop({ stopId: 'a', startMinutes: 9 * 60 }),
      makeStop({ stopId: 'b', startMinutes: 11 * 60 }),
    ],
  });
  assert.equal(patched.ok, true);
  if (!patched.ok) throw new Error('patch failed');
  return { tripId, revision: patched.value.trip.revision };
}

test('past day plans and progress are removed from current and historical snapshots', () => {
  let now = '2026-09-19T09:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-19', dataMode: 'demo', partySize: 2,
  });
  assert.ok(created.ok); if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const planned = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [
      makeStop({ stopId: 'yesterday-stop', date: '2026-09-19', startMinutes: 9 * 60 }),
      makeStop({ stopId: 'tomorrow-stop', date: '2026-09-20', startMinutes: 10 * 60 }),
    ],
  });
  assert.ok(planned.ok); if (!planned.ok) return;
  const completed = service.recordExecution({
    actorId: principal.principalId, sessionId: session.sessionId, tripId,
    stopId: 'yesterday-stop', type: 'complete', occurredAt: now,
    expectedRevision: planned.value.trip.revision,
  });
  assert.ok(completed.ok); if (!completed.ok) return;

  const spend = service.recordSpend({
    actorId: principal.principalId, tripId, amountMinor: 4200,
    completenessConfirmed: true, occurredAt: now,
    expectedRevision: completed.value.trip.revision,
  });
  assert.ok(spend.ok); if (!spend.ok) return;
  const walking = service.recordWalking({
    actorId: principal.principalId, tripId, walkingMeters: 1800,
    completenessConfirmed: true, occurredAt: now,
    expectedRevision: spend.value.trip.revision,
  });
  assert.ok(walking.ok); if (!walking.ok) return;

  now = '2026-09-20T09:00:00+08:00';
  const current = service.getTrip(principal.principalId, tripId);
  assert.ok(current.ok); if (!current.ok) return;
  assert.equal(current.value.snapshot.stops?.length, 1);
  assert.equal(current.value.snapshot.stops?.[0].stopId, 'tomorrow-stop');
  assert.equal(current.value.snapshot.executionEvents?.length, 0);
  assert.equal(current.value.snapshot.planningStatus, walking.value.snapshot.planningStatus);
  assert.equal(current.value.snapshot.spendEvents?.length, 0);
  assert.equal(current.value.snapshot.walkingEvents?.length, 0);
  assert.equal(current.value.snapshot.actualSpendMinor, null);
  assert.equal(current.value.snapshot.actualWalkingMeters, null);
  assert.equal(current.value.trip.revision, walking.value.trip.revision + 1);

  const oldVersion = service.getVersion(principal.principalId, tripId, planned.value.trip.revision);
  assert.ok(oldVersion.ok); if (!oldVersion.ok) return;
  assert.deepEqual(oldVersion.value.snapshot.stops?.map(stop => stop.stopId), ['tomorrow-stop']);
  assert.equal(oldVersion.value.snapshot.executionEvents?.length, 0);
});

test('a started stop remains available across midnight until the overnight visit is completed', () => {
  let now = '2026-09-19T23:50:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-19', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;
  const planned = service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [makeStop({ stopId: 'overnight-stop', date: '2026-09-19', startMinutes: 23 * 60 + 50, endMinutes: 25 * 60, departureMinutes: 25 * 60 })],
  });
  assert.ok(planned.ok); if (!planned.ok) return;
  const departed = service.recordExecution({
    actorId: principal.principalId, sessionId: session.sessionId, tripId: created.value.trip.tripId,
    stopId: 'overnight-stop', type: 'depart', occurredAt: now, expectedRevision: planned.value.trip.revision,
  });
  assert.ok(departed.ok); if (!departed.ok) return;

  now = '2026-09-20T00:10:00+08:00';
  const continued = service.getTrip(principal.principalId, created.value.trip.tripId);
  assert.ok(continued.ok); if (!continued.ok) return;
  assert.equal(continued.value.snapshot.stops?.[0].status, 'en_route');
  assert.equal(continued.value.snapshot.executionEvents?.length, 1);
  const arrived = service.recordExecution({
    actorId: principal.principalId, sessionId: session.sessionId, tripId: created.value.trip.tripId,
    stopId: 'overnight-stop', type: 'arrive', occurredAt: now, expectedRevision: continued.value.trip.revision,
  });
  assert.ok(arrived.ok, `expiry maintenance must retain the in-progress stop and its depart event: ${JSON.stringify(arrived)}`);
  if (!arrived.ok) return;
  assert.equal(arrived.value.snapshot.stops?.[0].status, 'visiting');
  assert.equal(arrived.value.snapshot.executionEvents?.length, 2);
});

test('future timestamps are rejected for progress corrections, spend and walking facts', () => {
  const now = '2026-09-20T09:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const { tripId, revision } = createTripWithStops(service, principal.principalId);
  const departed = service.recordExecution({
    actorId: principal.principalId, sessionId: session.sessionId, tripId,
    stopId: 'a', type: 'depart', occurredAt: now, expectedRevision: revision,
  });
  assert.ok(departed.ok); if (!departed.ok) return;
  const future = '2026-09-20T10:00:00+08:00';
  const correction = service.recordExecutionCorrection({
    actorId: principal.principalId, tripId, eventIdToCorrect: departed.value.snapshot.executionEvents?.[0].executionEventId || '',
    type: 'complete', statusOverride: 'completed', occurredAt: future, expectedRevision: departed.value.trip.revision,
  });
  assert.equal(correction.ok, false);
  if (!correction.ok) assert.equal(correction.error.code, 'EXECUTION_DATE_CONFLICT');
  const spend = service.recordSpend({
    actorId: principal.principalId, tripId, amountMinor: 100, completenessConfirmed: true,
    occurredAt: future, expectedRevision: departed.value.trip.revision,
  });
  assert.equal(spend.ok, false);
  if (!spend.ok) assert.equal(spend.error.code, 'EXECUTION_DATE_CONFLICT');
  const walking = service.recordWalking({
    actorId: principal.principalId, tripId, walkingMeters: 100, completenessConfirmed: true,
    occurredAt: future, expectedRevision: departed.value.trip.revision,
  });
  assert.equal(walking.ok, false);
  if (!walking.ok) assert.equal(walking.error.code, 'EXECUTION_DATE_CONFLICT');
});

test('a city cannot change after an active trip has recorded progress', () => {
  let now = '2026-09-20T09:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const { tripId, revision } = createTripWithStops(service, principal.principalId);
  const departed = service.recordExecution({
    actorId: principal.principalId, sessionId: session.sessionId, tripId,
    stopId: 'a', type: 'depart', occurredAt: now, expectedRevision: revision,
  });
  assert.ok(departed.ok); if (!departed.ok) return;
  const changed = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: departed.value.trip.revision,
    cityCode: '310100',
  });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, 'INVALID_TRIP_STATE');
  const unchanged = service.getTrip(principal.principalId, tripId);
  assert.ok(unchanged.ok);
  if (unchanged.ok) assert.equal(unchanged.value.trip.cityCode, '330100');
});

test('first valid progress starts recording atomically without a manual start', () => {
  for (const type of ['complete', 'depart', 'arrive', 'skip'] as const) {
    const service = new InMemoryTripService(() => '2026-09-20T09:00:00+08:00');
    const {principal,session} = service.createAnonymousSession();
    const {tripId,revision} = createTripWithStops(service,principal.principalId);
    const command = {actorId:principal.principalId,sessionId:session.sessionId,tripId,expectedRevision:revision,occurredAt:'2026-09-20T09:00:00+08:00'};
    assert.equal(service.recordExecution({...command,stopId:'missing',type}).ok,false);
    const recorded=service.recordExecution({...command,stopId:'a',type});
    assert.ok(recorded.ok);
    if (!recorded.ok) return;
    assert.equal(recorded.value.trip.lifecycle,'active');
    assert.equal(recorded.value.trip.revision,revision+1);
    assert.equal(recorded.value.trip.contentRevision,1);
    assert.equal(recorded.value.snapshot.stops![0].status,({complete:'completed',depart:'en_route',arrive:'visiting',skip:'skipped'})[type]);
  }
});

test('date-pending trips reject future execution timestamps and report an unknown clock', () => {
  const now = '2026-09-20T08:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, { cityCode: '330100', dataMode: 'demo' });
  assert.ok(created.ok); if (!created.ok) return;
  assert.equal(created.value.trip.localDate, undefined);
  assert.equal(created.value.snapshot.travelDate, undefined);
  assert.equal(created.value.clock?.relation, 'unknown');
  const patched = service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [makeStop({ stopId: 'unbound', startMinutes: 9 * 60 })],
  });
  assert.ok(patched.ok); if (!patched.ok) return;
  const future = service.recordExecution({
    actorId: principal.principalId, sessionId: session.sessionId, tripId: created.value.trip.tripId,
    stopId: 'unbound', type: 'depart', occurredAt: '2026-09-20T09:00:00+08:00',
    expectedRevision: patched.value.trip.revision,
  });
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.error.code, 'EXECUTION_DATE_CONFLICT');
});

test('session validation binds the token and maintenance removes expired or revoked sessions', () => {
  let now = '2026-09-20T09:00:00.000Z';
  const service = new InMemoryTripService(() => now);
  const short = service.createAnonymousSession(1);
  assert.equal(service.validateSession(short.principal.principalId, short.session.sessionId, short.token), true);
  assert.equal(service.validateSession(short.principal.principalId, short.session.sessionId, 'wrong-token'), false);

  now = '2026-09-20T09:00:02.000Z';
  assert.equal(service.purgePastProgress(), 1);
  assert.equal(service.validateSession(short.principal.principalId, short.session.sessionId, short.token), false);

  const revoked = service.createAnonymousSession();
  assert.equal(service.revokeSession(revoked.session.sessionId).ok, true);
  assert.equal(service.purgePastProgress(), 1);
  assert.equal(service.validateSession(revoked.principal.principalId, revoked.session.sessionId, revoked.token), false);
});

test('completed progress can create an idempotent route memory with places and actual elapsed time', () => {
  let now = '2026-09-20T09:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo', partySize: 2,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const plan = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [makeStop({ stopId: 'river_stop', placeId: 'river_walk' }), makeStop({ stopId: 'garden_stop', placeId: 'quiet_garden', startMinutes: 10 * 60 })],
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  const record = (stopId: string, type: 'depart' | 'arrive' | 'complete', at: string) => {
    now = at;
    const result = service.recordExecution({ actorId: principal.principalId, sessionId: session.sessionId, tripId, stopId, type, occurredAt: at });
    assert.equal(result.ok, true, `record ${type} at ${stopId}: ${JSON.stringify(result)}`);
  };
  record('river_stop', 'depart', '2026-09-20T09:00:00+08:00');
  record('river_stop', 'arrive', '2026-09-20T09:15:00+08:00');
  record('river_stop', 'complete', '2026-09-20T10:00:00+08:00');
  record('garden_stop', 'depart', '2026-09-20T10:10:00+08:00');
  record('garden_stop', 'arrive', '2026-09-20T10:30:00+08:00');
  record('garden_stop', 'complete', '2026-09-20T11:00:00+08:00');

  const generated = service.generateJourneyMemory(principal.principalId, tripId, '2026-09-20');
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  const memory = generated.value.memory;
  if (!memory?.journey) return;
  const journey = memory.journey;
  assert.deepEqual(journey.places.map(place => place.name), ['river_walk', 'quiet_garden']);
  assert.deepEqual(journey.places.map(place => place.visitMinutes), [45, 30]);
  assert.equal(journey.elapsedMinutes, 120);
  assert.match(memory.userText, /river_walk、quiet_garden/);
  assert.match(memory.userText, /相隔 2 小时/);
  const duplicate = service.generateJourneyMemory(principal.principalId, tripId, '2026-09-20');
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) assert.equal(duplicate.value.memory?.memoryId, memory.memoryId);
  const listed = service.listMemories(principal.principalId, tripId);
  assert.equal(listed.ok, true);
  if (listed.ok) assert.equal(listed.value.filter(entry => entry?.journey?.localDate === '2026-09-20').length, 1);

  const completedEvent = generated.value.trip.snapshot.executionEvents?.find(event =>
    event.stopId === 'garden_stop' && event.type === 'complete',
  );
  assert.ok(completedEvent);
  if (!completedEvent) return;
  const corrected = service.recordExecutionCorrection({
    actorId: principal.principalId,
    tripId,
    eventIdToCorrect: completedEvent.executionEventId,
    type: 'arrive',
    statusOverride: 'visiting',
    expectedRevision: duplicate.ok ? duplicate.value.trip.trip.revision : generated.value.trip.trip.revision,
  });
  assert.equal(corrected.ok, true);
  const afterCorrection = service.listMemories(principal.principalId, tripId);
  assert.equal(afterCorrection.ok, true);
  if (afterCorrection.ok) {
    const correctedMemory = afterCorrection.value.find(entry => entry?.memoryId === memory.memoryId);
    assert.equal(correctedMemory?.staleAt, now);
    assert.equal(correctedMemory?.userText, memory.userText);
  }
});

test('expired completed progress automatically becomes one saved journey memory before cleanup', () => {
  let now = '2026-09-20T09:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo', partySize: 2,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const plan = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [makeStop({ stopId: 'river_stop', placeId: 'river_walk' }), makeStop({ stopId: 'garden_stop', placeId: 'quiet_garden', startMinutes: 10 * 60 })],
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const record = (stopId: string, type: 'depart' | 'arrive' | 'complete', at: string) => {
    now = at;
    const result = service.recordExecution({ actorId: principal.principalId, sessionId: session.sessionId, tripId, stopId, type, occurredAt: at });
    assert.equal(result.ok, true, `record ${type} at ${stopId}: ${JSON.stringify(result)}`);
  };
  record('river_stop', 'depart', '2026-09-20T09:00:00+08:00');
  record('river_stop', 'arrive', '2026-09-20T09:15:00+08:00');
  record('river_stop', 'complete', '2026-09-20T10:00:00+08:00');
  record('garden_stop', 'depart', '2026-09-20T10:10:00+08:00');
  record('garden_stop', 'arrive', '2026-09-20T10:30:00+08:00');
  record('garden_stop', 'complete', '2026-09-20T11:00:00+08:00');

  now = '2026-09-21T08:00:00+08:00';
  const listed = service.listMemories(principal.principalId, tripId);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const generated = listed.value.filter(entry => entry?.journey?.localDate === '2026-09-20');
  assert.equal(generated.length, 1);
  const memory = generated[0];
  assert.ok(memory);
  if (!memory?.journey) return;
  assert.equal(memory.journey.generatedBy, 'expiry');
  assert.equal(memory.journey.elapsedMinutes, 120);
  assert.deepEqual(memory.journey.places.map(place => place.name), ['river_walk', 'quiet_garden']);
  service.listMemories(principal.principalId, tripId);
  const afterSecondRead = service.listMemories(principal.principalId, tripId);
  assert.equal(afterSecondRead.ok, true);
  if (afterSecondRead.ok) assert.equal(afterSecondRead.value.filter(entry => entry?.journey?.localDate === '2026-09-20').length, 1);
});

test('start, execution facts, finish and archive keep lifecycle and content revisions separate', () => {
  let now = '2026-09-20T09:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const { tripId, revision } = createTripWithStops(service, principal.principalId);

  const started = service.startTrip(principal.principalId, tripId, revision);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.value.trip.lifecycle, 'active');
  assert.equal(started.value.trip.contentRevision, 0);

  const departed = service.recordExecution({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    stopId: 'a',
    type: 'depart',
    occurredAt: '2026-09-20T09:00:00+08:00',
    expectedRevision: started.value.trip.revision,
  });
  assert.equal(departed.ok, true);
  if (!departed.ok) return;
  assert.equal(departed.value.trip.contentRevision, 1);

  const finishEarly = service.finishTrip(principal.principalId, tripId, departed.value.trip.revision);
  assert.equal(finishEarly.ok, false);
  assert.equal(finishEarly.error?.code, 'INVALID_TRIP_STATE');

  now = '2026-09-20T09:05:00+08:00';
  const arrived = service.recordExecution({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    stopId: 'a',
    type: 'arrive',
    occurredAt: '2026-09-20T09:05:00+08:00',
    expectedRevision: departed.value.trip.revision,
  });
  assert.equal(arrived.ok, true);
  if (!arrived.ok) return;
  now = '2026-09-20T09:30:00+08:00';
  const completed = service.recordExecution({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    stopId: 'a',
    type: 'complete',
    occurredAt: '2026-09-20T09:30:00+08:00',
    expectedRevision: arrived.value.trip.revision,
  });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.value.trip.contentRevision, 3);

  const finishWithPendingStop = service.finishTrip(principal.principalId, tripId, completed.value.trip.revision);
  assert.equal(finishWithPendingStop.ok, false);
  assert.equal(finishWithPendingStop.error?.code, 'INVALID_TRIP_STATE');

  now = '2026-09-20T09:31:00+08:00';
  const skipped = service.recordExecution({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    stopId: 'b',
    type: 'skip',
    occurredAt: '2026-09-20T09:31:00+08:00',
    expectedRevision: completed.value.trip.revision,
  });
  assert.equal(skipped.ok, true);
  if (!skipped.ok) return;

  const finished = service.finishTrip(principal.principalId, tripId, skipped.value.trip.revision);
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.value.trip.lifecycle, 'completed');
  assert.equal(finished.value.trip.contentRevision, 4);

  const postFinishExecution = service.recordExecution({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    stopId: 'b',
    type: 'complete',
    occurredAt: '2026-09-20T09:32:00+08:00',
  });
  assert.equal(postFinishExecution.ok, false);
  assert.equal(postFinishExecution.error?.code, 'INVALID_TRIP_STATE');

  const skippedEvent = skipped.value.snapshot.executionEvents?.find(event => event.stopId === 'b');
  assert.ok(skippedEvent);
  if (!skippedEvent) return;
  const reopenFinishedStop = service.recordExecutionCorrection({
    actorId: principal.principalId,
    tripId,
    eventIdToCorrect: skippedEvent.executionEventId,
    type: 'skip',
    statusOverride: 'planned',
    expectedRevision: finished.value.trip.revision,
  });
  assert.equal(reopenFinishedStop.ok, false);
  assert.equal(reopenFinishedStop.error?.code, 'INVALID_TRIP_STATE');

  const correctFinishedStop = service.recordExecutionCorrection({
    actorId: principal.principalId,
    tripId,
    eventIdToCorrect: skippedEvent.executionEventId,
    type: 'complete',
    statusOverride: 'completed',
    expectedRevision: finished.value.trip.revision,
  });
  assert.equal(correctFinishedStop.ok, true);
  if (!correctFinishedStop.ok) return;
  assert.equal(correctFinishedStop.value.snapshot.stops?.find(stop => stop.stopId === 'b')?.status, 'completed');

  const archived = service.archiveTrip(principal.principalId, tripId, correctFinishedStop.value.trip.revision);
  assert.equal(archived.ok, true);
  if (archived.ok) assert.equal(archived.value.trip.lifecycle, 'archived');
});

test('clone clears execution facts, spend and location references while preserving plan shape', () => {
  let now = '2026-09-20T08:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal } = service.createAnonymousSession();
  const { tripId } = createTripWithStops(service, principal.principalId);
  now = '2026-09-20T14:00:00+08:00';
  const spent = service.recordSpend({
    actorId: principal.principalId,
    tripId,
    amountMinor: 8000,
    completenessConfirmed: true,
    occurredAt: '2026-09-20T13:00:00+08:00',
  });
  assert.equal(spent.ok, true);
  if (!spent.ok) return;

  const cloned = service.cloneTrip(principal.principalId, tripId);
  assert.equal(cloned.ok, true);
  if (!cloned.ok) return;
  assert.equal(cloned.value.trip.lifecycle, 'draft');
  assert.equal(cloned.value.trip.revision, 0);
  assert.equal(cloned.value.trip.contentRevision, 0);
  assert.equal(cloned.value.snapshot.actualSpendMinor, null);
  assert.equal(cloned.value.snapshot.spendEvents?.length, 0);
  assert.equal(cloned.value.snapshot.stops?.length, 2);
});

test('cloning a completed trip resets its lifecycle and remaps all internal references', () => {
  let now = '2026-09-20T08:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const plan = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [makeStop({ stopId: 'first' }), makeStop({ stopId: 'second', startMinutes: 11 * 60 })],
    routeLegs: [
      { legId: 'leg-first', fromStopId: 'origin', toStopId: 'first', transportMode: 'walking', durationMinutes: 10 },
      { legId: 'leg-second', fromStopId: 'first', toStopId: 'second', transportMode: 'transit', durationMinutes: 20 },
    ],
    constraints: [{ constraintId: 'keep-first', kind: 'retain_stop', payload: { stopId: 'first' } }],
    plannedCharges: [{ chargeId: 'ticket', stopId: 'second', routeLegRef: 'leg-second', quantity: 1,
      costEstimate: { currency: 'CNY', basis: 'party', lowerMinor: 1000, upperMinor: 1000, certainty: 'known' },
      paymentStatus: 'paid', includedSpendEventId: 'old-spend' }],
  });
  assert.ok(plan.ok); if (!plan.ok) return;
  const started = service.startTrip(principal.principalId, tripId, plan.value.trip.revision);
  assert.ok(started.ok); if (!started.ok) return;
  now = '2026-09-20T09:30:00+08:00';
  const completed = service.recordExecution({ actorId: principal.principalId, sessionId: session.sessionId, tripId,
    stopId: 'first', type: 'complete', occurredAt: now });
  assert.ok(completed.ok); if (!completed.ok) return;
  now = '2026-09-20T09:32:00+08:00';
  const skipped = service.recordExecution({ actorId: principal.principalId, sessionId: session.sessionId, tripId,
    stopId: 'second', type: 'skip', occurredAt: now });
  assert.ok(skipped.ok); if (!skipped.ok) return;
  const finished = service.finishTrip(principal.principalId, tripId, skipped.value.trip.revision);
  assert.ok(finished.ok); if (!finished.ok) return;
  assert.equal(finished.value.trip.lifecycle, 'completed');

  const cloned = service.cloneTrip(principal.principalId, tripId);
  assert.ok(cloned.ok); if (!cloned.ok) return;
  assert.equal(cloned.value.trip.lifecycle, 'draft');
  assert.deepEqual(cloned.value.snapshot.stops?.map(stop => stop.status), ['planned', 'planned']);
  const clonedStops = cloned.value.snapshot.stops || [];
  const clonedLegs = cloned.value.snapshot.routeLegs || [];
  assert.equal(clonedLegs[1].fromStopId, clonedStops[0].stopId);
  assert.equal(clonedLegs[1].toStopId, clonedStops[1].stopId);
  assert.equal(cloned.value.snapshot.constraints?.[0].kind === 'retain_stop' &&
    cloned.value.snapshot.constraints[0].payload.stopId, clonedStops[0].stopId);
  assert.equal(cloned.value.snapshot.plannedCharges?.[0].stopId, clonedStops[1].stopId);
  assert.equal(cloned.value.snapshot.plannedCharges?.[0].routeLegRef, clonedLegs[1].legId);
  assert.equal(cloned.value.snapshot.plannedCharges?.[0].paymentStatus, 'unpaid');
  assert.equal(cloned.value.snapshot.plannedCharges?.[0].includedSpendEventId, null);
  const cloneStarted = service.startTrip(principal.principalId, cloned.value.trip.tripId, cloned.value.trip.revision);
  assert.equal(cloneStarted.ok, true);
});

test('delete makes the trip unavailable to future reads and invalidates pending actions', () => {
  const service = new InMemoryTripService(() => '2026-09-20T08:00:00+08:00');
  const { principal } = service.createAnonymousSession();
  const { tripId } = createTripWithStops(service, principal.principalId);
  const proposal = service.createProposal(principal.principalId, tripId, {
    kind: 'replan',
    baseRevision: 1,
    candidates: [
      {
        candidateId: 'c1',
        title: 'x',
        summary: 'x',
        snapshot: buildDemoPlanSnapshot({
          tripId,
          dataMode: 'demo',
          timezone: 'Asia/Shanghai',
          travelDate: '2026-09-20',
          dayStartMinutes: 9 * 60,
          partySize: 2,
        }),
      },
    ],
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const request = proposal.value.actionRequests[0];
  assert.ok(request);
  if (!request) return;
  assert.equal(request.status, 'pending');

  const deleted = service.deleteTrip(principal.principalId, tripId);
  assert.equal(deleted.ok, true);
  assert.equal(service.getTrip(principal.principalId, tripId).ok, false);
  assert.equal(service.authorization.getRequest(request.actionRequestId)?.status, 'cancelled');
});

test('deleting an expired trip does not archive its planned stops, now or during background cleanup', () => {
  let now = '2026-09-19T09:00:00+08:00';
  const archived: unknown[] = [];
  const service = new InMemoryTripService(() => now, { archiveExpiredPlanDay: day => archived.push(day) });
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-19', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;
  const planned = service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [makeStop({ stopId: 'deleted-plan', date: '2026-09-19' })],
  });
  assert.ok(planned.ok); if (!planned.ok) return;
  now = '2026-09-20T00:30:00+08:00';

  assert.equal(service.deleteTrip(principal.principalId, created.value.trip.tripId).ok, true);
  assert.equal(archived.length, 0, 'delete must not create a saved copy as a side effect');
  service.purgePastProgress();
  assert.equal(archived.length, 0, 'background maintenance must ignore deleted trips');
});

