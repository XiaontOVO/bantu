import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { makeSnapshot, makeStop } from './helpers.js';

test('text approval targets the displayed proposal even when trips and proposals reuse candidate IDs', () => {
  const service = new InMemoryTripService(() => '2026-09-20T13:00:00+08:00');
  const first = service.createAnonymousSession();
  const second = service.createAnonymousSession();
  const create = (owner: typeof first) => {
    const result = service.createTrip(owner.principal.principalId, { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
    assert.ok(result.ok);
    return result.value.trip.tripId;
  };
  const firstTrip = create(first);
  const secondTrip = create(second);
  const propose = (owner: typeof first, tripId: string) => {
    const result = service.createProposal(owner.principal.principalId, tripId, {
      kind: 'initial', baseRevision: 0, sessionId: owner.session.sessionId,
      candidates: [{ candidateId: 'reused_candidate', title: '休息', summary: '休息一下',
        snapshot: makeSnapshot({ tripId, stops: [makeStop({ stopId: 'rest' })], routeLegs: [] }) }],
    });
    assert.ok(result.ok);
    assert.ok(result.value.actionRequests[0]);
    return { ...result.value, request: result.value.actionRequests[0] };
  };
  const foreign = propose(first, firstTrip);
  const older = propose(second, secondTrip);
  const displayed = propose(second, secondTrip);
  const confirmed = service.confirmFromText({
    actorId: second.principal.principalId, sessionId: second.session.sessionId,
    tripId: secondTrip, proposalId: displayed.proposal.proposalId, text: '确认',
  });
  assert.ok(confirmed.ok);
  assert.equal(confirmed.value?.actionRequestId, displayed.request.actionRequestId);
  assert.equal(service.authorization.getRequest(foreign.request.actionRequestId)?.status, 'pending');
  assert.equal(service.authorization.getRequest(older.request.actionRequestId)?.status, 'pending');
});

test('proposal creation rejects reused proposal IDs, duplicate candidate IDs, and foreign snapshots', () => {
  const service = new InMemoryTripService(() => '2026-09-20T13:00:00+08:00');
  const owner = service.createAnonymousSession();
  const trip = service.createTrip(owner.principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo',
  });
  assert.ok(trip.ok); if (!trip.ok) return;
  const tripId = trip.value.trip.tripId;
  const candidate = { candidateId: 'candidate', title: '安排', summary: '', snapshot: makeSnapshot({ tripId }) };

  const valid = service.createProposal(owner.principal.principalId, tripId, {
    kind: 'initial', baseRevision: 0, proposalId: 'fixed-proposal', candidates: [candidate],
  });
  assert.ok(valid.ok); if (!valid.ok) return;

  const reusedProposal = service.createProposal(owner.principal.principalId, tripId, {
    kind: 'initial', baseRevision: 0, proposalId: 'fixed-proposal', candidates: [candidate],
  });
  assert.equal(reusedProposal.ok, false);
  if (!reusedProposal.ok) assert.equal(reusedProposal.error.code, 'IDEMPOTENCY_CONFLICT');

  const duplicateCandidate = service.createProposal(owner.principal.principalId, tripId, {
    kind: 'initial', baseRevision: 0, candidates: [candidate, { ...candidate, title: '不同内容' }],
  });
  assert.equal(duplicateCandidate.ok, false);
  if (!duplicateCandidate.ok) assert.equal(duplicateCandidate.error.code, 'INVALID_INPUT');

  const foreignSnapshot = service.createProposal(owner.principal.principalId, tripId, {
    kind: 'initial', baseRevision: 0, candidates: [{ ...candidate, snapshot: makeSnapshot({ tripId: 'trip_elsewhere' }) }],
  });
  assert.equal(foreignSnapshot.ok, false);
  if (!foreignSnapshot.ok) assert.equal(foreignSnapshot.error.code, 'TRIP_MISMATCH');
});

test('rejecting one trip proposal does not reject same-ID requests from another trip', () => {
  const service = new InMemoryTripService(() => '2026-09-20T13:00:00+08:00');
  const owner = service.createAnonymousSession();
  const createTrip = () => {
    const result = service.createTrip(owner.principal.principalId, { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
    assert.ok(result.ok);
    return result.value.trip.tripId;
  };
  const firstTrip = createTrip();
  const secondTrip = createTrip();
  const create = (tripId: string) => service.createProposal(owner.principal.principalId, tripId, {
    kind: 'initial', baseRevision: 0, proposalId: 'shared-proposal',
    candidates: [{ candidateId: 'shared-candidate', title: '安排', summary: '', snapshot: makeSnapshot({ tripId }) }],
  });
  const first = create(firstTrip);
  const second = create(secondTrip);
  assert.ok(first.ok); assert.ok(second.ok);
  if (!first.ok || !second.ok) return;
  const firstRequest = first.value.actionRequests[0];
  const secondRequest = second.value.actionRequests[0];
  assert.ok(firstRequest); assert.ok(secondRequest);
  if (!firstRequest || !secondRequest) return;

  const rejected = service.rejectProposal(owner.principal.principalId, firstTrip, 'shared-proposal');
  assert.ok(rejected.ok);
  assert.equal(service.authorization.getRequest(firstRequest.actionRequestId)?.status, 'rejected');
  assert.equal(service.authorization.getRequest(secondRequest.actionRequestId)?.status, 'pending');
});
