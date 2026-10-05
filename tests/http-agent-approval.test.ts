import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';

test('HTTP Agent path requests a specific grant and commits once on approval', async () => {
  const server = createHttpServer({
    seedDemo: false,
    now: () => '2026-09-20T13:00:00+08:00',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const guest = await fetch(`${baseUrl}/api/v1/session/guest`, { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const created = await fetch(`${baseUrl}/api/v1/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' }),
    });
    const createdBody = (await created.json()) as { data: { trip: { tripId: string } } };
    const tripId = createdBody.data.trip.tripId;

    const planned = await fetch(`${baseUrl}/api/v1/trips/${tripId}/initial-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ baseRevision: 0 }),
    });
    const plannedBody = (await planned.json()) as {
      data: { proposal: { proposalId: string; candidates: Array<{ candidateId: string }> } };
    };
    const proposalId = plannedBody.data.proposal.proposalId;
    const candidateId = plannedBody.data.proposal.candidates[0].candidateId;

    const unauthorized = await fetch(
      `${baseUrl}/api/v1/trips/${tripId}/proposals/${proposalId}/apply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie! },
        body: JSON.stringify({ candidateId, expectedRevision: 0 }),
      },
    );
    assert.equal(unauthorized.status, 403);
    const unauthorizedBody = (await unauthorized.json()) as {
      error: { code: string; details: { operationId: string; actionRequestId: string } };
    };
    assert.equal(unauthorizedBody.error.code, 'ACTION_AUTHORIZATION_REQUIRED');
    const { operationId, actionRequestId } = unauthorizedBody.error.details;
    assert.ok(operationId);
    assert.ok(actionRequestId);

    const approved = await fetch(
      `${baseUrl}/api/v1/trips/${tripId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie! },
        body: JSON.stringify({
          text: '确认应用方案一',
          proposalId,
          operationId,
        }),
      },
    );
    assert.equal(approved.status, 200);
    const approvedBody = (await approved.json()) as {
      data: { execution?: { status: string; result?: { kind?: string } } };
    };
    assert.equal(approvedBody.data.execution?.status, 'succeeded');
    assert.equal(approvedBody.data.execution?.result?.kind, 'agent_result');

    const trip = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      headers: { cookie: cookie! },
    });
    const tripBody = (await trip.json()) as { data: { trip: { revision: number } } };
    assert.equal(tripBody.data.trip.revision, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
