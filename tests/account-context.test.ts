import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { DEMO_PLACE_IDS } from '../src/demo/demo-data.js';

async function harness() {
  const server = createHttpServer({ seedDemo: false });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, cookie = '', method = 'GET', body?: unknown, expected?: string) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json', ...(expected ? { 'x-bantu-principal': expected } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie, ...(await response.json() as any) };
  };
  const first = await call('/api/v1/session/guest', '', 'POST');
  const a = await call('/api/v1/account/register', first.cookie, 'POST', { username: 'bantu_xiaoai', password: '12345678' });
  const second = await call('/api/v1/session/guest', '', 'POST');
  const b = await call('/api/v1/account/register', second.cookie, 'POST', { username: 'bantu_xiaobei', password: '12345678' });
  return { call, a, b, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('an old tab cannot read or save a note under a different cookie account', async () => {
  const h = await harness();
  try {
    const path = `/api/v1/places/${DEMO_PLACE_IDS.wukang}/note`;
    assert.equal((await h.call(path, h.b.cookie, 'POST', { note: '小北原备注' }, h.b.data.principalId)).status, 200);
    for (const method of ['GET', 'POST']) {
      const stale = await h.call(path, h.b.cookie, method, method === 'POST' ? { note: '小艾正在写' } : undefined, h.a.data.principalId);
      assert.equal(stale.status, 409); assert.equal(stale.error.code, 'SESSION_CHANGED'); assert.equal(stale.data, undefined);
    }
    assert.equal((await h.call(path, h.b.cookie)).data.note, '小北原备注');
    assert.equal((await h.call(path, h.a.cookie)).data.note, '');
    assert.equal((await h.call(path, h.a.cookie, 'POST', { note: '小艾正在写' }, h.a.data.principalId)).status, 200);
    assert.equal((await h.call(path, h.a.cookie)).data.note, '小艾正在写');
  } finally { await h.close(); }
});

test('account mismatch blocks mutations before route processing, including logout and account creation', async () => {
  const h = await harness();
  try {
    for (const [path, method] of [
      ['/api/v1/me', 'PATCH'], ['/api/v1/session', 'DELETE'], ['/api/v1/account/register', 'POST'],
      ['/api/v1/plans', 'POST'], ['/api/v1/memories', 'POST'], ['/api/v1/favorites', 'POST'], ['/api/v1/community/posts', 'POST'],
    ]) {
      const result = await h.call(path, h.b.cookie, method, method === 'DELETE' ? undefined : {}, h.a.data.principalId);
      assert.equal(result.status, 409, path); assert.equal(result.error.code, 'SESSION_CHANGED');
    }
    assert.equal((await h.call('/api/v1/me', h.b.cookie)).data.principalId, h.b.data.principalId);
    assert.equal((await h.call('/api/v1/community/mine', h.b.cookie)).data.posts.length, 0);
  } finally { await h.close(); }
});

test('page identity is a consistency check and never authorizes an unauthenticated request', async () => {
  const h = await harness();
  try {
    const denied = await h.call('/api/v1/me', '', 'GET', undefined, h.a.data.principalId);
    assert.equal(denied.status, 401); assert.equal(denied.error.code, 'SESSION_EXPIRED');
    assert.equal((await h.call('/api/v1/me', h.a.cookie, 'GET', undefined, 'invalid page id')).status, 400);
    const restored = await h.call('/api/v1/session/guest', h.b.cookie, 'POST', undefined, h.a.data.principalId);
    assert.equal(restored.data.principalId, h.b.data.principalId); assert.equal(restored.data.restored, true);
    assert.equal((await h.call('/api/v1/me', h.b.cookie)).status, 200, 'existing clients without the optional consistency header retain cookie-based authorization');
  } finally { await h.close(); }
});
