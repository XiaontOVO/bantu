import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { request as httpRequest } from 'node:http';

test('hidden community place notes follow the same owner-only access as tags and details, then become available after approval', async () => {
  const store = new MemoryStateStore();
  const server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'hidden-place-note-fixture' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const guest = async () => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  const register = async (username: string) => {
    const response = await fetch(base + '/api/v1/account/register', { method: 'POST', headers: { cookie: await guest(), 'content-type': 'application/json' }, body: JSON.stringify({ username, password: '12345678' }) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie')!.split(';')[0];
  };
  const api = async (cookie: string, path: string, method = 'GET', body?: unknown, moderator = false) => {
    const response = await fetch(base + '/api/v1/' + path, { method,
      headers: { cookie, 'content-type': 'application/json', ...(moderator ? { 'x-community-admin-token': 'hidden-place-note-fixture' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() as any };
  };
  try {
    const owner = await register('hidden_note_owner'), reader = await register('hidden_note_reader'), visitor = await guest();
    const created = await api(owner, 'community/places', 'POST', { name: '非公开的小庭院', cityCode: '330100', address: '待核实的庭院入口', description: '提交者尚未完成公开收录。', lat: 30.25, lng: 120.15 });
    assert.equal(created.status, 200); const id = created.data.id;
    const notes = `places/${id}/note`, tags = `places/${id}/tags`;
    assert.equal((await api(owner, notes, 'POST', { note: '提交者自己的备注' })).status, 200);
    assert.equal((await api(owner, notes)).data.note, '提交者自己的备注');
    const hiddenNoteStatuses: number[] = [];
    for (const cookie of [reader, visitor]) {
      assert.equal((await api(cookie, `community/places/${id}`)).status, 404);
      assert.equal((await api(cookie, tags)).status, 404);
      hiddenNoteStatuses.push((await api(cookie, notes)).status);
      hiddenNoteStatuses.push((await api(cookie, notes, 'POST', { note: '不能给他人的隐藏地点写备注' })).status);
    }
    assert.deepEqual(hiddenNoteStatuses, [404, 404, 404, 404], 'both guests and other accounts must be denied hidden place note reads and writes');
    assert.ok(!String(store.get('bantu-trip-service:community')).includes('不能给他人的隐藏地点写备注'));
    assert.equal((await api(owner, `community/places/${id}/submit`, 'POST', { evidence: '现场位置和公开入口已核实。' })).status, 200);
    assert.equal((await api(owner, `community/places/${id}/decision`, 'POST', { decision: 'approved', note: '允许公开收录' }, true)).status, 200);
    assert.equal((await api(reader, notes)).status, 200);
    assert.equal((await api(reader, notes)).data.note, '', 'approval does not expose the submitter personal note');
    assert.equal((await api(reader, notes, 'POST', { note: '访客自己的公开地点备注' })).status, 200);
    assert.equal((await api(reader, notes)).data.note, '访客自己的公开地点备注');
    assert.equal((await api(owner, notes)).data.note, '提交者自己的备注');
    assert.equal((await api(owner, `community/places/${id}`, 'DELETE')).status, 200);
    assert.equal((await api(owner, notes)).status, 404);
    assert.equal((await api(reader, notes, 'POST', { note: '撤回后不应写入' })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const kind of ['note', 'tags'] as const) test(`a community place ${kind} write waiting for its body cannot commit after the owner withdraws that place`, async () => {
  const store = new MemoryStateStore();
  let waitingId = '', reachedDetail: (() => void) | undefined;
  const detailReached = new Promise<void>(resolve => { reachedDetail = resolve; });
  const server = createHttpServer({ seedDemo: false, stateStore: store, placeProvider: {
    providerName: 'hidden-note-race-fixture',
    async search() { return { places: [], empty: true }; },
    async detail(id) { if (id === waitingId) reachedDetail!(); return null; },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + '/api/v1/' + path, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() as any };
  };
  let pendingRequest: ReturnType<typeof httpRequest> | undefined;
  try {
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const registration = await fetch(base + '/api/v1/account/register', { method: 'POST', headers: { cookie: guest.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/json' }, body: JSON.stringify({ username: 'note_race_owner', password: '12345678' }) });
    assert.equal(registration.status, 200); const owner = registration.headers.get('set-cookie')!.split(';')[0];
    const created = await api(owner, 'community/places', 'POST', { name: '等待提交的庭院', cityCode: '330100', address: '待公开入口', description: '只供提交者检查。' });
    assert.equal(created.status, 200); waitingId = created.data.id;
    const value = kind === 'note' ? { note: '撤回后不得保存的旧备注' } : { customTags: ['撤回后不得保存的旧标签'] };
    const body = JSON.stringify(value);
    const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
      pendingRequest = httpRequest(base + `/api/v1/places/${waitingId}/${kind}`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
        const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        incoming.on('error', reject);
      });
      pendingRequest.on('error', reject);
      pendingRequest.setTimeout(5000, () => pendingRequest!.destroy(new Error('delayed body fixture timed out')));
      pendingRequest.flushHeaders();
    });
    await Promise.race([detailReached, response.then(() => { throw new Error('route returned before entering the delayed body check'); })]);
    // Directory lookup has finished; the real route is waiting for the request body.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await api(owner, `community/places/${waitingId}`, 'DELETE')).status, 200);
    pendingRequest!.end(body);
    const receipt = await response;
    assert.equal(receipt.status, 404, 'the pre-body existence check cannot authorize a write after withdrawal');
    const persisted = String(store.get('bantu-trip-service:community'));
    assert.ok(!persisted.includes('撤回后不得保存的旧'), 'rejected stale writes must not appear in persisted personal attributes');
    assert.equal((await api(owner, 'community/mine')).data.places.length, 0);
  } finally { pendingRequest?.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
