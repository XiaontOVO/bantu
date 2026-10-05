import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propagateSchedule } from '../src/domain/itinerary.js';
import { checkConstraint } from '../src/domain/constraints.js';
import { ActionAuthorizationService } from '../src/domain/authorization.js';
import { ToolGateway } from '../src/agent/tools.js';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { makeSnapshot, makeStop } from './helpers.js';

test('SC03 accepting a 20-minute rest still reaches the fixed venue by 14:25', () => {
  const result = propagateSchedule({
    departureMinutes: 13 * 60 + 30,
    segments: [
      { stopId: 'r', placeId: 'R', durationMinutes: 20, minDurationMinutes: 20 },
      { stopId: 'v', placeId: 'V', durationMinutes: 60, latestArrivalMinutes: 14 * 60 + 30 },
    ],
    routes: [
      { legId: 'o-r', fromStopId: 'origin', toStopId: 'r', transportMode: 'walking', durationMinutes: 5, bufferMinutes: 5, walkingMeters: 250, distanceMeters: 250 },
      { legId: 'r-v', fromStopId: 'r', toStopId: 'v', transportMode: 'walking', durationMinutes: 20, bufferMinutes: 5, walkingMeters: 600, distanceMeters: 600 },
    ],
  });
  const v = result.stops.find((stop) => stop.stopId === 'v');
  assert.ok(v);
  assert.equal(v.plannedArrivalMinutes, 14 * 60 + 25);
  const check = checkConstraint(
    {
      constraintId: 'visit:v',
      kind: 'visit_window',
      strength: 'hard',
      payload: { stopId: 'v', latestArrivalMinutes: 14 * 60 + 30 },
    },
    makeSnapshot({ stops: result.stops }),
  );
  assert.equal(check.status, 'pass');
});

test('SC09 undo is rejected after a real execution fact was recorded', () => {
  let clock = '2026-09-20T13:00:00+08:00';
  const service = new InMemoryTripService(() => clock);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  clock = '2026-09-20T13:00:01+08:00';
  const patched = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: 0,
    stops: [makeStop({ stopId: 'a', startMinutes: 14 * 60 })],
  });
  assert.equal(patched.ok, true);
  if (!patched.ok) return;

  clock = '2026-09-20T13:00:02+08:00';
  const proposal = service.createProposal(principal.principalId, tripId, {
    kind: 'replan',
    baseRevision: patched.value.trip.revision,
    sessionId: session.sessionId,
    candidates: [
      {
        candidateId: 'c1',
        title: '调整',
        summary: '调整',
        snapshot: makeSnapshot({ tripId, stops: [makeStop({ stopId: 'a', startMinutes: 15 * 60 })], version: patched.value.trip.revision }),
      },
    ],
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const request = proposal.value.actionRequests[0];
  assert.ok(request);
  if (!request) return;
  service.decideAction({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    actionRequestId: request.actionRequestId,
    decision: 'approve',
  });
  const grants = (service.authorization as unknown as {
    grants: Map<string, { actionRequestId: string; status: string; grantId: string }>;
  }).grants;
  const grant = [...grants.values()].find(
    (item) => item.actionRequestId === request.actionRequestId && item.status === 'active',
  );
  assert.ok(grant);
  if (!grant) return;
  const applied = service.applyProposal({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    proposalId: proposal.value.proposal.proposalId,
    candidateId: 'c1',
    expectedRevision: patched.value.trip.revision,
    actionRequestId: request.actionRequestId,
    grantId: grant.grantId,
    idempotencyKey: 'sc09-apply',
  });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const started = service.startTrip(principal.principalId, tripId, applied.value.revision);
  assert.equal(started.ok, true);
  if (!started.ok) return;

  clock = '2026-09-20T13:00:03+08:00';
  const execution = service.recordExecution({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    stopId: 'a',
    type: 'complete',
    occurredAt: clock,
    expectedRevision: started.value.trip.revision,
  });
  assert.equal(execution.ok, true);
  if (!execution.ok) return;

  clock = '2026-09-20T13:00:04+08:00';
  const undo = service.undo({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    mutationId: applied.value.mutationId,
    expectedRevision: execution.value.trip.revision,
    idempotencyKey: 'sc09-undo',
  });
  assert.equal(undo.ok, false);
  assert.equal(undo.error?.code, 'UNDO_CONFLICT');
});

test('SC14 starting a trip preserves needs_review until facts are fixed', () => {
  // 固定时钟，避免测试运行在当天中午之后时，12:00 的计划被时间边界拒绝。
  const service = new InMemoryTripService(() => '2026-09-20T08:00:00+08:00');
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const stop = makeStop({
    stopId: 'v',
    startMinutes: 12 * 60,
    endMinutes: 13 * 60,
  });
  const constraint = {
    constraintId: 'visit:v',
    kind: 'visit_window' as const,
    strength: 'hard' as const,
    source: 'user_form' as const,
    memberIds: [],
    confirmedAt: null,
    payload: { stopId: 'v', earliestStartMinutes: 14 * 60 },
  };
  const patched = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: 0,
    stops: [stop],
    constraints: [constraint],
  });
  assert.equal(patched.ok, true);
  if (!patched.ok) return;
  assert.equal(patched.value.trip.planningStatus, 'needs_review');

  const started = service.startTrip(principal.principalId, tripId, patched.value.trip.revision);
  assert.equal(started.ok, true);
  if (started.ok) {
    assert.equal(started.value.trip.lifecycle, 'active');
    assert.equal(started.value.trip.planningStatus, 'needs_review');
  }
});

test('SC30/SC41 idempotent replay returns the historical revision without overwriting newer facts', () => {
  let clock = '2026-09-20T08:00:00+08:00';
  const service = new InMemoryTripService(() => clock);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  clock = '2026-09-20T08:00:01+08:00';
  const patched = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: 0,
    stops: [makeStop({ stopId: 'a', startMinutes: 9 * 60 })],
  });
  assert.equal(patched.ok, true);
  if (!patched.ok) return;
  const proposal = service.createProposal(principal.principalId, tripId, {
    kind: 'replan',
    baseRevision: patched.value.trip.revision,
    sessionId: session.sessionId,
    candidates: [
      {
        candidateId: 'c1',
        title: '调整',
        summary: '调整',
        snapshot: makeSnapshot({
          tripId,
          stops: [makeStop({ stopId: 'a', startMinutes: 10 * 60 })],
          version: patched.value.trip.revision,
        }),
      },
    ],
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const request = proposal.value.actionRequests[0];
  assert.ok(request);
  if (!request) return;
  const decided = service.decideAction({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    actionRequestId: request.actionRequestId,
    decision: 'approve',
  });
  assert.equal(decided.ok, true);
  const grants = (service.authorization as unknown as {
    grants: Map<string, { actionRequestId: string; status: string; grantId: string }>;
  }).grants;
  const grant = [...grants.values()].find(
    (item) => item.actionRequestId === request.actionRequestId && item.status === 'active',
  );
  assert.ok(grant);
  if (!grant) return;
  const applyCommand = {
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    proposalId: proposal.value.proposal.proposalId,
    candidateId: 'c1',
    expectedRevision: patched.value.trip.revision,
    actionRequestId: request.actionRequestId,
    grantId: grant.grantId,
    idempotencyKey: 'sc41-apply',
  };
  const applied = service.applyProposal(applyCommand);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const startedForFacts = service.startTrip(
    principal.principalId,
    tripId,
    applied.value.revision,
  );
  assert.equal(startedForFacts.ok, true);
  if (!startedForFacts.ok) return;

  clock = '2026-09-20T08:00:02+08:00';
  const execution = service.recordExecution({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    stopId: 'a',
    type: 'complete',
    occurredAt: clock,
    expectedRevision: startedForFacts.value.trip.revision,
  });
  assert.equal(execution.ok, true);
  if (!execution.ok) return;
  assert.equal(execution.value.trip.revision, startedForFacts.value.trip.revision + 1);

  const replay = service.applyProposal(applyCommand);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.revision, applied.value.revision);
    assert.equal((replay.value.trip.snapshot.executionEvents ?? []).length, 0);
  }
  const current = service.getTrip(principal.principalId, tripId);
  assert.equal(current.ok, true);
  if (current.ok) assert.equal(current.value.trip.revision, execution.value.trip.revision);
});

test('SC42 session revocation invalidates an already granted action permit', () => {
  const authorization = new ActionAuthorizationService();
  authorization.createRequest({
    actionRequestId: 'a1',
    tripId: 'trip_1',
    actorId: 'actor_1',
    sessionId: 'session_1',
    toolName: 'memory.create',
    canonicalArgs: { text: 'x' },
    summary: '记录',
    createdAt: '2026-09-20T13:00:00+08:00',
    expiresAt: '2026-09-20T13:10:00+08:00',
  });
  authorization.decide('a1', 'approve', { now: '2026-09-20T13:00:01+08:00' });
  assert.ok(authorization.getActiveGrant('a1'));
  authorization.invalidateScope({ sessionId: 'session_1', now: '2026-09-20T13:00:02+08:00' });
  assert.equal(authorization.getRequest('a1')?.status, 'cancelled');
  assert.equal(authorization.getActiveGrant('a1'), undefined);
});

test('SC48 unregistered tools are denied by the gateway without executing an arbitrary function', async () => {
  const gateway = new ToolGateway(new ActionAuthorizationService());
  const result = await gateway.executeBatch(
    [{ callId: 'c1', name: 'shell.exec', arguments: { command: 'rm' } }],
    {
      actorId: 'actor_1',
      sessionId: 'session_1',
      tripId: 'trip_1',
      now: '2026-09-20T13:00:00+08:00',
    },
  );
  assert.equal(result.results[0].status, 'denied');
  assert.equal(result.results[0].error?.code, 'TOOL_NOT_FOUND');
});
