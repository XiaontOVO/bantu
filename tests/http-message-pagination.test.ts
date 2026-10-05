import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';

test('trip chat loads the latest page first and can page backward across a redacted cursor', async () => {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-20T12:00:00+08:00' });
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
    assert.equal(created.status, 200);
    const tripId = (await created.json() as { data: { trip: { tripId: string } } }).data.trip.tripId;
    const path = `/api/v1/trips/${tripId}/messages`;
    const expectedIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const sent: Response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie! },
        body: JSON.stringify({ text: `对话 ${index + 1}`, clientMessageId: `pagination-${index}` }),
      });
      assert.equal(sent.status, 200);
      const { data } = await sent.json() as { data: { userMessage: { messageId: string }; assistantMessage: { messageId: string } } };
      expectedIds.push(data.userMessage.messageId, data.assistantMessage.messageId);
    }

    const latestResponse = await fetch(`${baseUrl}${path}?limit=20`, { headers: { cookie: cookie! } });
    const latest = await latestResponse.json() as { data: Array<{ messageId: string }>; meta: { nextCursor: string | null } };
    assert.equal(latest.data.length, 20);
    assert.deepEqual(latest.data.map((message) => message.messageId), expectedIds.slice(4));
    assert.equal(latest.meta.nextCursor, expectedIds[4]);

    const redacted = await fetch(`${baseUrl}${path}/${encodeURIComponent(latest.meta.nextCursor!)}`, {
      method: 'DELETE', headers: { cookie: cookie! },
    });
    assert.equal(redacted.status, 200);
    const earlierResponse = await fetch(`${baseUrl}${path}?limit=20&before=${encodeURIComponent(latest.meta.nextCursor!)}`, {
      headers: { cookie: cookie! },
    });
    const earlier = await earlierResponse.json() as { data: Array<{ messageId: string }>; meta: { nextCursor: string | null } };
    assert.deepEqual(earlier.data.map((message) => message.messageId), expectedIds.slice(0, 4));
    assert.equal(earlier.meta.nextCursor, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
