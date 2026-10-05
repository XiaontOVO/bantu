import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { makeSnapshot, makeStop } from './helpers.js';

test('feedback is stored without changing planning revision', () => {
  const service = new InMemoryTripService(() => '2026-09-20T13:00:00+08:00');
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const result = service.recordFeedback(principal.principalId, tripId, {
    rating: 5,
    reasonCode: 'helpful',
    note: '休息建议很清楚',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.rating, 5);
  const trip = service.getTrip(principal.principalId, tripId);
  assert.equal(trip.ok, true);
  if (trip.ok) assert.equal(trip.value.trip.revision, 0);
});

test('GET trip exposes pending action request refs for the UI', () => {
  const service = new InMemoryTripService(() => '2026-09-20T13:00:00+08:00');
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const proposal = service.createProposal(principal.principalId, tripId, {
    kind: 'initial',
    baseRevision: 0,
    sessionId: session.sessionId,
    candidates: [
      {
        candidateId: 'c1',
        title: '候选',
        summary: '候选',
        snapshot: makeSnapshot({ tripId, stops: [makeStop({ stopId: 'a' })] }),
      },
    ],
  });
  assert.equal(proposal.ok, true);
  const trip = service.getTrip(principal.principalId, tripId);
  assert.equal(trip.ok, true);
  if (trip.ok) {
    assert.equal(trip.value.pendingActionRequests.length, 1);
    assert.equal(trip.value.pendingActionRequests[0].status, 'pending');
  }
});
