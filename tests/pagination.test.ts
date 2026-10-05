import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';

test('list endpoints clamp limit and return an opaque nextCursor', async () => {
  const server = createHttpServer({ seedDemo: false });
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

    for (const text of ['记录一', '记录二', '记录三']) {
      await fetch(`${baseUrl}/api/v1/trips/${tripId}/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie! },
        body: JSON.stringify({ userText: text }),
      });
    }
    const first = await fetch(
      `${baseUrl}/api/v1/trips/${tripId}/memories?limit=2`,
      { headers: { cookie: cookie! } },
    );
    const firstBody = (await first.json()) as {
      data: unknown[];
      meta: { nextCursor: number | null };
    };
    assert.equal(firstBody.data.length, 2);
    assert.equal(firstBody.meta.nextCursor, 2);

    const second = await fetch(
      `${baseUrl}/api/v1/trips/${tripId}/memories?limit=2&cursor=2`,
      { headers: { cookie: cookie! } },
    );
    const secondBody = (await second.json()) as {
      data: unknown[];
      meta: { nextCursor: number | null };
    };
    assert.equal(secondBody.data.length, 1);
    assert.equal(secondBody.meta.nextCursor, null);

    const places = await fetch(`${baseUrl}/api/v1/places?limit=2`, {
      headers: { cookie: cookie! },
    });
    const placesBody = (await places.json()) as {
      data: unknown[];
      meta: { nextCursor: number | null };
    };
    assert.equal(placesBody.data.length, 2);
    assert.equal(placesBody.meta.nextCursor, 2);

    const filtered = await fetch(
      `${baseUrl}/api/v1/places?query=${encodeURIComponent('书院')}`,
      { headers: { cookie: cookie! } },
    );
    const filteredBody = (await filtered.json()) as {
      data: Array<{ placeId: string; name: string }>;
    };
    assert.equal(filteredBody.data.length, 1);
    assert.ok(filteredBody.data[0].name.includes('书院'));

    const shortlist = await fetch(`${baseUrl}/api/v1/trips/${tripId}/shortlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({ placeId: filteredBody.data[0].placeId }),
    });
    assert.equal(shortlist.status, 200);
    const shortlistBody = (await shortlist.json()) as { data: string[] };
    assert.deepEqual(shortlistBody.data, [filteredBody.data[0].placeId]);
    const shortlistRead = await fetch(`${baseUrl}/api/v1/trips/${tripId}/shortlist`, {
      headers: { cookie: cookie! },
    });
    const shortlistReadBody = (await shortlistRead.json()) as { data: string[] };
    assert.deepEqual(shortlistReadBody.data, [filteredBody.data[0].placeId]);

    const route = await fetch(`${baseUrl}/api/v1/trips/${tripId}/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie! },
      body: JSON.stringify({
        from: { lat: 30.259, lng: 120.149 },
        to: { lat: 30.256, lng: 120.153 },
        transportMode: 'walking',
      }),
    });
    assert.equal(route.status, 200);
    const routeBody = (await route.json()) as {
      data: { leg: { walkingMeters?: number; transportMode: string } };
    };
    assert.equal(routeBody.data.leg.transportMode, 'walking');
    assert.ok((routeBody.data.leg.walkingMeters ?? 0) > 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
