import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionAuthorizationService,
  parseConfirmationText,
  parseDirectCommand,
  resolveDisplayedAction,
} from '../src/domain/authorization.js';

test('SC26 confirms the second displayed candidate with one complete sentence', () => {
  assert.equal(parseConfirmationText('确认应用方案二').kind, 'approve');
  assert.equal(parseConfirmationText('确认应用方案二').candidateIndex, 2);
  const displayed = [
    { actionRequestId: 'a1', candidateIndex: 1, status: 'pending' as const, expiresAt: '2026-09-20T13:05:00+08:00' },
    { actionRequestId: 'a2', candidateIndex: 2, status: 'pending' as const, expiresAt: '2026-09-20T13:05:00+08:00' },
  ];
  const resolution = resolveDisplayedAction(
    '好，就按第二个改',
    displayed,
    '2026-09-20T13:01:00+08:00',
  );
  assert.equal(resolution.decision.kind, 'approve');
  assert.equal(resolution.resolvedActionRequestId, 'a2');
});

test('SC27 praise alone does not produce an approval', () => {
  assert.equal(parseConfirmationText('方案看起来不错').kind, 'none');
  assert.equal(parseConfirmationText('你看着办').kind, 'none');
});

test('SC44 hypothetical, negated and quoted confirmations are rejected', () => {
  assert.equal(parseConfirmationText('如果我说确认，会怎样').kind, 'denied');
  assert.equal(parseConfirmationText('不要应用第二个').kind, 'reject');
  assert.equal(parseConfirmationText('他说：确认').kind, 'denied');
  assert.equal(parseConfirmationText('“确认应用方案二”').kind, 'denied');
});

test('direct commands preserve the user text and do not infer unrelated writes', () => {
  const memory = parseDirectCommand('记下：今天和妈妈逛得很开心');
  assert.deepEqual(memory, { kind: 'memory.create', text: '今天和妈妈逛得很开心' });
  assert.deepEqual(parseDirectCommand('收藏这个地点'), {
    kind: 'shortlist.add',
    placeRef: 'current',
  });
  assert.deepEqual(parseDirectCommand('我们已到达这个地点'), {
    kind: 'progress.record',
    type: 'arrive',
    placeRef: 'current',
  });
  assert.equal(parseDirectCommand('这个地方看起来不错，也许可以记一下'), null);
});

test('generic confirmation is ambiguous when multiple cards are pending', () => {
  const resolution = resolveDisplayedAction(
    '确认',
    [
      { actionRequestId: 'a1', candidateIndex: 1, status: 'pending' },
      { actionRequestId: 'a2', candidateIndex: 2, status: 'pending' },
    ],
    '2026-09-20T13:01:00+08:00',
  );
  assert.equal(resolution.decision.kind, 'ambiguous');
  assert.equal(resolution.resolvedActionRequestId, null);
});

test('approval group grants only one candidate and consumes one-time grant once', () => {
  const service = new ActionAuthorizationService();
  const createdAt = '2026-09-20T13:00:00+08:00';
  const expiresAt = '2026-09-20T13:05:00+08:00';
  for (const candidateId of ['c1', 'c2']) {
    const created = service.createRequest({
      actionRequestId: `action_${candidateId}`,
      tripId: 'trip_1',
      actorId: 'actor_1',
      sessionId: '*',
      toolName: 'plan.apply',
      canonicalArgs: { proposalId: 'p1', candidateId },
      summary: `采用 ${candidateId}`,
      createdAt,
      expiresAt,
      approvalGroupId: 'group_1',
      candidateId,
    });
    assert.equal(created.ok, true);
  }

  const approved = service.decide('action_c2', 'approve', {
    now: '2026-09-20T13:01:00+08:00',
    actorId: 'actor_1',
    sessionId: 'session_1',
  });
  assert.equal(approved.ok, true);
  assert.equal(service.getRequest('action_c1')?.status, 'cancelled');
  const grantId = approved.value?.grant?.grantId;
  assert.ok(grantId);

  const first = service.consumeGrant({
    grantId,
    actorId: 'actor_1',
    sessionId: 'session_1',
    now: '2026-09-20T13:02:00+08:00',
  });
  assert.equal(first.ok, true);
  assert.equal(service.getRequest('action_c2')?.status, 'executed');

  const second = service.consumeGrant({
    grantId,
    actorId: 'actor_1',
    sessionId: 'session_1',
    now: '2026-09-20T13:03:00+08:00',
  });
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'ACTION_AUTHORIZATION_INVALID');
});

test('revoking an executed action returns ACTION_ALREADY_EXECUTED, not a rollback', () => {
  const service = new ActionAuthorizationService();
  service.createRequest({
    actionRequestId: 'a1',
    tripId: 'trip_1',
    actorId: 'actor_1',
    sessionId: '*',
    toolName: 'memory.create',
    canonicalArgs: { text: 'x' },
    summary: '记录',
    createdAt: '2026-09-20T13:00:00+08:00',
    expiresAt: '2026-09-20T13:05:00+08:00',
  });
  service.decide('a1', 'approve', { now: '2026-09-20T13:01:00+08:00' });
  service.consumeGrant({ grantId: 'grant_a1', now: '2026-09-20T13:02:00+08:00' });
  const revoked = service.revoke('a1', '2026-09-20T13:03:00+08:00');
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error?.code, 'ACTION_ALREADY_EXECUTED');
});
