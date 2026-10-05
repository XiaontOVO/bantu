import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { InMemoryTripService } from '../src/services/trip-service.js';

async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-20T13:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function createSession(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/session/guest`, { method: 'POST' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie!;
}

async function createTrip(baseUrl: string, cookie: string, body = '{}'): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/trips`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body,
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: { trip: { tripId: string } } };
  return payload.data.trip.tripId;
}

async function assertInvalidInput(response: Response): Promise<void> {
  assert.equal(response.status, 400);
  const body = await response.json() as { error?: { code?: string } };
  assert.equal(body.error?.code, 'INVALID_INPUT');
}

test('required expectedRevision inputs reject missing, fractional, negative, and non-finite values', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const cookie = await createSession(baseUrl);
    const tripId = await createTrip(baseUrl, cookie);
    const invalidRequests: Array<[string, string]> = [
      [`/api/v1/trips/${tripId}/start`, '{}'],
      [`/api/v1/trips/${tripId}/finish`, '{"expectedRevision":1.5}'],
      [`/api/v1/trips/${tripId}/archive`, '{"expectedRevision":1e400}'],
      [`/api/v1/trips/${tripId}/undo`, '{"mutationId":"missing"}'],
      [`/api/v1/trips/${tripId}/plan-edits`, '{"stops":[],"routeLegs":[]}'],
      [`/api/v1/trips/${tripId}/versions/0/proposals`, '{}'],
      [`/api/v1/trips/${tripId}`, '{"expectedRevision":-1}'],
    ];

    for (const [path, body] of invalidRequests) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: path.endsWith(`/${tripId}`) ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body,
      });
      await assertInvalidInput(response);
    }
  } finally {
    await close();
  }
});

test('trip creation and editing reject invalid party size and budget values without mutating the trip', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const cookie = await createSession(baseUrl);
    const invalidCreationBodies = [
      '{"partySize":0}',
      '{"partySize":-1}',
      '{"partySize":1.5}',
      '{"partySize":1e400}',
      '{"partySize":"2"}',
      '{"budgetMinor":-1}',
      '{"budgetMinor":1e400}',
      '{"budgetMinor":"1000"}',
    ];
    for (const body of invalidCreationBodies) {
      const response = await fetch(`${baseUrl}/api/v1/trips`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body,
      });
      await assertInvalidInput(response);
    }

    const tripId = await createTrip(baseUrl, cookie, '{"partySize":2,"budgetMinor":12000}');
    const invalidEdits = [
      '{"expectedRevision":0,"partySize":0}',
      '{"expectedRevision":0,"partySize":1.25}',
      '{"expectedRevision":0,"partySize":1e400}',
      '{"expectedRevision":0,"budget":{"currency":"CNY","limitMinor":-1,"strength":"hard","scope":"trip"}}',
      '{"expectedRevision":0,"budget":{"currency":"CNY","limitMinor":1e400,"strength":"hard","scope":"trip"}}',
      '{"expectedRevision":0,"budget":{"currency":"CNY","strength":"hard","scope":"trip"}}',
    ];
    for (const body of invalidEdits) {
      const response = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body,
      });
      await assertInvalidInput(response);
    }

    const unchanged = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, { headers: { cookie } });
    assert.equal(unchanged.status, 200);
    const unchangedBody = await unchanged.json() as {
      data: { trip: { revision: number }; snapshot: { tripSettings?: { partySize?: number }; budget?: { limitMinor: number | null } } };
    };
    assert.equal(unchangedBody.data.trip.revision, 0);
    assert.equal(unchangedBody.data.snapshot.tripSettings?.partySize, 2);
    assert.equal(unchangedBody.data.snapshot.budget?.limitMinor, 12000);
  } finally {
    await close();
  }
});

test('trip service rejects invalid direct numeric and revision inputs', () => {
  const service = new InMemoryTripService(() => '2026-09-20T13:00:00+08:00');
  const { principal } = service.createAnonymousSession();

  for (const partySize of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    const result = service.createTrip(principal.principalId, {
      cityCode: '330100', dataMode: 'demo', partySize,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT');
  }
  for (const budgetMinor of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
    const result = service.createTrip(principal.principalId, {
      cityCode: '330100', dataMode: 'demo', budgetMinor,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT');
  }

  const created = service.createTrip(principal.principalId, { cityCode: '330100', dataMode: 'demo' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;
  const invalidRevision = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: Number.NaN,
  });
  assert.equal(invalidRevision.ok, false);
  if (!invalidRevision.ok) assert.equal(invalidRevision.error.code, 'INVALID_INPUT');
  const invalidLifecycleRevision = service.startTrip(principal.principalId, tripId, Number.POSITIVE_INFINITY);
  assert.equal(invalidLifecycleRevision.ok, false);
  if (!invalidLifecycleRevision.ok) assert.equal(invalidLifecycleRevision.error.code, 'INVALID_INPUT');

  const invalidEdit = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: 0,
    partySize: 0,
  });
  assert.equal(invalidEdit.ok, false);
  if (!invalidEdit.ok) assert.equal(invalidEdit.error.code, 'INVALID_INPUT');

  const invalidBudgetEdit = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: 0,
    budget: { currency: 'CNY', limitMinor: Number.POSITIVE_INFINITY, strength: 'hard', scope: 'trip' },
  });
  assert.equal(invalidBudgetEdit.ok, false);
  if (!invalidBudgetEdit.ok) assert.equal(invalidBudgetEdit.error.code, 'INVALID_INPUT');
});
