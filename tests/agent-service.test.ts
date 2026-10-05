import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { AgentService } from '../src/services/agent-service.js';

test('agent service runs a read-only tool loop and creates an initial proposal operation', async () => {
  let clock = '2026-09-20T13:00:00+08:00';
  const trips = new InMemoryTripService(() => clock);
  const agents = new AgentService(trips, { now: () => clock });
  const { principal, session } = trips.createAnonymousSession();
  const created = trips.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
    partySize: 2,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const operation = await agents.start({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId: created.value.trip.tripId,
    baseRevision: 0,
    kind: 'initial',
    contextSnapshotId: null,
  });
  assert.equal(operation.operation.status, 'succeeded');
  assert.equal(operation.operation.kind, 'initial_plan');
  assert.equal(operation.steps.length, 3);
  assert.equal(operation.steps[0].toolResults[0].toolName, 'trip.read');
  assert.equal(operation.steps[1].toolResults[0].toolName, 'plan.propose');
  const proposalId = operation.operation.result?.proposalId;
  assert.equal(typeof proposalId, 'string');

  const proposal = trips.getProposal(
    principal.principalId,
    created.value.trip.tripId,
    proposalId as string,
  );
  assert.equal(proposal.ok, true);
  if (proposal.ok) {
    assert.equal(proposal.value.proposal.status, 'ready');
    assert.ok(proposal.value.actionRequests.length >= 1);
  }
});

test('agent service creates a rest replan proposal without changing formal revision', async () => {
  let clock = '2026-09-20T13:00:00+08:00';
  const trips = new InMemoryTripService(() => clock);
  const agents = new AgentService(trips, { now: () => clock });
  const { principal, session } = trips.createAnonymousSession();
  const created = trips.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
    partySize: 2,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const operation = await agents.start({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId: created.value.trip.tripId,
    baseRevision: 0,
    kind: 'replan',
    event: { type: 'rest_requested', text: '想休息三十分钟' },
  });
  assert.equal(operation.operation.status, 'succeeded');
  assert.equal(operation.operation.kind, 'replan');
  const result = operation.operation.result as { kind?: string; proposalId?: string };
  assert.equal(result.kind, 'proposal');
  assert.equal(typeof result.proposalId, 'string');

  const trip = trips.getTrip(principal.principalId, created.value.trip.tripId);
  assert.equal(trip.ok, true);
  if (trip.ok) {
    assert.equal(trip.value.trip.revision, 0);
    assert.equal(trip.value.snapshot.stops?.length, 0);
  }
});

test('agent service exposes failed operation instead of throwing on unknown trip', async () => {
  const trips = new InMemoryTripService();
  const agents = new AgentService(trips);
  const { principal, session } = trips.createAnonymousSession();
  const operation = await agents.start({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId: 'trip_missing',
    baseRevision: 0,
    kind: 'initial',
  });
  assert.equal(operation.operation.status, 'failed');
  assert.equal(operation.operation.error?.code, 'AGENT_FAILED');
});
