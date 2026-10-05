import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlanBoundary, preserveExecutedStops, tripClock } from '../src/domain/plan-boundaries.js';
import { applyProposal } from '../src/domain/versioning.js';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { makeSnapshot, makeStop } from './helpers.js';
import { normalizePlanStop, normalizeTripSnapshot } from '../src/domain/normalize.js';

test('explicit departure respects the previous active stop and route duration', () => {
  const first = makeStop({stopId:'first', startMinutes:540, endMinutes:600, departureMinutes:600});
  const next = makeStop({stopId:'next', travelStartMinutes:620, startMinutes:650, endMinutes:710, departureMinutes:710});
  const snapshot = makeSnapshot({stops:[first,next], routeLegs:[]});
  const now = '2026-09-19T00:00:00Z';
  assert.equal(checkPlanBoundary(snapshot, snapshot, now), null);
  const delayed = {...snapshot, stops:[{...first,endMinutes:640,departureMinutes:640},next]};
  assert.ok(checkPlanBoundary(snapshot, delayed, now)?.includes('上一站'));
  const skipped = {...first,status:'skipped' as const};
  const withSkipped = {...snapshot,stops:[skipped,next]};
  assert.equal(checkPlanBoundary(withSkipped, withSkipped, now), null);
  const routed = makeSnapshot({...snapshot, routeLegs:[{legId:'route',fromStopId:'first',toStopId:'next',transportMode:'walking',durationMinutes:40}]});
  assert.ok(checkPlanBoundary(snapshot, routed, now)?.includes('交通时长'));
  routed.routeLegs![0].durationMinutes = 30;
  assert.equal(checkPlanBoundary(snapshot, routed, now), null);
});

test('clock uses the trip timezone, distinguishes travel dates, and never completes stops', () => {
  const snapshot = makeSnapshot({ stops: [makeStop({ stopId: 'late', startMinutes: 540 })] });
  const original = structuredClone(snapshot);
  assert.equal(tripClock(snapshot, '2026-09-20T05:00:00Z').minutes, 780);
  assert.equal(tripClock(snapshot, '2026-09-19T16:01:00Z').relation, 'today');
  assert.equal(tripClock({ ...snapshot, timezone: 'America/New_York' }, '2026-09-19T16:01:00Z').relation, 'future');
  assert.equal(checkPlanBoundary(snapshot, snapshot, '2026-09-21T05:00:00Z'), null);
  assert.deepEqual(snapshot, original);
  const changed = { ...snapshot, stops: [makeStop({ stopId: 'late', startMinutes: 600 })] };
  assert.ok(checkPlanBoundary(snapshot, changed, '2026-09-20T05:00:00Z'));
  assert.equal(checkPlanBoundary(snapshot, changed, '2026-09-19T05:00:00Z'), null);
  assert.equal(checkPlanBoundary(snapshot, { ...changed, stops: [makeStop({ stopId: 'late', startMinutes: 840 })] }, '2026-09-20T05:00:00Z'), null);
});

test('station date changes are checked; omitted dates follow the trip while explicit dates stay independent', () => {
  const current = makeSnapshot({
    travelDate: '2026-09-19',
    stops: [makeStop({ stopId: 'day-one', startMinutes: 10 * 60 })],
  });
  const movedToPast = {
    ...current,
    stops: [{ ...current.stops![0], date: '2026-09-18' }],
  };
  assert.ok(checkPlanBoundary(current, movedToPast, '2026-09-19T08:00:00+08:00')?.includes('当前时间之前'));

  const movedToFuture = {
    ...current,
    stops: [{ ...current.stops![0], date: '2026-09-20' }],
  };
  assert.equal(checkPlanBoundary(current, movedToFuture, '2026-09-19T08:00:00+08:00'), null);

  const invalid = {
    ...current,
    stops: [{ ...current.stops![0], date: '2026-02-31' }],
  };
  assert.ok(checkPlanBoundary(current, invalid, '2026-09-19T08:00:00+08:00')?.includes('日期无效'));

  const normalized = normalizeTripSnapshot({
    ...current,
    stops: [
      makeStop({ stopId: 'implicit' }),
      makeStop({ stopId: 'explicit', date: '2026-09-22' }),
    ],
  });
  assert.equal(normalized.stops[0].date, undefined, '缺省日期应继续跟随旅行日期');
  assert.equal(normalized.stops[1].date, '2026-09-22', '显式日期应保留');
});

test('travel-time boundaries reset at a new itinerary day', () => {
  const dayOne = makeStop({ stopId: 'day-one-last', date: '2026-09-20', startMinutes: 17 * 60, endMinutes: 18 * 60, departureMinutes: 18 * 60 });
  const dayTwo = makeStop({ stopId: 'day-two-first', date: '2026-09-21', travelStartMinutes: 8 * 60, startMinutes: 9 * 60, endMinutes: 10 * 60 });
  const snapshot = makeSnapshot({ travelDate: '2026-09-20', stops: [dayOne, dayTwo] });
  assert.equal(checkPlanBoundary(snapshot, snapshot, '2026-09-19T08:00:00+08:00'), null);
});

test('the legacy 21:00 day-end value no longer blocks later same-day plans', () => {
  const current = makeSnapshot({
    travelDate: '2026-09-20',
    dayEndMinutes: 21 * 60,
    stops: [],
  });
  const next = {
    ...current,
    stops: [makeStop({ stopId: 'late', startMinutes: 22 * 60, endMinutes: 23 * 60 + 30 })],
  };

  assert.equal(checkPlanBoundary(current, next, '2026-09-19T08:00:00+08:00'), null);
});

test('trip plan edits accept a valid schedule after 21:00', () => {
  const service = new InMemoryTripService(() => '2026-09-19T08:00:00+08:00');
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;

  const saved = service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [makeStop({ stopId: 'late', startMinutes: 22 * 60, endMinutes: 23 * 60 + 30 })],
  });

  assert.equal(saved.ok, true);
});

test('a stop may end after midnight while its start remains on the selected date', () => {
  const current = makeSnapshot({ travelDate: '2026-09-20', stops: [] });
  const overnight = {
    ...current,
    stops: [makeStop({ stopId: 'invalid', startMinutes: 23 * 60 + 30, endMinutes: 24 * 60 + 30 })],
  };
  const invalid = {
    ...current,
    stops: [makeStop({ stopId: 'invalid', startMinutes: 23 * 60 + 30, endMinutes: 23 * 60 })],
  };

  assert.equal(checkPlanBoundary(current, overnight, '2026-09-19T08:00:00+08:00'), null);
  assert.match(checkPlanBoundary(current, invalid, '2026-09-19T08:00:00+08:00') ?? '', /时间安排无效/);
});

test('changing trip date moves implicit stations and rejects an explicit station once its time is past', () => {
  let now = '2026-09-19T08:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const patched = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: 0,
    stops: [
      makeStop({ stopId: 'implicit', startMinutes: 10 * 60 }),
      makeStop({ stopId: 'explicit', date: '2026-09-22', startMinutes: 9 * 60 }),
    ],
  });
  assert.ok(patched.ok); if (!patched.ok) return;

  const moved = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: patched.value.trip.revision,
    localDate: '2026-09-21',
  });
  assert.ok(moved.ok); if (!moved.ok) return;
  assert.equal(moved.value.snapshot.travelDate, '2026-09-21');
  assert.equal(moved.value.snapshot.stops?.[0].date, undefined);
  assert.equal(moved.value.snapshot.stops?.[1].date, '2026-09-22');

  now = '2026-09-22T10:00:00+08:00';
  const afterExpiry = service.getTrip(principal.principalId, tripId);
  assert.ok(afterExpiry.ok); if (!afterExpiry.ok) return;
  assert.deepEqual(afterExpiry.value.snapshot.stops?.map(stop => stop.stopId), ['explicit']);
  const pastExplicitStation = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: afterExpiry.value.trip.revision,
    localDate: '2026-09-23',
  });
  assert.equal(pastExplicitStation.ok, false);
  if (!pastExplicitStation.ok) assert.equal(pastExplicitStation.error.code, 'PLAN_TIME_OR_PROGRESS_CONFLICT');
});

test('trip date patch rejects malformed calendar dates without changing the revision', () => {
  const service = new InMemoryTripService(() => '2026-09-19T08:00:00+08:00');
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo',
  });
  assert.ok(created.ok); if (!created.ok) return;

  for (const localDate of ['', '2026-02-30', '9999-99-99', '2026/09/21']) {
    const patched = service.patchTrip(principal.principalId, created.value.trip.tripId, {
      expectedRevision: 0, localDate,
    });
    assert.equal(patched.ok, false);
    if (!patched.ok) assert.equal(patched.error.code, 'INVALID_INPUT');
  }
  const unchanged = service.getTrip(principal.principalId, created.value.trip.tripId);
  assert.ok(unchanged.ok);
  if (unchanged.ok) {
    assert.equal(unchanged.value.trip.revision, 0);
    assert.equal(unchanged.value.snapshot.travelDate, '2026-09-20');
  }
});

test('date-pending trips stay unknown instead of becoming 1970 and allow planning without a bound date', () => {
  const normalized = normalizeTripSnapshot({ tripId: 'pending', stops: [makeStop({ stopId: 'x' })] });
  assert.equal(normalized.travelDate, undefined);
  assert.equal(normalized.stops[0].date, undefined);
  assert.equal(tripClock(normalized, '2026-09-19T08:00:00+08:00').relation, 'unknown');
  assert.equal(checkPlanBoundary(normalized, normalized, '2026-09-19T08:00:00+08:00'), null);
});

test('completed stops cannot be dropped or rewritten and candidates cannot invent completion', () => {
  const done = makeStop({ stopId: 'done', status: 'completed', startMinutes: 540 });
  const current = makeSnapshot({ stops: [done] });
  const future = makeStop({ stopId: 'future', startMinutes: 840, status: 'completed' });
  const kept = preserveExecutedStops([future], current.stops);
  assert.deepEqual(kept[0], done);
  assert.equal(kept[1].status, 'planned');
  kept[0].startMinutes = 999;
  assert.equal(done.startMinutes, 540, 'candidate must not share mutable history');
  assert.ok(checkPlanBoundary(current, makeSnapshot({ stops: [] }), '2026-09-20T05:00:00Z'));
  assert.ok(checkPlanBoundary(current, makeSnapshot({ stops: [done, future] }), '2026-09-20T05:00:00Z'));
  const candidate = makeSnapshot({ stops: preserveExecutedStops([future], current.stops) });
  const result = applyProposal({ proposalId: 'p', tripId: current.tripId, kind: 'replan', status: 'ready', baseRevision: 0,
    createdAt: '2026-09-20T05:00:00Z', expiresAt: '2026-09-20T05:05:00Z', candidates: [{ candidateId: 'c', title: '调整', summary: '', snapshot: candidate, checks: [] }] }, current, '2026-09-20T05:00:00Z');
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (result.ok) assert.deepEqual(result.version.snapshot.stops?.[0], normalizePlanStop(done));
});

test('proposal preview retains completed stops; delayed confirmation rejects before consuming the grant', () => {
  let now = '2026-09-20T08:00:00+08:00';
  const service = new InMemoryTripService(() => now);
  const { principal, session } = service.createAnonymousSession();
  const actorId = principal.principalId, sessionId = session.sessionId;
  const created = service.createTrip(actorId, { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
  assert.ok(created.ok); if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  assert.equal(created.value.clock?.relation, 'today');
  const patched = service.patchTrip(actorId, tripId, { expectedRevision: 0, stops: [makeStop({ stopId: 'done' })] });
  assert.ok(patched.ok);
  assert.ok(service.startTrip(actorId, tripId, 1).ok);
  now = '2026-09-20T13:00:00+08:00';
  const executed = service.recordExecution({ actorId, sessionId, tripId, stopId: 'done', type: 'complete', occurredAt: now });
  assert.ok(executed.ok); if (!executed.ok) return;
  const baseline = executed.value;
  const proposal = service.createProposal(actorId, tripId, { kind: 'replan', baseRevision: baseline.trip.revision, sessionId,
    candidates: [{ candidateId: 'c', title: '未来安排', summary: '', snapshot: makeSnapshot({ tripId, stops: [makeStop({ stopId: 'next', startMinutes: 782 })] }) }] });
  assert.ok(proposal.ok); if (!proposal.ok) return;
  assert.deepEqual(proposal.value.proposal.candidates[0].snapshot.stops?.[0], baseline.snapshot.stops?.[0]);
  assert.ok(!proposal.value.proposal.candidates[0].changes?.some(change => change.stopId === 'done'));
  const preview = service.getTrip(actorId, tripId); assert.ok(preview.ok);
  if (preview.ok) assert.equal(preview.value.trip.revision, baseline.trip.revision);
  const request = proposal.value.actionRequests[0]; assert.ok(request);
  const actionRequestId = request.actionRequestId;
  const decision = service.authorization.decide(actionRequestId, 'approve', { actorId, sessionId, now });
  assert.ok(decision.ok); const grantId = decision.value?.grant?.grantId; assert.ok(grantId);
  now = '2026-09-20T13:03:00+08:00';
  const result = service.applyProposal({ actorId, sessionId, tripId, proposalId: proposal.value.proposal.proposalId, candidateId: 'c', expectedRevision: baseline.trip.revision, actionRequestId, grantId, idempotencyKey: 'late-confirmation' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'PLAN_TIME_OR_PROGRESS_CONFLICT');
  assert.equal(service.authorization.getGrant(grantId)?.status, 'active');
  const unchanged = service.getTrip(actorId, tripId); assert.ok(unchanged.ok);
  if (unchanged.ok) assert.deepEqual(unchanged.value.snapshot, baseline.snapshot);
});
