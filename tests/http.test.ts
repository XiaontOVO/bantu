import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';

async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createHttpServer({
    seedDemo: false,
    now: () => '2026-09-20T13:00:00+08:00',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('HTTP trip creation defaults the date to today and rejects future execution facts', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const guest = await fetch(`${baseUrl}/api/v1/session/guest`, { method: 'POST' });
    assert.equal(guest.status, 200);
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);

    const created = await fetch(`${baseUrl}/api/v1/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ cityCode: '330100', dataMode: 'demo' }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json() as { data: { trip: { tripId: string; localDate: string }; snapshot: { travelDate?: string }; clock: { relation: string } } };
    const tripId = createdBody.data.trip.tripId;
    assert.equal(createdBody.data.trip.localDate, '2026-09-20');
    assert.equal(createdBody.data.snapshot.travelDate, '2026-09-20');
    assert.equal(createdBody.data.clock.relation, 'today');

    const planned = await fetch(`${baseUrl}/api/v1/trips/${tripId}/plan-edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({
        expectedRevision: 0,
        stops: [{ stopId: 'future-stop', placeId: 'future-stop', startMinutes: 14 * 60, endMinutes: 15 * 60, departureMinutes: 15 * 60 }],
        routeLegs: [],
      }),
    });
    assert.equal(planned.status, 200);

    const overlappingPlan = await fetch(`${baseUrl}/api/v1/trips/${tripId}/plan-edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({
        expectedRevision: 1,
        stops: [
          { stopId: 'first', placeId: 'first', startMinutes: 14 * 60, endMinutes: 15 * 60 },
          { stopId: 'second', placeId: 'second', startMinutes: 14 * 60 + 30, endMinutes: 15 * 60 + 30 },
        ],
        routeLegs: [],
      }),
    });
    assert.equal(overlappingPlan.status, 409, 'a schedule conflict is a conflict response, not malformed input');
    const overlapError = await overlappingPlan.json() as { error: { code: string } };
    assert.equal(overlapError.error.code, 'PLAN_TIME_OR_PROGRESS_CONFLICT');

    const futureExecution = await fetch(`${baseUrl}/api/v1/trips/${tripId}/execution-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ stopId: 'future-stop', type: 'depart', occurredAt: '2026-09-20T14:00:00+08:00' }),
    });
    assert.equal(futureExecution.status, 409);
    const error = await futureExecution.json() as { error: { code: string } };
    assert.equal(error.error.code, 'EXECUTION_DATE_CONFLICT');

    const invalidExecution = await fetch(`${baseUrl}/api/v1/trips/${tripId}/execution-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ stopId: 'future-stop', type: 'teleport', occurredAt: '2026-09-20T12:00:00+08:00' }),
    });
    assert.equal(invalidExecution.status, 400);

    const invalidDate = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ expectedRevision: 1, localDate: '2026-02-30' }),
    });
    assert.equal(invalidDate.status, 400);

    const invalidDateType = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ expectedRevision: 1, localDate: 20260920 }),
    });
    assert.equal(invalidDateType.status, 400);

    const unchanged = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, { headers: { cookie: cookie! } });
    assert.equal(unchanged.status, 200);
    const unchangedBody = await unchanged.json() as { data: { trip: { revision: number; localDate: string } } };
    assert.equal(unchangedBody.data.trip.revision, 1);
    assert.equal(unchangedBody.data.trip.localDate, '2026-09-20');

    const oversized = await fetch(`${baseUrl}/api/v1/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ nickname: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await close();
  }
});

test('HTTP prototype exposes guest session, trip creation, proposal, approval and apply', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const ready = await fetch(`${baseUrl}/api/v1/ready`);
    assert.equal(ready.status, 200);
    const readyBody = (await ready.json()) as {
      data: { status: string; checks: { stateStore: string; rateLimiter: string } };
    };
    assert.equal(readyBody.data.status, 'ok');
    assert.equal(readyBody.data.checks.stateStore, 'memory');
    assert.equal(readyBody.data.checks.rateLimiter, 'process_local');

    const guest = await fetch(`${baseUrl}/api/v1/session/guest`, { method: 'POST' });
    assert.equal(guest.status, 200);
    const guestBody = (await guest.json()) as { data: { principalId: string } };
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    assert.ok(guestBody.data.principalId);

    const created = await fetch(`${baseUrl}/api/v1/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({
        cityCode: '330100',
        localDate: '2026-09-20',
        dataMode: 'demo',
      }),
    });
    assert.equal(created.status, 200);
    const createdBody = (await created.json()) as {
      data: { trip: { tripId: string; revision: number } };
    };
    const tripId = createdBody.data.trip.tripId;

    const planned = await fetch(`${baseUrl}/api/v1/trips/${tripId}/initial-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ baseRevision: 0 }),
    });
    assert.equal(planned.status, 200);
    const plannedBody = (await planned.json()) as {
      data: {
        operationId: string;
        proposal: {
          proposalId: string;
          candidates: Array<{ candidateId: string }>;
        };
        result: { proposalId: string };
      };
    };
    const proposalId = plannedBody.data.proposal.proposalId;
    const candidateId = plannedBody.data.proposal.candidates[0].candidateId;

    const toolExecutions = await fetch(
      `${baseUrl}/api/v1/operations/${plannedBody.data.operationId}/tool-executions`,
      { headers: { cookie: cookie! } },
    );
    assert.equal(toolExecutions.status, 200);
    const toolExecutionBody = (await toolExecutions.json()) as {
      data: Array<{ toolName: string; status: string }>;
    };
    assert.ok(toolExecutionBody.data.some((item) => item.toolName === 'plan.propose'));

    const proposal = await fetch(
      `${baseUrl}/api/v1/trips/${tripId}/proposals/${proposalId}`,
      { headers: { cookie: cookie! } },
    );
    assert.equal(proposal.status, 200);
    const proposalBody = (await proposal.json()) as {
      data: { actionRequests: Array<{ actionRequestId: string; candidateId: string }> };
    };
    const actionRequest = proposalBody.data.actionRequests.find(
      (item) => item.candidateId === candidateId,
    );
    assert.ok(actionRequest);

    const decision = await fetch(
      `${baseUrl}/api/v1/trips/${tripId}/action-requests/${actionRequest.actionRequestId}/decisions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie! },
        body: JSON.stringify({ decision: 'approve' }),
      },
    );
    assert.equal(decision.status, 200);
    const decisionBody = (await decision.json()) as {
      data: { grant?: { grantId: string } };
    };
    const grantId = decisionBody.data.grant?.grantId;
    assert.ok(grantId);

    const applied = await fetch(
      `${baseUrl}/api/v1/trips/${tripId}/proposals/${proposalId}/apply`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookie!,
          'idempotency-key': 'http-apply-1',
        },
        body: JSON.stringify({
          candidateId,
          expectedRevision: 0,
          actionRequestId: actionRequest.actionRequestId,
          grantId,
        }),
      },
    );
    assert.equal(applied.status, 200);
    const appliedBody = (await applied.json()) as {
      data: {
        revision: number;
        mutationId: string;
        trip: { snapshot: { stops: unknown[] } };
      };
    };
    assert.equal(appliedBody.data.revision, 1);
    assert.ok(appliedBody.data.trip.snapshot.stops.length > 0);

    const undone = await fetch(`${baseUrl}/api/v1/trips/${tripId}/undo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookie!,
        'idempotency-key': 'http-undo-1',
      },
      body: JSON.stringify({
        mutationId: appliedBody.data.mutationId,
        expectedRevision: 1,
      }),
    });
    assert.equal(undone.status, 200);
    const undoneBody = (await undone.json()) as { data: { revision: number } };
    assert.equal(undoneBody.data.revision, 2);

    const trip = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      headers: { cookie: cookie! },
    });
    assert.equal(trip.status, 200);
    const tripBody = (await trip.json()) as { data: { trip: { revision: number } } };
    assert.equal(tripBody.data.trip.revision, 2);

    const memoryMessage = await fetch(`${baseUrl}/api/v1/trips/${tripId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ text: '记下：今天和妈妈逛得很开心' }),
    });
    assert.equal(memoryMessage.status, 200);
    const memoryReply = (await memoryMessage.json()) as {
      data: { status: string; assistantMessage: { text: string } };
    };
    assert.equal(memoryReply.data.status, 'recorded');
    assert.ok(memoryReply.data.assistantMessage.text.includes('保存'));

    const messages = await fetch(`${baseUrl}/api/v1/trips/${tripId}/messages`, {
      headers: { cookie: cookie! },
    });
    assert.equal(messages.status, 200);
    const messagesBody = (await messages.json()) as { data: unknown[] };
    assert.equal(messagesBody.data.length, 2);
  } finally {
    await close();
  }
});

test('health reports the actual offline defaults instead of the wrapped demo providers as online', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/v1/ready`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { dataMode: string; checks: { placeProvider: string; routeProvider: string } } };
    assert.equal(body.data.dataMode, 'demo');
    assert.equal(body.data.checks.placeProvider, 'demo');
    assert.equal(body.data.checks.routeProvider, 'demo');
  } finally {
    await close();
  }
});
