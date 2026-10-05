import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { AgentService } from '../src/services/agent-service.js';
import { buildDemoPlanSnapshot } from '../src/demo/demo-data.js';

async function setupProposal() {
  let clock = '2026-09-20T08:00:00+08:00';
  const trips = new InMemoryTripService(() => clock);
  const agents = new AgentService(trips, { now: () => clock });
  const { principal, session } = trips.createAnonymousSession();
  const created = trips.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
    partySize: 2,
  });
  if (!created.ok) throw new Error('trip create failed');
  const snapshot = buildDemoPlanSnapshot({
    tripId: created.value.trip.tripId,
    dataMode: 'demo',
    timezone: created.value.trip.timezone,
    travelDate: created.value.trip.localDate ?? new Date().toISOString().slice(0, 10),
    dayStartMinutes: 9 * 60,
    partySize: 2,
  });
  const proposal = trips.createProposal(principal.principalId, created.value.trip.tripId, {
    kind: 'initial',
    baseRevision: 0,
    sessionId: session.sessionId,
    candidates: [{ candidateId: 'c1', title: '初始', summary: '初始', snapshot }],
  });
  if (!proposal.ok) throw new Error('proposal create failed');
  return { trips, agents, principal, session, tripId: created.value.trip.tripId, proposal: proposal.value };
}

function findGrant(trips: InMemoryTripService, actionRequestId: string) {
  const grants = (trips.authorization as unknown as {
    grants: Map<string, { actionRequestId: string; status: string; grantId: string }>;
  }).grants;
  return [...grants.values()].find(
    (grant) => grant.actionRequestId === actionRequestId && grant.status === 'active',
  );
}

test('agent apply pauses for a specific grant and commits once after approval', async () => {
  const { trips, agents, principal, session, tripId, proposal } = await setupProposal();
  const operation = await agents.startApply({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    proposalId: proposal.proposal.proposalId,
    candidateId: 'c1',
    expectedRevision: 0,
    idempotencyKey: 'agent-apply-1',
  });
  assert.equal(operation.operation.status, 'awaiting_approval');
  assert.equal(operation.pendingActionRequests.length, 1);
  const actionRequest = operation.pendingActionRequests[0];
  assert.equal(actionRequest.candidateId, 'c1');

  const decided = trips.decideAction({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    actionRequestId: actionRequest.actionRequestId,
    decision: 'approve',
  });
  assert.equal(decided.ok, true);
  const grant = findGrant(trips, actionRequest.actionRequestId);
  assert.ok(grant);

  const resumed = await agents.resumeApply({
    operationId: operation.operation.operationId,
    actionRequestId: actionRequest.actionRequestId,
    grantId: grant!.grantId,
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.value.operation.status, 'succeeded');
  assert.equal(resumed.value.operation.result?.kind, 'agent_result');
  const trip = trips.getTrip(principal.principalId, tripId);
  assert.equal(trip.ok, true);
  if (trip.ok) assert.equal(trip.value.trip.revision, 1);

  const secondResume = await agents.resumeApply({
    operationId: operation.operation.operationId,
    actionRequestId: actionRequest.actionRequestId,
    grantId: grant!.grantId,
  });
  assert.equal(secondResume.ok, false);
  assert.equal(secondResume.error?.code, 'OPERATION_TERMINAL');
});

test('cancel before approval prevents the pending write and leaves formal revision unchanged', async () => {
  const { trips, agents, principal, session, tripId, proposal } = await setupProposal();
  const operation = await agents.startApply({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    proposalId: proposal.proposal.proposalId,
    candidateId: 'c1',
    expectedRevision: 0,
    idempotencyKey: 'agent-apply-cancel',
  });
  const cancelled = agents.operations.cancel(operation.operation.operationId, '2026-09-20T08:01:00+08:00');
  assert.equal(cancelled.ok, true);
  const resumed = await agents.resumeApply({
    operationId: operation.operation.operationId,
    actionRequestId: operation.pendingActionRequests[0].actionRequestId,
    grantId: 'grant_missing',
  });
  assert.equal(resumed.ok, false);
  const trip = trips.getTrip(principal.principalId, tripId);
  assert.equal(trip.ok, true);
  if (trip.ok) assert.equal(trip.value.trip.revision, 0);
});
