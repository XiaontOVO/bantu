import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';

test('HTTP scheme loading detects and shifts a live stop crossing midnight without blocking later plans', async () => {
  let now = '2026-10-01T23:50:00+08:00';
  const server = createHttpServer({ seedDemo: false, now: () => now });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const guest = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    assert.equal(guest.status, 200);
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, {
        method,
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, ...(await response.json() as any) };
    };

    const trip = await call('/api/v1/trips', 'POST', { cityCode: '310100', dataMode: 'demo' });
    assert.equal(trip.status, 200);
    const tripId = trip.data.trip.tripId as string;
    const patched = await call(`/api/v1/trips/${tripId}/plan-edits`, 'POST', {
      expectedRevision: trip.data.trip.revision,
      stops: [{
        stopId: 'overnight-active', placeId: 'overnight-active',
        place: { placeId: 'overnight-active', name: '跨夜地点', coordinates: null, facilityCodes: [] },
        startMinutes: 1430, endMinutes: 1490, departureMinutes: 1490,
      }],
      routeLegs: [],
    });
    assert.equal(patched.status, 200);

    const departed = await call(`/api/v1/trips/${tripId}/execution-events`, 'POST', {
      stopId: 'overnight-active', type: 'depart', occurredAt: now,
    });
    assert.equal(departed.status, 200);
    now = '2026-10-02T00:10:00+08:00';

    const earlyScheme = await call('/api/v1/plans', 'POST', {
      kind: 'scheme', name: '凌晨安排',
      days: [{ dayIndex: 0, stops: [{
        stopId: 'early-candidate', placeId: 'early-candidate',
        place: { placeId: 'early-candidate', name: '凌晨候选地点' },
        startMinutes: 15, endMinutes: 75,
      }] }],
    });
    assert.equal(earlyScheme.status, 200);

    const conflict = await call(`/api/v1/plans/${earlyScheme.data.id}/load`, 'POST', {
      startDate: '2026-10-02', tripId,
    });
    assert.equal(conflict.status, 200);
    assert.equal(conflict.data.progressConflict, true);
    assert.deepEqual(conflict.data.progressConflicts, [{ date: '2026-10-02', names: ['跨夜地点', '凌晨候选地点'], timeOverlap: true }]);

    const imported = await call(`/api/v1/plans/${earlyScheme.data.id}/load`, 'POST', {
      startDate: '2026-10-02', tripId, confirmProgressConflict: true,
      confirmationToken: conflict.data.confirmationToken,
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.data.plans[0].localDate, '2026-10-02');
    assert.equal(imported.data.plans[0].stops[0].startMinutes, 50, 'the accepted plan starts after the active stop’s planned end');
    await call(`/api/v1/plans/${imported.data.plans[0].id}`, 'DELETE');

    const noonScheme = await call('/api/v1/plans', 'POST', {
      kind: 'scheme', name: '午后安排',
      days: [{ dayIndex: 0, stops: [{
        stopId: 'noon-candidate', placeId: 'noon-candidate',
        place: { placeId: 'noon-candidate', name: '午后候选地点' },
        startMinutes: 12 * 60, endMinutes: 13 * 60,
      }] }],
    });
    assert.equal(noonScheme.status, 200);
    const noonLoad = await call(`/api/v1/plans/${noonScheme.data.id}/load`, 'POST', {
      startDate: '2026-10-02', tripId,
    });
    assert.equal(noonLoad.status, 200);
    assert.equal(noonLoad.data.progressConflict, undefined, 'a noon plan does not overlap the interval ending at 00:50');
    assert.equal(noonLoad.data.plans[0].stops[0].startMinutes, 12 * 60);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
