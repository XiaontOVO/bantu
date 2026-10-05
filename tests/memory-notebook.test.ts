import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { parseDirectCommand } from '../src/domain/authorization.js';

test('explicit chat recording preserves punctuation and never treats a negated request as permission', () => {
  assert.deepEqual(parseDirectCommand('帮我记录一下：今天下雨了，但还是很开心！\n下次再来。'), { kind: 'memory.create', text: '今天下雨了，但还是很开心！\n下次再来。' });
  assert.equal(parseDirectCommand('不要帮我记下：今天下雨了'), null);
  assert.equal(parseDirectCommand('帮我记录一下：'), null);
});

test('chat-created note can be edited, conflict checked, restored after restart and deleted', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ stateStore: store, modelProvider: { providerName: 'unused', modelName: 'unused', async generateTurn() { throw new Error('specific recording must not require LLM'); } } });
  const start = async () => { await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve)); const a = server.address(); assert.ok(a && typeof a !== 'string'); return `http://127.0.0.1:${a.port}`; };
  let base = await start();
  try {
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, ...(await response.json() as any) };
    };
    const created = await call('/api/v1/trips','POST',{ cityCode:'330100',localDate:'2026-09-20',dataMode:'demo' });
    const path = `/api/v1/trips/${created.data.trip.tripId}`;
    const saved = await call(path + '/messages','POST',{ text:'帮我记下：今天在西湖散步。' });
    assert.equal(saved.data.status,'recorded');
    const id = saved.data.memory.memoryId;
    const note = (await call(path + '/memories/' + id)).data;
    assert.equal(note.userText,'今天在西湖散步。');
    assert.equal(note.sourceMessageIds.length,1);
    const version = (await call(path)).data.trip;
    const edit = { userText:'今天和妈妈在西湖散步。\n下午喝了茶。', expectedContentRevision:version.contentRevision, expectedEntryVersion:note.entryVersion };
    assert.equal((await call(path + '/memories/' + id,'PATCH',edit)).status,200);
    const stale = await call(path + '/memories/' + id,'PATCH',{ ...edit,userText:'旧窗口覆盖' });
    assert.equal(stale.error.code,'ENTRY_VERSION_CONFLICT');
    assert.equal((await call(path)).data.trip.revision,version.revision,'notes do not change the travel plan');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createHttpServer({ stateStore:store }); base=await start();
    assert.equal((await call(path + '/memories/' + id)).data.userText,edit.userText);
    assert.equal((await call(path + '/memories/' + id,'DELETE')).status,200);
    assert.equal((await call(path + '/memories')).data.length,0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
