import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

async function fixture(run: (api: any) => Promise<void>) {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-09-22T01:00:00.000Z' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const session = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
  const cookie = session.headers.get('set-cookie')!.split(';')[0];
  let sequence = 0;
  const request = async (path: string, body?: any) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.data;
  };
  try {
    await run({ plans: () => request('/api/v1/plans'), send: async (text: string, clientMessageId = `visit-${++sequence}`) => request('/api/v1/agent/chat', { text, clientMessageId }) });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('Agent revisits a completed place with independent progress and keeps request replay idempotent', () => fixture(async ({ send, plans }) => {
  await send('安排今天去武康大楼');
  for (const text of ['出发前往武康大楼', '到达武康大楼', '完成游览武康大楼']) assert.match((await send(text)).assistantMessage.text, /已记录/);
  const original = (await plans()).find((plan: any) => plan.localDate === '2026-09-22');
  assert.equal(original.stops[0].status, 'completed');
  const first = await send('再去武康大楼', 'intentional-revisit');
  assert.match(first.assistantMessage.text, /已安排/);
  const replay = await send('再去武康大楼', 'intentional-revisit');
  assert.equal(replay.assistantMessage.messageId, first.assistantMessage.messageId);
  let updated = (await plans()).find((plan: any) => plan.id === original.id);
  assert.equal(updated.stops.length, 2);
  assert.deepEqual(updated.stops[0], original.stops[0]);
  assert.deepEqual(updated.executionEvents, original.executionEvents);
  assert.equal(updated.stops[1].status, 'planned');
  assert.equal(updated.stops[1].placeId, updated.stops[0].placeId);
  assert.notEqual(updated.stops[1].stopId, updated.stops[0].stopId);
  await send('再去武康大楼');
  for (const text of ['出发前往武康大楼', '到达武康大楼', '完成游览武康大楼']) assert.match((await send(text)).assistantMessage.text, /已记录/);
  updated = (await plans()).find((plan: any) => plan.id === original.id);
  assert.equal(updated.stops.length, 3);
  assert.deepEqual(updated.stops.map((stop: any) => stop.status), ['completed', 'completed', 'planned']);
  assert.deepEqual(updated.stops[0], original.stops[0]);
  assert.equal(new Set(updated.stops.map((stop: any) => stop.stopId)).size, 3);
}));

test('Agent preserves repeated places and their order in explicit daily and scheme lists', () => fixture(async ({ send, plans }) => {
  assert.match((await send('生成一个方案：武康大楼、龙华寺、武康大楼')).assistantMessage.text, /已生成/);
  const scheme = (await plans()).find((plan: any) => plan.kind === 'scheme');
  assert.deepEqual(scheme.days[0].stops.map((stop: any) => stop.place.name), ['武康大楼', '龙华寺', '武康大楼']);
  assert.equal(new Set(scheme.days[0].stops.map((stop: any) => stop.stopId)).size, 3);
  assert.match((await send('安排明天去武康大楼、龙华寺、武康大楼')).assistantMessage.text, /已安排/);
  const daily = (await plans()).find((plan: any) => plan.localDate === '2026-09-23');
  assert.deepEqual(daily.stops.map((stop: any) => stop.place.name), ['武康大楼', '龙华寺', '武康大楼']);
  assert.ok(daily.stops[2].startMinutes >= daily.stops[1].endMinutes);
}));

test('moving a planned visit onto a date with that place preserves both independent visits', () => fixture(async ({ send, plans }) => {
  await send('安排今天去武康大楼');
  await send('安排明天去武康大楼');
  const before = await plans();
  const source = before.find((plan: any) => plan.localDate === '2026-09-22');
  const destination = before.find((plan: any) => plan.localDate === '2026-09-23');
  assert.match((await send('把武康大楼移到明天')).assistantMessage.text, /已将/);
  const after = await plans();
  assert.equal(after.find((plan: any) => plan.id === source.id).stops.length, 0);
  const moved = after.find((plan: any) => plan.id === destination.id);
  assert.equal(moved.stops.length, 2);
  assert.deepEqual(moved.stops[0], destination.stops[0]);
  assert.equal(moved.stops[1].stopId, source.stops[0].stopId);
}));

test('ambiguous repeated-visit time edits do not silently change the first visit', () => fixture(async ({ send, plans }) => {
  await send('安排明天去武康大楼、武康大楼');
  const before = await plans();
  for (const text of ['把武康大楼的时间改为下午3点', '把武康大楼的游览时间改成一小时']) {
    assert.match((await send(text)).assistantMessage.text, /多次待进行.*选择具体那次/);
    assert.deepEqual(await plans(), before);
  }
}));
