import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, InMemoryTripService } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { makeStop } from './helpers.js';

const now = '2026-09-20T16:30:00.000Z'; // 2026-09-21 01:30 in Asia/Tokyo.

test('freeform memory dates default to the trip-local day while explicit journal dates win', () => {
  const service = new InMemoryTripService(() => now);
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-22',
    timezone: 'Asia/Tokyo',
    dataMode: 'demo',
  });
  assert.ok(created.ok);
  if (!created.ok) return;

  const freeform = service.createMemory(principal.principalId, created.value.trip.tripId, {
    userText: '今天的随手记',
  });
  assert.ok(freeform.ok);
  if (!freeform.ok) return;
  assert.equal(freeform.value.memory?.localDate, '2026-09-21');

  const dayJournal = service.createMemory(principal.principalId, created.value.trip.tripId, {
    userText: '补写前一天的感想',
    localDate: '2026-09-20',
  });
  assert.ok(dayJournal.ok);
  if (!dayJournal.ok) return;
  assert.equal(dayJournal.value.memory?.localDate, '2026-09-20');
});

test('the memories HTTP endpoint assigns the trip-local day to notes without an explicit date', async () => {
  const stateStore = new MemoryStateStore();
  const server = createHttpServer({ now: () => now, stateStore });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  if (!address || typeof address === 'string') return;

  const base = `http://127.0.0.1:${address.port}`;
  try {
    const guest = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    assert.equal(guest.status, 200);
    const cookie = guest.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    if (!cookie) return;

    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json() as { data?: unknown; error?: unknown };
      return { status: response.status, data: payload.data, error: payload.error };
    };

    const created = await call('/api/v1/trips', 'POST', {
      cityCode: '330100', localDate: '2026-09-22', timezone: 'Asia/Tokyo', dataMode: 'demo',
    });
    assert.equal(created.status, 200);
    const trip = created.data as { trip: { tripId: string } };
    const saved = await call(`/api/v1/trips/${trip.trip.tripId}/memories`, 'POST', {
      userText: 'Agent 留下的记录',
    });
    assert.equal(saved.status, 200);
    const result = saved.data as { memory: { localDate?: string } };
    assert.equal(result.memory.localDate, '2026-09-21');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    stateStore.close();
  }
});

test('retrying manual generation after expiry keeps the frozen memory and its idempotency', () => {
  let currentTime = '2026-09-20T08:50:00+08:00';
  const service = new InMemoryTripService(() => currentTime);
  const { principal, session } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100', localDate: '2026-09-20', timezone: 'Asia/Shanghai', dataMode: 'demo',
  });
  assert.ok(created.ok);
  if (!created.ok) return;

  const planned = service.patchTrip(principal.principalId, created.value.trip.tripId, {
    expectedRevision: created.value.trip.revision,
    stops: [makeStop({ stopId: 'remembered-stop', placeId: 'river_walk' })],
  });
  assert.ok(planned.ok);
  if (!planned.ok) return;

  const record = (type: 'depart' | 'arrive' | 'complete', at: string) => {
    currentTime = at;
    return service.recordExecution({
      actorId: principal.principalId,
      sessionId: session.sessionId,
      tripId: created.value.trip.tripId,
      stopId: 'remembered-stop',
      type,
      occurredAt: at,
    });
  };
  for (const [type, at] of [
    ['depart', '2026-09-20T09:00:00+08:00'],
    ['arrive', '2026-09-20T09:10:00+08:00'],
    ['complete', '2026-09-20T09:30:00+08:00'],
  ] as const) {
    const result = record(type, at);
    assert.ok(result.ok);
  }

  const first = service.generateJourneyMemory(principal.principalId, created.value.trip.tripId, '2026-09-20');
  assert.ok(first.ok);
  if (!first.ok) return;
  const originalId = first.value.memory?.memoryId;
  assert.ok(originalId);
  assert.equal(first.value.memory?.staleAt, null);

  currentTime = '2026-09-21T00:01:00+08:00';
  service.purgePastProgress();
  const retried = service.generateJourneyMemory(principal.principalId, created.value.trip.tripId, '2026-09-20');
  assert.ok(retried.ok);
  if (!retried.ok) return;
  assert.equal(retried.value.memory?.memoryId, originalId);
  assert.equal(retried.value.memory?.staleAt, null);

  const listed = service.listMemories(principal.principalId, created.value.trip.tripId);
  assert.ok(listed.ok);
  if (listed.ok) {
    assert.equal(listed.value.filter(entry => entry?.journey?.localDate === '2026-09-20').length, 1);
  }
});
