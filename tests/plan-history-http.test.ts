import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

test('history HTTP keeps complete facts, protects ownership and revisions, and survives server recovery', async () => {
  let now = '2026-09-19T18:00:00+08:00'; const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, now: () => now, stateStore: store });
  const listen = async () => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as any).port}`; };
  let base = await listen(), cookie = '';
  const request = async (path: string, method = 'GET', body?: any, auth = cookie) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { cookie: auth } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const session = response.headers.get('set-cookie'); if (session && auth === cookie) cookie = session.split(';')[0];
    return { response, body: await response.json() as any };
  };
  try {
    await request('/api/v1/session/guest', 'POST');
    await request('/api/v1/account/register', 'POST', { username: 'bantu_history_test', password: '12345678' });
    const stops = ['a', 'b'].map((id, index) => ({ stopId: id, place: { placeId: id, name: id }, startMinutes: 600 + index * 100, endMinutes: 660 + index * 100, status: 'planned' }));
    const saved = await request('/api/v1/plans', 'POST', { kind: 'plan', name: '原日计划', localDate: '2026-09-19', timezone: 'Asia/Shanghai', snapshot: { stops, routeLegs: [], plannedCharges: [] } });
    assert.equal(saved.response.ok, true); const id = saved.body.data.id;
    for (const [index, [type, occurredAt]] of [['arrive', '2026-09-19T10:00:00+08:00'], ['complete', '2026-09-19T10:45:00+08:00']].entries()) {
      assert.equal((await request(`/api/v1/plans/${id}/execution-events`, 'POST', { stopId: 'a', type, occurredAt, expectedRevision: index })).response.ok, true);
    }
    now = '2026-09-20T10:00:00+08:00';
    const listed = await request('/api/v1/plans'); assert.equal(listed.body.data.some((plan: any) => plan.id === id), false);
    const history = await request('/api/v1/plans/history?limit=1'); assert.equal(history.body.data[0].id, id);
    assert.equal(history.body.data[0].completedCount, 1); assert.equal(history.body.data[0].executionEvents, undefined, 'list is a compact summary');
    const detail = await request(`/api/v1/plans/${id}/history`); assert.equal(detail.body.data.executionEvents.length, 2);
    const visitor = await fetch(base + '/api/v1/session/guest', { method: 'POST' }); const otherCookie = visitor.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request(`/api/v1/plans/${id}/history`, 'GET', undefined, otherCookie)).response.ok, false);
    assert.equal((await request('/api/v1/plans/history', 'GET', undefined, otherCookie)).body.data.length, 0);
    assert.equal((await request(`/api/v1/plans/${id}/history/backfill`, 'POST', { stopId: 'b', type: 'complete', occurredAt: '2026-09-19T12:00:00+08:00' })).response.status, 400);
    assert.equal((await request(`/api/v1/plans/${id}/history/backfill`, 'POST', { stopId: 'b', type: 'complete', occurredAt: '2026-09-19T12:00:00+08:00', expectedRevision: 1 })).response.status, 409);
    const filled = await request(`/api/v1/plans/${id}/history/backfill`, 'POST', { stopId: 'b', type: 'complete', arrivedAt: '2026-09-19T11:15:00+08:00', occurredAt: '2026-09-19T12:00:00+08:00', expectedRevision: 2 });
    assert.equal(filled.response.ok, true); assert.equal(filled.body.data.executionEvents.length, 4);
    const corrected = await request(`/api/v1/plans/${id}/history/corrections`, 'POST', { eventId: filled.body.data.executionEvents[1].executionEventId, status: 'planned', reason: '完成误记', expectedRevision: 3 });
    assert.equal(corrected.response.ok, true); assert.equal(corrected.body.data.executionEvents.length, 5);
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: false, now: () => now, stateStore: store }); base = await listen();
    const recovered = await request(`/api/v1/plans/${id}/history`);
    assert.equal(recovered.response.ok, true); assert.equal(recovered.body.data.executionEvents.length, 5); assert.equal(recovered.body.data.revision, 4);
    now = '2026-10-20T00:00:00+08:00';
    await request('/api/v1/account/login', 'POST', { username: 'bantu_history_test', password: '12345678' });
    assert.equal((await request(`/api/v1/plans/${id}/history`)).body.data.canEditHistory, false);
    assert.equal((await request(`/api/v1/plans/${id}/history/corrections`, 'POST', { eventId: recovered.body.data.executionEvents[4].executionEventId, status: 'completed', expectedRevision: 4 })).response.ok, false);
    assert.equal((await request(`/api/v1/plans/${id}/history`, 'DELETE', { expectedRevision: 4 }, otherCookie)).response.ok, false);
    assert.equal((await request(`/api/v1/plans/${id}/history`, 'DELETE', { expectedRevision: 4 })).response.ok, true);
    assert.equal((await request('/api/v1/plans/history')).body.data.length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
