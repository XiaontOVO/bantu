import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';

async function startServer() {
  const server = createHttpServer({ seedDemo: false, now: () => '2026-09-20T12:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function guest(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/v1/session/guest`, { method: 'POST' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie!;
}

const call = async (baseUrl: string, cookie: string, path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json() as any) };
};

test('general chat messages can only be deleted by the owning identity', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const owner = await guest(baseUrl);
    const other = await guest(baseUrl);
    const sent = await call(baseUrl, owner, '/api/v1/agent/chat', 'POST', {
      text: '请给我一些周末出游建议。', clientMessageId: 'general-delete-1',
    });
    assert.equal(sent.status, 200);
    const messageId = sent.data.userMessage.messageId;
    const path = `/api/v1/agent/chat/${encodeURIComponent(messageId)}`;

    assert.equal((await call(baseUrl, other, path, 'DELETE')).status, 404);
    assert.ok((await call(baseUrl, owner, '/api/v1/agent/chat')).data.some((message: any) => message.messageId === messageId));
    assert.equal((await call(baseUrl, owner, path, 'DELETE')).status, 200);
    assert.equal((await call(baseUrl, owner, path, 'DELETE')).status, 200, 'repeating a general-chat delete is harmless');
    assert.ok(!(await call(baseUrl, owner, '/api/v1/agent/chat')).data.some((message: any) => message.messageId === messageId));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('deleting a trip chat source makes its memory stale and prevents editing it', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const cookie = await guest(baseUrl);
    const created = await call(baseUrl, cookie, '/api/v1/trips', 'POST', {
      cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo',
    });
    assert.equal(created.status, 200);
    const tripId = created.data.trip.tripId;
    const tripPath = `/api/v1/trips/${encodeURIComponent(tripId)}`;
    const sent = await call(baseUrl, cookie, `${tripPath}/messages`, 'POST', {
      text: '帮我记下：今天和朋友沿湖散步。', clientMessageId: 'trip-memory-delete-1',
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.status, 'recorded');
    const messageId = sent.data.userMessage.messageId;
    const memoryId = sent.data.memory.memoryId;

    const deleted = await call(baseUrl, cookie, `${tripPath}/messages/${encodeURIComponent(messageId)}`, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.sourceInvalidated, true);
    const memory = await call(baseUrl, cookie, `${tripPath}/memories/${encodeURIComponent(memoryId)}`);
    assert.ok(memory.data.staleAt, 'the memory must no longer present deleted chat text as current source material');
    const repeatedDelete = await call(baseUrl, cookie, `${tripPath}/messages/${encodeURIComponent(messageId)}`, 'DELETE');
    assert.equal(repeatedDelete.status, 200, 'repeating the delete request is harmless');
    assert.equal(repeatedDelete.data.sourceInvalidated, false, 'only the first deletion invalidates its source');
    const afterRepeat = await call(baseUrl, cookie, `${tripPath}/memories/${encodeURIComponent(memoryId)}`);
    assert.equal(afterRepeat.data.contentRevision, memory.data.contentRevision, 'a repeated delete must not cause a memory version conflict');
    const edit = await call(baseUrl, cookie, `${tripPath}/memories/${encodeURIComponent(memoryId)}`, 'PATCH', {
      userText: '尝试覆盖旧来源', expectedContentRevision: memory.data.contentRevision,
      expectedEntryVersion: memory.data.entryVersion,
    });
    assert.equal(edit.error.code, 'SOURCE_CHANGED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
