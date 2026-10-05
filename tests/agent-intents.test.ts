import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

test('规则规划正确解释下周、半点和复合时长，不将无效日期时刻或天数偷偷改成其他安排', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-09-22T01:00:00Z' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const cases = [
      { text: '安排下周一去武康大楼', date: '2026-09-28' },
      { text: '安排下周末去武康大楼', date: '2026-10-03' },
      { text: '安排明天下午三点半去武康大楼', date: '2026-09-23', start: 930 },
      { text: '安排明天14:00去武康大楼，游览1小时30分钟', date: '2026-09-23', start: 840, duration: 90 },
      { text: '安排明天去武康大楼，游览一个半小时', date: '2026-09-23', duration: 90 },
      { text: '安排2026-09-31去武康大楼', invalid: true },
      { text: '安排明天25:00去武康大楼', invalid: true },
      { text: '生成31天方案：武康大楼', invalid: true },
    ];
    for (const item of cases) {
      const cookie = (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
      const response = await fetch(base + '/api/v1/agent/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: item.text }) });
      assert.equal(response.status, 200);
      const plans = ((await (await fetch(base + '/api/v1/plans', { headers: { cookie } })).json()) as any).data;
      if (item.invalid) assert.deepEqual(plans, [], item.text);
      else {
        assert.equal(plans.length, 1, item.text); assert.equal(plans[0].localDate, item.date);
        if (item.start !== undefined) assert.equal(plans[0].stops[0].startMinutes, item.start);
        if (item.duration !== undefined) assert.equal(plans[0].stops[0].plannedDurationMinutes, item.duration);
      }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
