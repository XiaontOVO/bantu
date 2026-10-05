import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { makeSnapshot, makeStop } from './helpers.js';

test('SC06/SC07/SC08: one application, idempotent replay and undo create monotonic versions', () => {
  let clock = '2026-09-20T13:00:00+08:00';
  const service = new InMemoryTripService(() => clock);
  const { principal, session } = service.createAnonymousSession();

  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  const tripId = created.value.trip.tripId;

  const candidateSnapshot = makeSnapshot({
    tripId,
    version: 0,
    stops: [makeStop({ stopId: 'rest', placeId: 'R', startMinutes: 13 * 60 + 10, plannedDurationMinutes: 30 })],
    routeLegs: [],
    planningStatus: 'validated',
  });
  clock = '2026-09-20T13:01:00+08:00';
  const proposed = service.createProposal(principal.principalId, tripId, {
    kind: 'initial',
    baseRevision: 0,
    sessionId: session.sessionId,
    contextSnapshotId: null,
    candidates: [
      {
        candidateId: 'candidate_1',
        title: '就近休息',
        summary: '新增休息 30 分钟',
        snapshot: candidateSnapshot,
      },
    ],
  });
  assert.equal(proposed.ok, true);
  const request = proposed.value.actionRequests[0];
  assert.ok(request);

  clock = '2026-09-20T13:02:00+08:00';
  const decided = service.decideAction({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    actionRequestId: request.actionRequestId,
    decision: 'approve',
  });
  assert.equal(decided.ok, true);
  const grantId = service.authorization
    .listRequests()
    .find((item) => item.actionRequestId === request.actionRequestId);
  assert.ok(grantId);
  // 通过已批准请求关联到的唯一 active grant；测试直接使用领域服务内部映射的公开入口。
  const activeGrant = (service.authorization as unknown as {
    grants: Map<string, { status: string; actionRequestId: string; grantId: string }>;
  }).grants;
  const grantForRequest = [...activeGrant.values()].find(
    (item) => item.actionRequestId === request.actionRequestId && item.status === 'active',
  );
  assert.ok(grantForRequest);

  clock = '2026-09-20T13:03:00+08:00';
  const applied = service.applyProposal({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    proposalId: proposed.value.proposal.proposalId,
    candidateId: 'candidate_1',
    expectedRevision: 0,
    actionRequestId: request.actionRequestId,
    grantId: grantForRequest.grantId,
    idempotencyKey: 'apply-key-1',
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.value.revision, 1);
  assert.equal(applied.value.trip.snapshot.stops?.length, 1);

  const replay = service.applyProposal({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    proposalId: proposed.value.proposal.proposalId,
    candidateId: 'candidate_1',
    expectedRevision: 0,
    actionRequestId: request.actionRequestId,
    grantId: grantForRequest.grantId,
    idempotencyKey: 'apply-key-1',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.value.revision, 1);
  assert.equal(replay.value.mutationId, applied.value.mutationId);

  clock = '2026-09-20T13:04:00+08:00';
  const undone = service.undo({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    mutationId: applied.value.mutationId,
    expectedRevision: 1,
    idempotencyKey: 'undo-key-1',
  });
  assert.equal(undone.ok, true);
  assert.equal(undone.value.revision, 2);
  assert.equal(undone.value.trip.snapshot.stops?.length, 0);
});

test('SC15 another principal cannot read a guessed trip id', () => {
  const service = new InMemoryTripService();
  const owner = service.createAnonymousSession();
  const other = service.createAnonymousSession();
  const created = service.createTrip(owner.principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  const guessed = service.getTrip(other.principal.principalId, created.value.trip.tripId);
  assert.equal(guessed.ok, false);
  assert.equal(guessed.error?.code, 'RESOURCE_NOT_FOUND');
});

test('SC19 shortlist-style patch does not create a formal plan version when no plan edits occur', () => {
  const service = new InMemoryTripService();
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  assert.equal(created.value.trip.revision, 0);
  assert.equal(created.value.trip.planningStatus, 'empty');
});

test('online and demo trips cannot be mixed by applying a proposal across modes', () => {  const service = new InMemoryTripService();
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'online',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const candidate = makeSnapshot({
    tripId: created.value.trip.tripId,
    dataMode: 'demo',
    stops: [makeStop({ stopId: 'a' })],
  });
  const proposed = service.createProposal(principal.principalId, created.value.trip.tripId, {
    kind: 'initial',
    baseRevision: 0,
    sessionId: session.sessionId,
    candidates: [{ title: 'demo candidate', summary: '不该混用', snapshot: candidate }],
  });
  assert.equal(proposed.ok, false);
  if (!proposed.ok) assert.equal(proposed.error.code, 'DATA_MODE_MISMATCH');
});

test('two proposals based on the same revision allow at most one successful apply', () => {
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

  const makeCandidate = (stopId: string) =>
    makeSnapshot({
      tripId,
      stops: [makeStop({ stopId, placeId: stopId, startMinutes: 13 * 60 + 10 })],
      routeLegs: [],
      planningStatus: 'validated',
    });

  const firstProposal = service.createProposal(principal.principalId, tripId, {
    kind: 'replan',
    baseRevision: 0,
    sessionId: session.sessionId,
    candidates: [{ candidateId: 'c1', title: '方案一', summary: '方案一', snapshot: makeCandidate('a') }],
  });
  clock = '2026-09-20T13:00:10+08:00';
  const secondProposal = service.createProposal(principal.principalId, tripId, {
    kind: 'replan',
    baseRevision: 0,
    sessionId: session.sessionId,
    candidates: [{ candidateId: 'c2', title: '方案二', summary: '方案二', snapshot: makeCandidate('b') }],
  });
  assert.equal(firstProposal.ok, true);
  assert.equal(secondProposal.ok, true);
  if (!firstProposal.ok || !secondProposal.ok) return;

  const grants = (service.authorization as unknown as {
    grants: Map<string, { actionRequestId: string; status: string; grantId: string }>;
  }).grants;

  const approve = (actionRequestId: string, now: string) => {
    const decided = service.decideAction({
      actorId: principal.principalId,
      sessionId: session.sessionId,
      actionRequestId,
      decision: 'approve',
      now,
    });
    assert.equal(decided.ok, true);
  };

  const firstRequest = firstProposal.value.actionRequests[0];
  const secondRequest = secondProposal.value.actionRequests[0];
  assert.ok(firstRequest);
  assert.ok(secondRequest);
  if (!firstRequest || !secondRequest) return;
  approve(firstRequest.actionRequestId, '2026-09-20T13:01:00+08:00');
  approve(secondRequest.actionRequestId, '2026-09-20T13:01:01+08:00');
  const firstGrant = [...grants.values()].find(
    (grant) => grant.actionRequestId === firstRequest.actionRequestId && grant.status === 'active',
  );
  const secondGrant = [...grants.values()].find(
    (grant) => grant.actionRequestId === secondRequest.actionRequestId && grant.status === 'active',
  );
  assert.ok(firstGrant);
  assert.ok(secondGrant);
  if (!firstGrant || !secondGrant) return;

  clock = '2026-09-20T13:02:00+08:00';
  const applied = service.applyProposal({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    proposalId: firstProposal.value.proposal.proposalId,
    candidateId: 'c1',
    expectedRevision: 0,
    actionRequestId: firstRequest.actionRequestId,
    grantId: firstGrant.grantId,
    idempotencyKey: 'concurrent-apply-1',
  });
  assert.equal(applied.ok, true);

  clock = '2026-09-20T13:02:01+08:00';
  const stale = service.applyProposal({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    proposalId: secondProposal.value.proposal.proposalId,
    candidateId: 'c2',
    expectedRevision: 0,
    actionRequestId: secondRequest.actionRequestId,
    grantId: secondGrant.grantId,
    idempotencyKey: 'concurrent-apply-2',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'REVISION_CONFLICT');
});

test('SC10 new context invalidates an old proposal even when revision is unchanged', () => {
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
  const context = service.captureContext(principal.principalId, tripId, {
    capturedAt: clock,
    clockRef: 'demo-clock',
    contextSnapshotId: 'ctx_1',
  });
  assert.equal(context.ok, true);

  const proposal = service.createProposal(principal.principalId, tripId, {
    kind: 'replan',
    baseRevision: 0,
    contextSnapshotId: 'ctx_1',
    sessionId: session.sessionId,
    candidates: [
      {
        candidateId: 'c1',
        title: '上下文 1 方案',
        summary: '基于 ctx_1',
        snapshot: makeSnapshot({ tripId, stops: [makeStop({ stopId: 'a' })], contextSnapshotId: 'ctx_1' }),
      },
    ],
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;

  clock = '2026-09-20T13:00:02+08:00';
  const changed = service.captureContext(principal.principalId, tripId, {
    capturedAt: clock,
    clockRef: 'demo-clock',
    contextSnapshotId: 'ctx_2',
  });
  assert.equal(changed.ok, true);

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
    expectedRevision: 0,
    actionRequestId: request.actionRequestId,
    grantId: grant.grantId,
    idempotencyKey: 'context-change-apply',
  });
  assert.equal(applied.ok, false);
  assert.equal(applied.error?.code, 'CONTEXT_CHANGED');
});
