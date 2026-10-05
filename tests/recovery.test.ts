import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { buildDemoPlanSnapshot } from '../src/demo/demo-data.js';
import { makeStop } from './helpers.js';

test('local backup serialize/load restores trips, pending actions and idempotency records', () => {
  const source = new InMemoryTripService(() => '2026-09-20T08:00:00+08:00');
  const { principal, session } = source.createAnonymousSession();
  const created = source.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
    partySize: 2,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const patched = source.patchTrip(principal.principalId, tripId, {
    expectedRevision: 0,
    stops: [makeStop({ stopId: 'a', startMinutes: 9 * 60 })],
  });
  assert.equal(patched.ok, true);
  if (!patched.ok) return;

  const proposal = source.createProposal(principal.principalId, tripId, {
    kind: 'replan',
    baseRevision: patched.value.trip.revision,
    sessionId: session.sessionId,
    candidates: [
      {
        candidateId: 'c1',
        title: '恢复测试',
        summary: '恢复测试',
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

  const backup = source.serialize();
  const restored = new InMemoryTripService(() => '2026-09-20T08:05:00+08:00');
  restored.loadSerialized(backup);

  const trip = restored.getTrip(principal.principalId, tripId);
  assert.equal(trip.ok, true);
  if (trip.ok) {
    assert.equal(trip.value.trip.revision, patched.value.trip.revision);
    assert.equal(trip.value.snapshot.stops?.length, 1);
  }
  const request = proposal.value.actionRequests[0];
  assert.ok(request);
  if (request) {
    assert.equal(
      restored.authorization.getRequest(request.actionRequestId)?.status,
      'pending',
    );
  }
  assert.ok(restored.serialize().length > 0);
});

test('restoring a pre-memory backup initializes empty memory storage', () => {
  const source = new InMemoryTripService(() => '2026-09-20T08:00:00+08:00');
  const { principal } = source.createAnonymousSession();
  const created = source.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const legacy = JSON.parse(source.serialize());
  delete legacy.trips[0].memories;
  const restored = new InMemoryTripService(() => '2026-09-20T08:05:00+08:00');
  restored.loadSerialized(JSON.stringify(legacy));

  const listed = restored.listMemories(principal.principalId, created.value.trip.tripId);
  assert.equal(listed.ok, true);
  if (listed.ok) assert.deepEqual(listed.value, []);
});
