import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersonalMemoriesService } from '../src/services/personal-memories-service.js';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

test('personal memory version checks preserve the newer text and reject invalid or stale versions', () => {
  const service = new PersonalMemoriesService();
  const created = service.create('owner', { userText: '散步\n原记录' });
  assert.ok(created.ok);
  const id = created.value.memoryId;
  const updated = service.patch('owner', id, { userText: '散步\n新页面修改', expectedEntryVersion: 1 });
  assert.ok(updated.ok); assert.equal(updated.value.entryVersion, 2);
  const latest = service.serialize();
  const stale = service.patch('owner', id, { userText: '旧页面覆盖', expectedEntryVersion: 1 });
  assert.ok(!stale.ok); assert.equal(stale.error.code, 'ENTRY_VERSION_CONFLICT');
  for (const invalid of [0, -1, 1.5, NaN, Infinity, '2', null]) {
    const rejected = service.patch('owner', id, { userText: '无效版本覆盖', expectedEntryVersion: invalid as number });
    assert.ok(!rejected.ok); assert.equal(rejected.error.code, 'INVALID_INPUT');
  }
  assert.equal(service.serialize(), latest);
  const restored = new PersonalMemoriesService(); restored.loadSerialized(latest);
  const next = restored.patch('owner', id, { userText: '核对后继续编辑', expectedEntryVersion: 2 });
  assert.ok(next.ok); assert.equal(next.value.entryVersion, 3);
  assert.equal(restored.list('other').length, 0);
});

test('two personal memory editors cannot both commit the same version through HTTP', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, ...(await response.json() as any) };
    };
    const created = await call('/api/v1/memories', 'POST', { userText: '两页编辑的笔记' });
    assert.equal(created.status, 200);
    const path = `/api/v1/memories/${created.data.memoryId}`;
    const opened = (await call(path)).data;
    const responses = await Promise.all(['第一页保存', '第二页保存'].map(userText =>
      call(path, 'PATCH', { userText, expectedEntryVersion: opened.entryVersion })));
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
    const accepted = responses.find(result => result.status === 200)!;
    const rejected = responses.find(result => result.status === 409)!;
    assert.equal(rejected.error.code, 'ENTRY_VERSION_CONFLICT');
    assert.equal((await call(path)).data.userText, accepted.data.userText);
    assert.equal((await call(path)).data.entryVersion, 2);
    assert.equal((await call(path, 'PATCH', { userText: '字符串版本', expectedEntryVersion: '2' })).status, 400);
    const compatible = await call(path, 'PATCH', { userText: '兼容未传版本的旧客户端' });
    assert.equal(compatible.status, 200);
    assert.equal(compatible.data.entryVersion, 3);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
