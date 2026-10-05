import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEvidenceRegistry } from '../src/domain/evidence.js';
import { assertCanApply } from '../src/domain/versioning.js';
import { InMemoryTripService } from '../src/services/trip-service.js';
import type { Proposal } from '../src/domain/types.js';
import { makeSnapshot, makeStop } from './helpers.js';

function makeProposal(evidenceRefs: string[]): Proposal {
  const snapshot = makeSnapshot({
    tripId: 'trip_1',
    stops: [makeStop({ stopId: 'a', startMinutes: 14 * 60 })],
    version: 0,
  });
  return {
    proposalId: 'p1',
    tripId: 'trip_1',
    kind: 'replan',
    status: 'ready',
    baseRevision: 0,
    createdAt: '2026-09-20T13:00:00+08:00',
    expiresAt: '2026-09-20T13:10:00+08:00',
    candidates: [
      {
        candidateId: 'c1',
        title: '证据方案',
        summary: '证据方案',
        snapshot,
        checks: [],
        evidenceRefs,
      },
    ],
  };
}

test('SC47 paused or expired key evidence blocks application before business commit', () => {
  const registry = new InMemoryEvidenceRegistry();
  registry.upsert({
    evidenceId: 'e1',
    sourceType: 'demo_catalog',
    retrievedAt: '2026-09-20T12:00:00+08:00',
    dataMode: 'demo',
    verificationStatus: 'verified',
    validUntil: '2026-09-20T20:00:00+08:00',
  });
  const proposal = makeProposal(['e1']);
  const current = makeSnapshot({ tripId: 'trip_1' });

  assert.equal(
    assertCanApply(proposal, current, '2026-09-20T13:00:00+08:00', {
      evidenceRegistry: registry,
    }).ok,
    true,
  );

  registry.pause('e1');
  const paused = assertCanApply(proposal, current, '2026-09-20T13:01:00+08:00', {
    evidenceRegistry: registry,
  });
  assert.equal(paused.ok, false);
  if (!paused.ok) assert.equal(paused.code, 'EVIDENCE_INSUFFICIENT');

  registry.resume('e1');
  registry.expire('e1');
  const expired = assertCanApply(proposal, current, '2026-09-20T13:01:00+08:00', {
    evidenceRegistry: registry,
  });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, 'EVIDENCE_INSUFFICIENT');

  const missing = assertCanApply(proposal, current, '2026-09-20T13:01:00+08:00', {
    evidenceRegistry: new InMemoryEvidenceRegistry(),
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'EVIDENCE_INSUFFICIENT');
});

test('TripService forwards evidence registry checks before consuming a grant', () => {  const registry = new InMemoryEvidenceRegistry();
  registry.upsert({
    evidenceId: 'e1',
    sourceType: 'demo_catalog',
    retrievedAt: '2026-09-20T12:00:00+08:00',
    dataMode: 'demo',
    verificationStatus: 'verified',
  });
  registry.pause('e1');
  const service = new InMemoryTripService(
    () => '2026-09-20T13:00:00+08:00',
    { evidenceRegistry: registry },
  );
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const proposal = service.createProposal(principal.principalId, created.value.trip.tripId, {
    kind: 'replan',
    baseRevision: 0,
    candidates: [
      {
        candidateId: 'c1',
        title: '证据方案',
        summary: '证据方案',
        snapshot: makeSnapshot({
          tripId: created.value.trip.tripId,
          stops: [makeStop({ stopId: 'a' })],
        }),
        evidenceRefs: ['e1'],
      },
    ],
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const request = proposal.value.actionRequests[0];
  assert.ok(request);
  if (!request) return;
  const result = service.applyProposal({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId: created.value.trip.tripId,
    proposalId: proposal.value.proposal.proposalId,
    candidateId: 'c1',
    expectedRevision: 0,
    actionRequestId: request.actionRequestId,
    grantId: 'grant_missing',
    idempotencyKey: 'evidence-block',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EVIDENCE_INSUFFICIENT');
  const trip = service.getTrip(principal.principalId, created.value.trip.tripId);
  assert.equal(trip.ok, true);
  if (trip.ok) assert.equal(trip.value.trip.revision, 0);
});

test('evidence registry serialization preserves paused state across recovery', () => {
  const registry = new InMemoryEvidenceRegistry();
  registry.upsert({
    evidenceId: 'e1',
    sourceType: 'demo_catalog',
    retrievedAt: '2026-09-20T12:00:00+08:00',
    dataMode: 'demo',
    verificationStatus: 'verified',
  });
  registry.pause('e1');
  const restored = new InMemoryEvidenceRegistry();
  restored.loadSerialized(registry.serialize());
  assert.equal(restored.get('e1')?.status, 'paused');
  assert.equal(
    restored.validateRefs(['e1'], '2026-09-20T13:00:00+08:00').ok,
    false,
  );
});

