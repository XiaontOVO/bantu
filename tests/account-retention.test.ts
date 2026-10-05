import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { DEMO_SHANGHAI_PLACES } from '../src/demo/demo-data.js';

test('session expiry only exposes an owned, active session', () => {
  let now = '2026-09-20T12:00:00Z';
  const service = new InMemoryTripService(() => now), a = service.createAnonymousSession(60), b = service.createAnonymousSession();
  assert.equal(service.sessionExpiry(a.principal.principalId, a.session.sessionId), '2026-09-20T12:01:00.000Z');
  assert.equal(service.sessionExpiry(b.principal.principalId, a.session.sessionId), undefined);
  now = '2026-09-20T12:01:00Z';
  assert.equal(service.sessionExpiry(a.principal.principalId, a.session.sessionId), undefined);
  service.revokeSession(b.session.sessionId);
  assert.equal(service.sessionExpiry(b.principal.principalId, b.session.sessionId), undefined);
});

test('guest registration retains current and historical data while existing-account login never merges guest data', async () => {
  let now = '2026-09-19T18:00:00+08:00';
  const store = new MemoryStateStore(), server = createHttpServer({ seedDemo: false, stateStore: store, now: () => now });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (path: string, cookie: string, method = 'GET', body?: any) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], ...await response.json() as any };
  };
  const place = DEMO_SHANGHAI_PLACES[0];
  const planBody = { kind: 'plan', name: '游客原安排', localDate: '2026-09-19', timezone: 'Asia/Shanghai', snapshot: { stops: [{ stopId: 'visit', place, startMinutes: 600, endMinutes: 660, status: 'planned' }], routeLegs: [], plannedCharges: [] } };
  try {
    const guest = await call('/api/v1/session/guest', '', 'POST'), cookie = guest.cookie;
    const profile = await call('/api/v1/me', cookie);
    assert.equal(profile.data.expiresAt, '2026-10-19T10:00:00.000Z');
    assert.ok(!['token', 'tokenHash', 'hash', 'salt'].some(field => field in profile.data));
    const historical = await call('/api/v1/plans', cookie, 'POST', planBody);
    const scheme = await call('/api/v1/plans', cookie, 'POST', { kind: 'scheme', name: '游客方案', days: [{ dayIndex: 0, ...planBody.snapshot }] });
    assert.equal(historical.status, 200, JSON.stringify(historical));
    assert.equal(scheme.status, 200, JSON.stringify(scheme));
    const note = await call('/api/v1/memories', cookie, 'POST', { userText: '游客笔记\n保留原文。' });
    await call('/api/v1/favorites', cookie, 'POST', { placeId: place.placeId });
    now = '2026-09-20T18:00:00+08:00';
    const current = await call('/api/v1/plans', cookie, 'POST', { ...planBody, localDate: '2026-09-20' });
    assert.equal(current.status, 200, JSON.stringify(current));
    assert.equal((await call('/api/v1/plans/history', cookie)).data[0].id, historical.data.id);
    const registered = await call('/api/v1/account/register', cookie, 'POST', { username: 'retention_owner', password: '12345678' });
    assert.equal(registered.status, 200); assert.equal(registered.data.principalId, guest.data.principalId);
    assert.equal((await call('/api/v1/me', cookie)).status, 401, 'old cookie is revoked after registration');
    const accountCookie = registered.cookie;
    const activeIds = (await call('/api/v1/plans', accountCookie)).data.map((plan: any) => plan.id);
    assert.ok([scheme.data.id, current.data.id].every(id => activeIds.includes(id)));
    assert.ok(!activeIds.includes(historical.data.id), 'past original is only in history');
    assert.equal((await call(`/api/v1/plans/${historical.data.id}/history`, accountCookie)).data.stops[0].place.placeId, place.placeId);
    assert.equal((await call(`/api/v1/memories/${note.data.memoryId}`, accountCookie)).data.userText, '游客笔记\n保留原文。');
    assert.equal((await call('/api/v1/favorites', accountCookie)).data.length, 1);

    const other = await call('/api/v1/session/guest', '', 'POST'), otherCookie = other.cookie;
    const otherNote = await call('/api/v1/memories', otherCookie, 'POST', { userText: '另一个游客的独立笔记' });
    const failed = await call('/api/v1/account/login', otherCookie, 'POST', { username: 'retention_owner', password: 'wrong_password' });
    assert.equal(failed.status, 400); assert.equal(failed.cookie, undefined, 'failed login does not replace the guest session');
    assert.equal((await call('/api/v1/me', otherCookie)).data.principalId, other.data.principalId);
    assert.equal((await call(`/api/v1/memories/${otherNote.data.memoryId}`, otherCookie)).status, 200);
    const switched = await call('/api/v1/account/login', otherCookie, 'POST', { username: 'retention_owner', password: '12345678' });
    assert.equal(switched.data.principalId, guest.data.principalId);
    assert.equal((await call('/api/v1/me', otherCookie)).status, 401, 'successful login ends the previous guest access');
    assert.equal((await call(`/api/v1/memories/${otherNote.data.memoryId}`, switched.cookie)).status, 404);
    assert.equal((await call('/api/v1/memories', switched.cookie)).data[0].memoryId, note.data.memoryId, 'account data remains independent');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
