import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import type { PlanStop } from '../src/domain/types.js';

const actorId = 'midnight-arrangement-owner';
const contextAt = (now: string) => createServerContext({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => now });

for (const fixture of [
  { now: '2026-10-04T23:55:00+08:00', requestedDate: '2026-10-04', actualDate: '2026-10-05' },
  { now: '2026-10-04T15:55:00Z', requestedDate: '2026-10-04', actualDate: '2026-10-05' },
  { now: '2026-10-05T00:05:00+08:00', requestedDate: '2026-10-05', actualDate: '2026-10-05' },
  { now: '2026-10-05T10:00:00+08:00', requestedDate: '2026-10-05', actualDate: '2026-10-05' },
]) {
  test(`standalone arrangement reports committed date at ${fixture.now}`, async () => {
    const ctx = contextAt(fixture.now);
    const arranged = await ctx.standaloneAgentService.handle(actorId, '安排今天去武康大楼');
    assert.equal(arranged.date, fixture.actualDate);
    assert.match(arranged.reply, new RegExp(`^已安排${fixture.actualDate}：「武康大楼」`));
    const committed = ctx.planLibrary.list(actorId).filter(plan => plan.stops.length);
    assert.equal(committed.length, 1);
    assert.equal(committed[0].localDate, arranged.date);
    assert.equal((committed[0].stops[0] as PlanStop).place?.name, '武康大楼');
    const crossesMidnight = fixture.actualDate !== fixture.requestedDate;
    if (crossesMidnight) assert.match(arranged.reply, /顺延/);
    else assert.doesNotMatch(arranged.reply, /顺延/);

    for (const text of ['出发前往武康大楼', '到达武康大楼', '完成游览武康大楼']) {
      const result = await ctx.standaloneAgentService.handle(actorId, text);
      assert.match(result.reply, crossesMidnight ? /今天计划里没有找到/ : /已记录/);
    }
    const preview = await ctx.standaloneAgentService.handle(actorId, '取消今天计划');
    assert.equal(preview.date, fixture.requestedDate);
    assert.match(preview.reply, /确定取消/);
    const cancelled = await ctx.standaloneAgentService.handle(actorId, '确认取消今天计划');
    assert.equal(cancelled.date, fixture.requestedDate);
    const remaining = ctx.planLibrary.list(actorId);
    if (crossesMidnight) {
      assert.equal(remaining.length, 1, 'cancelling the requested day preserves the next day');
      assert.equal(remaining[0].localDate, fixture.actualDate);
      assert.equal(remaining[0].stops.length, 1);
      assert.equal((remaining[0].executionEvents || []).length, 0, 'today progress cannot change next-day stops');
    } else assert.equal(remaining.length, 0);
  });
}

test('repeated late arrangements report only newly added visits merged into the next day', async () => {
  const ctx = contextAt('2026-10-04T23:55:00+08:00');
  await ctx.standaloneAgentService.handle(actorId, '安排今天去武康大楼');
  const repeated = await ctx.standaloneAgentService.handle(actorId, '安排今天去武康大楼');
  assert.equal(repeated.date, '2026-10-05');
  assert.equal(repeated.reply.match(/武康大楼/g)?.length, 1);
  assert.match(repeated.reply, /顺延/);
  const plans = ctx.planLibrary.list(actorId);
  const tomorrow = plans.find(plan => plan.localDate === '2026-10-05')!;
  assert.equal(tomorrow.stops.length, 2);
  assert.equal(new Set((tomorrow.stops as PlanStop[]).map(stop => stop.stopId)).size, 2);
  assert.equal(plans.find(plan => plan.localDate === '2026-10-04')!.stops.length, 0);
});

test('one arrangement reports each actual day when new visits split across midnight', async () => {
  const ctx = contextAt('2026-10-04T23:45:00+08:00');
  const result = await ctx.standaloneAgentService.handle(actorId, '安排今天去武康大楼、龙华寺');
  assert.equal(result.date, '2026-10-04', 'the first committed day is selected');
  assert.match(result.reply, /2026-10-04：「武康大楼」；2026-10-05：「龙华寺」/);
  assert.match(result.reply, /顺延/);
  const plans = ctx.planLibrary.list(actorId).filter(plan => plan.stops.length);
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.match(result.reply, new RegExp(`${plan.localDate}：「${(plan.stops[0] as PlanStop).place?.name}」`));
  }
});

test('fallback HTTP arrangement exposes the committed next-day date', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-10-04T23:55:00+08:00' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '安排今天去武康大楼', clientMessageId: 'fixed-midnight-arrangement' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.data.command.date, '2026-10-05');
    assert.match(body.data.assistantMessage.text, /^已安排2026-10-05：「武康大楼」/);
    assert.match(body.data.assistantMessage.text, /顺延/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const committed = plans.data.filter((plan: any) => plan.stops.length);
    assert.equal(committed.length, 1);
    assert.equal(committed[0].localDate, body.data.command.date);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
