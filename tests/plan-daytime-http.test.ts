import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

test('daytime HTTP requires review and ownership, preserves plans on conflict, and survives server recovery', async () => {
  const store = new MemoryStateStore();
  const options = { seedDemo: false, now: () => '2099-09-29T22:00:00+08:00', stateStore: store };
  let server = createHttpServer(options), base = '', cookie = '';
  const listen = async () => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as any).port}`; };
  const request = async (path: string, method = 'GET', body?: unknown, session = cookie) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(session ? { cookie: session } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const set = response.headers.get('set-cookie'); if (set && session === cookie) cookie = set.split(';')[0];
    return { status: response.status, body: await response.json() as any };
  };
  const visit = (stopId: string, startMinutes: number) => ({ stopId, place: { placeId: 'same', name: '同一地点' }, startMinutes, endMinutes: startMinutes + 60 });
  try {
    await listen(); await request('/api/v1/session/guest', 'POST');
    await request('/api/v1/account/register', 'POST', { username: 'bantu_daytime_test', password: '12345678' });
    const source = (await request('/api/v1/plans', 'POST', { kind: 'plan', name: '原日', localDate: '2099-09-29', snapshot: { stops: [visit('a', 600), visit('repeat', 720)], routeLegs: [], plannedCharges: [] } })).body.data;
    const path = `/api/v1/plans/${source.id}/daytime-`;
    const before = (await request('/api/v1/plans')).body.data;
    assert.equal((await request(path + 'preview', 'POST', { stopId: 'a' })).status, 400);
    assert.equal((await request(path + 'apply', 'POST', { stopId: 'a', expectedRevision: 0 })).status, 409);
    const preview = (await request(path + 'preview', 'POST', { stopId: 'a', expectedRevision: 0 })).body.data;
    assert.deepEqual((await request('/api/v1/plans')).body.data, before, 'preview cannot modify plans');
    const visitor = await fetch(base + '/api/v1/session/guest', { method: 'POST' }), other = visitor.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request(path + 'preview', 'POST', { stopId: 'a', expectedRevision: 0 }, other)).status, 400);
    assert.equal((await request(path + 'apply', 'POST', { stopId: 'a', expectedRevision: 0, previewKey: preview.previewKey }, other)).status, 400);
    await request('/api/v1/plans', 'POST', { kind: 'plan', name: '后来创建次日', localDate: '2099-09-30', snapshot: { stops: [visit('target', 540)], routeLegs: [] } });
    const beforeConflict = (await request('/api/v1/plans')).body.data;
    assert.equal((await request(path + 'apply', 'POST', { stopId: 'a', expectedRevision: 0, previewKey: preview.previewKey })).status, 409);
    assert.deepEqual((await request('/api/v1/plans')).body.data, beforeConflict);
    const updated = (await request(path + 'preview', 'POST', { stopId: 'a', expectedRevision: 0 })).body.data;
    const applied = await request(path + 'apply', 'POST', { stopId: 'a', expectedRevision: 0, previewKey: updated.previewKey });
    assert.equal(applied.status, 200); assert.equal(applied.body.data.movedCount, 2);
    const saved = (await request('/api/v1/plans')).body.data;
    assert.equal(saved.find((plan: any) => plan.id === source.id).stops.length, 0);
    const target = saved.find((plan: any) => plan.localDate === '2099-09-30');
    assert.deepEqual(target.stops.map((stop: any) => [stop.stopId, stop.startMinutes]), [['target', 540], ['a', 600], ['repeat', 660]]);
    assert.equal(target.executionEvents.length, 0);
    assert.equal((await request(path + 'apply', 'POST', { stopId: 'a', expectedRevision: 0, previewKey: updated.previewKey })).status, 409);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    server = createHttpServer(options); await listen();
    await request('/api/v1/account/login', 'POST', { username: 'bantu_daytime_test', password: '12345678' });
    assert.deepEqual((await request('/api/v1/plans')).body.data, saved);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
