import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

async function harness() {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'test-review-token' });
  let base = '';
  const start = async () => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`; };
  const stop = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  await start();
  let cookie = (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, method = 'GET', body?: unknown, token?: string) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json', ...(token ? { 'x-community-admin-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { status: response.status, ...(await response.json() as any) };
  };
  await call('/api/v1/account/register', 'POST', { username: 'bantu_xiaoai', password: '12345678' });
  const created = await call('/api/v1/community/places', 'POST', { name: '审核界面测试点', cityCode: '310100', address: '隔离测试地址', description: '仅测试审核资料，不作为推荐' });
  assert.equal(created.status, 200);
  const path = `/api/v1/community/places/${created.data.id}`;
  const submitted = await call(path + '/submit', 'POST', { lat: 31.21, lng: 121.43, coordinateCrs: 'WGS84', evidence: '初次公开资料依据' });
  assert.equal(submitted.status, 200);
  return { call, path, close: stop, restart: async () => { await stop(); server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'test-review-token' }); await start(); } };
}

test('review credentials protect coordinates and private application data; queue includes the submitted location and version', async () => {
  const h = await harness();
  try {
    for (const token of [undefined, 'invalid']) {
      const response = await h.call('/api/v1/community/moderation', 'GET', undefined, token);
      assert.equal(response.status, 403); assert.equal(response.data, undefined);
    }
    const response = await h.call('/api/v1/community/moderation', 'GET', undefined, 'test-review-token');
    assert.equal(response.status, 200);
    const item = response.data.pending[0];
    assert.equal(item.lat, 31.21); assert.equal(item.lng, 121.43); assert.equal(item.coordinateCrs, 'WGS84');
    assert.equal(item.submissionVersion, 1); assert.equal(item.evidence, '初次公开资料依据'); assert.equal(item.authorId, undefined);
  } finally { await h.close(); }
});

test('an old review cannot approve new evidence or coordinates after rejection and resubmission', async () => {
  const h = await harness();
  try {
    const reject = await h.call(h.path + '/decision', 'POST', { decision: 'rejected', note: '需要核对坐标', expectedSubmissionVersion: 1 }, 'test-review-token');
    assert.equal(reject.status, 200);
    const again = await h.call(h.path + '/submit', 'POST', { lat: 31.22, lng: 121.44, coordinateCrs: 'WGS84', evidence: '补充后的依据' });
    assert.equal(again.status, 200);
    const stale = await h.call(h.path + '/decision', 'POST', { decision: 'approved', note: '旧资料核对通过', expectedSubmissionVersion: 1 }, 'test-review-token');
    assert.equal(stale.status, 409); assert.equal(stale.error.code, 'REVISION_CONFLICT');
    const queue = await h.call('/api/v1/community/moderation', 'GET', undefined, 'test-review-token');
    assert.equal(queue.data.pending[0].submissionVersion, 2); assert.equal(queue.data.pending[0].evidence, '补充后的依据');
    const fresh = await h.call(h.path + '/decision', 'POST', { decision: 'approved', note: '新资料核对通过', expectedSubmissionVersion: 2 }, 'test-review-token');
    assert.equal(fresh.status, 200); assert.equal(fresh.data.status, 'approved');
    assert.equal(fresh.data.lat, 31.22); assert.equal(fresh.data.lng, 121.44);
  } finally { await h.close(); }
});

test('review versions survive restart and an already decided application cannot produce a second log entry', async () => {
  const h = await harness();
  try {
    await h.restart();
    const body = { decision: 'approved', note: '核对通过', expectedSubmissionVersion: 1 };
    assert.equal((await h.call(h.path + '/decision', 'POST', body, 'test-review-token')).status, 200);
    assert.equal((await h.call(h.path + '/decision', 'POST', body, 'test-review-token')).status, 409);
    const queue = await h.call('/api/v1/community/moderation', 'GET', undefined, 'test-review-token');
    assert.equal(queue.data.pending.length, 0); assert.equal(queue.data.log.length, 1);
    assert.equal((await h.call(h.path)).data.status, 'approved');
  } finally { await h.close(); }
});
