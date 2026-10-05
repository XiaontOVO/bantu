import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { modelTurn, toolCall } from '../src/providers/model.js';

/** 伴途 Agent 不绑定行程：无旅行也能直接对话，历史按身份隔离。 */
test('agent chat works without a trip and isolates history per identity', async () => {
  const store = new MemoryStateStore();
  const server = createHttpServer({ seedDemo: false, stateStore: store });
  const start = async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  const base = await start();
  const guest = async () => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  try {
    const cookie = await guest();
    const send = async (text: string, useCookie = cookie, clientMessageId?: string) => {
      const response = await fetch(base + '/api/v1/agent/chat', { method: 'POST', headers: { cookie: useCookie, 'content-type': 'application/json' }, body: JSON.stringify({ text, clientMessageId }) });
      return { status: response.status, body: await response.json() as any };
    };
    const first = await send('去日本旅游什么时候最合适？', cookie, 'general-chat-once');
    assert.equal(first.status, 200);
    assert.equal(first.body.data?.userMessage?.text, '去日本旅游什么时候最合适？');
    assert.ok(first.body.data?.assistantMessage?.text, '有回复文本');
    const replay = await send('去日本旅游什么时候最合适？', cookie, 'general-chat-once');
    assert.equal(replay.body.data.userMessage.messageId, first.body.data.userMessage.messageId);
    assert.equal(replay.body.data.assistantMessage.messageId, first.body.data.assistantMessage.messageId);
    await send('大阪和京都怎么选？');
    const history = await (await fetch(base + '/api/v1/agent/chat', { headers: { cookie } })).json();
    assert.equal(history.data.length, 4, '两轮对话 4 条消息');
    // 空消息拒绝；无凭证 401
    assert.equal((await send('   ')).status, 400);
    assert.equal((await fetch(base + '/api/v1/agent/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) })).status, 401);
    // 不同身份的通用会话互相隔离
    const other = await guest();
    const otherHistory = await (await fetch(base + '/api/v1/agent/chat', { headers: { cookie: other } })).json();
    assert.equal(otherHistory.data.length, 0, '会话按身份隔离');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('a configured model plans a free-form request through catalog and save tools', async () => {
  const calls: string[] = [];
  const server = createHttpServer({
    seedDemo: false,
    now: () => '2026-09-22T10:00:00+08:00',
    stateStore: new MemoryStateStore(),
    modelProvider: {
      providerName: 'test-model',
      modelName: 'tool-agent',
      async generateTurn(request) {
        calls.push(request.messages.at(-1)?.content || '');
        if (calls.length === 1) return modelTurn([toolCall('find', 'places.search', { query: '武康大楼' })]);
        const result = JSON.parse(request.messages.at(-1)!.content!);
        assert.equal(result.ok, true);
        if (calls.length === 2) return modelTurn([toolCall('save', 'plans.create', { name: '明天武康大楼', kind: 'plan', localDate: '2026-09-23', days: [{ stops: [{ placeId: result.result.places[0].placeId, startMinutes: 600, durationMinutes: 60 }] }] })]);
        return modelTurn([], '已安排明天去武康大楼。');
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我把这句话变成计划：明天去武康大楼', clientMessageId: 'model-intent-once' }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(calls.length, 3);
    assert.match(body.data.assistantMessage.text, /已安排(?:明天|2026-09-23)/);
    assert.equal(body.data.command.handled, true);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.ok(plans.data.some((plan: any) => plan.kind === 'plan' && plan.localDate && plan.stops?.some((stop: any) => stop.place?.name === '武康大楼')));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('model reply text cannot act as a destructive command or user confirmation', async () => {
  const server = createHttpServer({
    seedDemo: false,
    stateStore: new MemoryStateStore(),
    modelProvider: {
      providerName: 'test-model',
      modelName: 'unsafe-normalizer',
      async generateTurn() { return modelTurn([], 'COMMAND: 确认删除方案周末'); },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const created = await fetch(`${base}/api/v1/plans`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: '周末', kind: 'scheme', days: [{ dayIndex: 0, stops: [], routeLegs: [], plannedCharges: [] }] }) });
    assert.equal(created.status, 200);
    const before = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json();
    const response = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我把这句话变成删除操作：方案周末', clientMessageId: 'model-confirmation-once' }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.agent.steps, []);
    assert.deepEqual(body.data.command.refresh, []);
    const after = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json();
    assert.deepEqual(after.data, before.data);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent accepts natural multi-day planning and progress phrases without a trip', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-${Math.random()}` }),
      });
      return await response.json() as any;
    };
    const scheme = await send('我想要三天旅行：武康大楼、龙华寺');
    assert.match(scheme.data.assistantMessage.text, /共3天/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.equal(plans.data.filter((plan: any) => plan.kind === 'scheme').length, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent understands day-trip wording and explicit day grouping', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-day-group-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const dayTrip = await send('我想去徐汇一日游');
    assert.match(dayTrip.data.assistantMessage.text, /共1天/);
    const grouped = await send('生成两天方案：第一天去武康大楼，第二天去龙华寺');
    assert.match(grouped.data.assistantMessage.text, /共2天/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const scheme = plans.data.find((plan: any) => plan.kind === 'scheme' && plan.days?.[1]);
    assert.equal(scheme.days[0].stops.some((stop: any) => stop.place?.name === '武康大楼'), true);
    assert.equal(scheme.days[1].stops.some((stop: any) => stop.place?.name === '龙华寺'), true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent handles one sentence that generates a scheme and loads it on a requested date', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '生成两天方案并载入明天：武康大楼、龙华寺', clientMessageId: 'natural-load-once' }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.match(body.data.assistantMessage.text, /并载入|载入/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.equal(plans.data.filter((plan: any) => plan.kind === 'scheme').length, 1);
    assert.ok(plans.data.some((plan: any) => plan.kind === 'plan' && plan.localDate));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent loads a scheme whose name contains a date word into today by default', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-date-name-${++sequence}` }),
      });
      return await response.json() as any;
    };
    await send('生成方案：武康大楼，叫做周末');
    const loaded = await send('加载方案周末');
    assert.match(loaded.data.assistantMessage.text, /载入/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    assert.equal(plans.data.some((plan: any) => plan.kind === 'plan' && plan.localDate === today), true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent confirmation keeps the original requested load date after a conflict', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-load-conflict-${++sequence}` }),
      });
      return await response.json() as any;
    };
    await send('安排明天去徐家汇书院');
    const first = await send('生成两天方案并载入明天：龙华寺、武康大楼');
    assert.match(first.data.assistantMessage.text, /冲突|确认载入/);
    const confirmed = await send('确认载入龙华寺路线');
    assert.match(confirmed.data.assistantMessage.text, /载入/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(`${today}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const dayAfter = tomorrow.toISOString().slice(0, 10);
    assert.equal(plans.data.some((plan: any) => plan.kind === 'plan' && plan.localDate === today), false, '不能因确认文本无日期而载入今天');
    assert.ok(plans.data.some((plan: any) => plan.kind === 'plan' && plan.localDate >= dayAfter), '冲突后应顺延到原日期之后');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent understands weekend scheduling and removing one place from a dated plan', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-edge-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const arranged = await send('安排周末去武康大楼、龙华寺');
    assert.match(arranged.data.assistantMessage.text, /已安排/);
    const removed = await send('移除周末计划中的武康大楼');
    assert.match(removed.data.assistantMessage.text, /移除/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent appends a place to a dated plan and answers a route question', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-plan-route-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const added = await send('把武康大楼加入明天计划');
    assert.match(added.data.assistantMessage.text, /已安排/);
    const route = await send('从武康大楼到龙华寺怎么走');
    assert.match(route.data.assistantMessage.text, /步行约/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.ok(plans.data.some((plan: any) => plan.kind === 'plan' && plan.localDate && plan.stops?.some((stop: any) => stop.place?.name === '武康大楼')));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent can toggle a place favorite from natural language', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-favorite-${++sequence}` }),
      });
      return await response.json() as any;
    };
    await send('收藏武康大楼');
    const removed = await send('取消收藏武康大楼');
    assert.match(removed.data.assistantMessage.text, /取消收藏/);
    const favorites = await (await fetch(`${base}/api/v1/favorites`, { headers: { cookie } })).json() as any;
    assert.equal(favorites.data.some((item: any) => item.place?.name === '武康大楼'), false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent understands common memory list wording', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '查看旅行记忆', clientMessageId: 'natural-memory-list' }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.match(body.data.assistantMessage.text, /还没有旅行记忆|共有/);
    const opened = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '打开我的记忆', clientMessageId: 'natural-memory-open' }),
    });
    const openedBody = await opened.json() as any;
    assert.match(openedBody.data.assistantMessage.text, /还没有旅行记忆|共有/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent understands everyday plan, memory, and post wording', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-everyday-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const tomorrowDate = new Date(`${todayKey}T00:00:00+08:00`);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const tomorrowKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrowDate);
    const today = await send('今天安排了什么');
    assert.match(today.data.assistantMessage.text, new RegExp(todayKey));
    const tomorrow = await send('看一下明天计划');
    assert.match(tomorrow.data.assistantMessage.text, new RegExp(tomorrowKey));
    const schedule = await send('我的日程');
    assert.match(schedule.data.assistantMessage.text, new RegExp(todayKey));
    const memory = await send('写一条旅行记忆：今天去了武康大楼');
    assert.match(memory.data.assistantMessage.text, /已保存到旅行记忆/);
    const post = await send('发一个帖子：徐汇散步\n天气很好');
    assert.match(post.data.assistantMessage.text, /社区操作需要先注册账号/);
    const plannedRoute = await send('查看路线');
    assert.match(plannedRoute.data.assistantMessage.text, /路线|还没有/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent confirms before cancelling a dated plan', async () => {
  // Cancellation is tested within one day; midnight carry has separate fixed-clock coverage.
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-10-05T10:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-cancel-${++sequence}` }),
      });
      return await response.json() as any;
    };
    await send('安排今天去武康大楼');
    const pending = await send('取消今天计划');
    assert.match(pending.data.assistantMessage.text, /确定取消/);
    const confirmed = await send('确认取消今天计划');
    assert.match(confirmed.data.assistantMessage.text, /已取消/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.equal(plans.data.some((plan: any) => plan.kind === 'plan'), false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent accepts common planning and route wording variants', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-variant-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const added = await send('把徐家汇书院放进明天计划');
    assert.match(added.data.assistantMessage.text, /已安排/);
    const scheme = await send('生成一份两天旅行方案：武康大楼、龙华寺');
    assert.match(scheme.data.assistantMessage.text, /共2天/);
    const route = await send('规划从武康大楼到龙华寺的路线');
    assert.match(route.data.assistantMessage.text, /步行约/);
    const listed = await send('查看我的方案');
    assert.match(listed.data.assistantMessage.text, /方案候选/);
    const query = await send('看看今天有什么行程');
    assert.match(query.data.assistantMessage.text, /有\d+份计划/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent accepts natural time and duration edits', async () => {
  // This scenario edits to 15:00; wall-clock afternoons must not turn it into an invalid past edit.
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-09-28T10:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-edit-${++sequence}` }),
      });
      return await response.json() as any;
    };
    await send('安排今天去武康大楼、龙华寺');
    const time = await send('请把武康大楼时间改为15:00');
    assert.match(time.data.assistantMessage.text, /调整到15:00/);
    const chineseTime = await send('请把龙华寺时间安排到下午三点');
    assert.match(chineseTime.data.assistantMessage.text, /调整到16:20/);
    const duration = await send('龙华寺游览1小时');
    assert.match(duration.data.assistantMessage.text, /停留60分钟/);
    const chineseDuration = await send('武康大楼游览一小时');
    assert.match(chineseDuration.data.assistantMessage.text, /停留60分钟/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent can save a dated plan as a reusable scheme without a trip', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-save-scheme-${Math.random()}` }),
      });
      return await response.json() as any;
    };
    await send('安排今天去武康大楼');
    const saved = await send('把今天计划保存为方案，命名为徐汇散步');
    assert.match(saved.data.assistantMessage.text, /保存为方案/);
    const stored = await send('把今天计划存入方案，命名为徐汇慢行');
    assert.match(stored.data.assistantMessage.text, /保存为方案/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.equal(plans.data.some((plan: any) => plan.kind === 'scheme' && plan.name === '徐汇散步'), true);
    assert.equal(plans.data.some((plan: any) => plan.kind === 'scheme' && plan.name === '徐汇慢行'), true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent keeps the requested name when saving as a candidate scheme', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-candidate-name-${++sequence}` }),
      });
      return await response.json() as any;
    };
    await send('安排今天去武康大楼');
    const saved = await send('把今天计划另存为候选方案，叫做周末');
    assert.match(saved.data.assistantMessage.text, /方案「周末」/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.equal(plans.data.some((plan: any) => plan.kind === 'scheme' && plan.name === '周末'), true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent accepts conversational add, time, load, and delete wording', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-conversational-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const added = await send('把武康大楼安排到明天');
    assert.match(added.data.assistantMessage.text, /已安排/);
    const reversedAdded = await send('安排龙华寺到后天');
    assert.match(reversedAdded.data.assistantMessage.text, /已安排/);
    const timed = await send('请把武康大楼排在15:00');
    assert.match(timed.data.assistantMessage.text, /调整到15:00/);
    const renamedTime = await send('武康大楼时间改为16:00');
    assert.match(renamedTime.data.assistantMessage.text, /调整到16:00/);
    await send('把明天计划保存为方案，命名为周末');
    const loaded = await send('加载方案「周末」');
    assert.match(loaded.data.assistantMessage.text, /载入/);
    const listed = await send('载入方案');
    assert.match(listed.data.assistantMessage.text, /载入/);
    const deleted = await send('删除方案「周末」');
    assert.match(deleted.data.assistantMessage.text, /确认删除/);
    const confirmed = await send('确认删除周末');
    assert.match(confirmed.data.assistantMessage.text, /已删除/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent keeps date-scoped edits safe and accepts direct spoken actions', async () => {
  const server = createHttpServer({
    seedDemo: false,
    stateStore: new MemoryStateStore(),
    now: () => '2026-09-22T01:00:00.000Z',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-safe-edit-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const added = await send('把武康大楼放到明天计划');
    assert.match(added.data.assistantMessage.text, /已安排2026-09-23/);
    const wrongDayDelete = await send('删除今天计划中的武康大楼');
    assert.match(wrongDayDelete.data.assistantMessage.text, /没有找到2026-09-22的日计划/);
    await send('安排今天去武康大楼');
    const departed = await send('我出发去武康大楼');
    assert.match(departed.data.assistantMessage.text, /已记录.*出发/);
    const arrived = await send('我到武康大楼了');
    assert.match(arrived.data.assistantMessage.text, /已记录.*到/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.ok(plans.data.some((item: any) => item.kind === 'plan' && item.localDate === '2026-09-23' && item.stops?.some((stop: any) => stop.place?.name === '武康大楼')));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent turns intention-first travel wording into a dated plan', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '周末想去武康大楼和龙华寺', clientMessageId: 'natural-intention-first' }),
    });
    const body = await response.json() as any;
    assert.match(body.data.assistantMessage.text, /已安排/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.ok(plans.data.some((plan: any) => plan.kind === 'plan' && plan.localDate && plan.stops?.length === 2));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent understands relaxed and half-day travel wording without requiring internal terms', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-09-22T01:00:00.000Z' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-pace-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const halfDay = await send('给我做个适合老人的徐汇半日游');
    assert.match(halfDay.data.assistantMessage.text, /已生成/);
    const relaxedRoute = await send('帮我找一条不太累的徐汇路线');
    assert.match(relaxedRoute.data.assistantMessage.text, /已安排/);
    const weekend = await send('请帮我做个周末攻略');
    assert.match(weekend.data.assistantMessage.text, /共2天/);
    const periodOnly = await send('安排明天上午去武康大楼');
    assert.match(periodOnly.data.assistantMessage.text, /已安排/);
    const recommendation = await send('我想找附近的安静地方');
    assert.match(recommendation.data.assistantMessage.text, /可以先看看/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const dated = plans.data.filter((item: any) => item.kind === 'plan');
    assert.ok(dated.some((plan: any) => plan.stops?.length === 2), '半日或轻松请求应收敛为少量地点');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent accepts inline and trailing dates in ordinary travel wording', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-inline-date-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const inline = await send('我想明天去武康大楼');
    assert.match(inline.data.assistantMessage.text, /已安排/);
    const trailing = await send('我想去龙华寺 明天安排');
    assert.match(trailing.data.assistantMessage.text, /已安排/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
    const plan = plans.data.find((item: any) => item.kind === 'plan' && item.localDate === date);
    assert.ok(plan, '应把两种自然语序都放入明天的日计划');
    assert.equal(plan.stops.some((stop: any) => stop.place?.name === '武康大楼'), true);
    assert.equal(plan.stops.some((stop: any) => stop.place?.name === '龙华寺'), true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent keeps weekend and same-weekday wording on the current day', async () => {
  const server = createHttpServer({
    seedDemo: false,
    stateStore: new MemoryStateStore(),
    now: () => '2026-09-26T01:00:00.000Z', // 2026-09-26 09:00 in Shanghai, Saturday
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-weekend-${++sequence}` }),
      });
      return await response.json() as any;
    };
    await send('周末想去武康大楼');
    await send('周六去龙华寺');
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const plan = plans.data.find((item: any) => item.kind === 'plan' && item.localDate === '2026-09-26');
    assert.ok(plan, '周末和同日星期表达不应被顺延到下周');
    assert.equal(plan.stops.length, 2);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent turns guide and itinerary wording into a reusable scheme', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-guide-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const guide = await send('给我一份两天徐汇攻略：第一天去武康大楼，第二天去龙华寺');
    assert.match(guide.data.assistantMessage.text, /共2天/);
    const itinerary = await send('我要三天行程：武康大楼、龙华寺');
    assert.match(itinerary.data.assistantMessage.text, /共3天/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.equal(plans.data.filter((item: any) => item.kind === 'scheme').length, 2);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent accepts a date and clock before the destination in one sentence', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '安排明天上午九点去武康大楼', clientMessageId: 'natural-time-prefix' }),
    });
    const body = await response.json() as any;
    assert.match(body.data.assistantMessage.text, /已安排/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
    const plan = plans.data.find((item: any) => item.kind === 'plan' && item.localDate === date);
    assert.equal(plan?.stops[0]?.startMinutes, 540);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent turns common spoken trip requests into plans and schemes', async () => {
  const server = createHttpServer({
    seedDemo: false,
    stateStore: new MemoryStateStore(),
    now: () => '2026-09-22T01:00:00.000Z',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-spoken-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const multiDay = await send('我想去徐汇玩两天');
    assert.match(multiDay.data.assistantMessage.text, /共2天/);
    const relaxed = await send('帮我安排一个轻松的两天徐汇行程');
    assert.match(relaxed.data.assistantMessage.text, /共2天/);
    const nextWednesday = await send('计划下周三去龙华寺');
    assert.match(nextWednesday.data.assistantMessage.text, /已安排2026-09-30/);
    const today = await send('去徐家汇书院和武康大楼，安排得轻松一点');
    assert.match(today.data.assistantMessage.text, /已安排2026-09-22/);
    const plans = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.equal(plans.data.filter((item: any) => item.kind === 'scheme').length, 2);
    assert.ok(plans.data.some((item: any) => item.kind === 'plan' && item.localDate === '2026-09-30' && item.stops?.some((stop: any) => stop.place?.name === '龙华寺')));
    assert.ok(plans.data.some((item: any) => item.kind === 'plan' && item.localDate === '2026-09-22' && item.stops?.length === 2));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent keeps planning intent ahead of duration edits and moves stops safely', async () => {
  const server = createHttpServer({
    seedDemo: false,
    stateStore: new MemoryStateStore(),
    now: () => '2026-09-22T01:00:00.000Z',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-operations-${++sequence}` }),
      });
      return await response.json() as any;
    };
    const timedPlan = await send('今天下午3点去武康大楼逛1小时');
    assert.match(timedPlan.data.assistantMessage.text, /已安排2026-09-22/);
    const plansAfterTime = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    const today = plansAfterTime.data.find((item: any) => item.kind === 'plan' && item.localDate === '2026-09-22');
    assert.equal(today?.stops[0]?.startMinutes, 900);
    assert.equal(today?.stops[0]?.plannedDurationMinutes, 60);
    assert.match((await send('把武康大楼的游览时间改成一小时')).data.assistantMessage.text, /已把.*调整为/);
    const moved = await send('把武康大楼移到后天');
    assert.match(moved.data.assistantMessage.text, /从2026-09-22移到2026-09-24/);
    const plansAfterMove = await (await fetch(`${base}/api/v1/plans`, { headers: { cookie } })).json() as any;
    assert.equal(plansAfterMove.data.find((item: any) => item.kind === 'plan' && item.localDate === '2026-09-22')?.stops.length, 0);
    assert.equal(plansAfterMove.data.find((item: any) => item.kind === 'plan' && item.localDate === '2026-09-24')?.stops[0]?.place?.name, '武康大楼');
    await send('安排今天去武康大楼');
    assert.match((await send('开始前往武康大楼')).data.assistantMessage.text, /已记录.*前往/);
    assert.match((await send('我到武康大楼了')).data.assistantMessage.text, /已记录.*到达/);
    assert.match((await send('在武康大楼完成游览')).data.assistantMessage.text, /已记录.*完成/);
    assert.match((await send('今天计划增加龙华寺')).data.assistantMessage.text, /已安排2026-09-22/);
    await send('安排明天去龙华寺');
    assert.match((await send('删除明天的龙华寺')).data.assistantMessage.text, /已从2026-09-23计划移除/);
    assert.match((await send('帮我做周末方案')).data.assistantMessage.text, /共2天/);
    assert.match((await send('安排一个3天的徐汇行程，第一天去武康大楼，第二天去龙华寺')).data.assistantMessage.text, /共3天/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent normalizes natural completion wording into progress actions', async () => {
  // Keep all three reported actions on the planned day, independent of the test runner's clock.
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-10-05T10:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    let sequence = 0;
    const send = async (text: string) => {
      const response = await fetch(`${base}/api/v1/agent/chat`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId: `natural-progress-${++sequence}` }),
      });
      return await response.json() as any;
    };
    await send('安排今天去武康大楼');
    const departed = await send('出发前往武康大楼');
    assert.match(departed.data.assistantMessage.text, /已记录/);
    const arrived = await send('到达武康大楼');
    assert.match(arrived.data.assistantMessage.text, /已记录/);
    const completed = await send('完成游览武康大楼');
    assert.match(completed.data.assistantMessage.text, /已记录/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('agent turns provider failures into a retryable assistant reply instead of HTTP 500', async () => {
  const failingPlaceProvider = {
    providerName: 'failing_place_provider',
    async search() { throw new Error('地点服务暂时不可用'); },
    async detail() { throw new Error('地点服务暂时不可用'); },
  };
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore(), placeProvider: failingPlaceProvider });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/v1/agent/chat`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '安排今天去武康大楼', clientMessageId: 'provider-failure-once' }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.match(body.data.assistantMessage.text, /地点服务暂时不可用/);
    assert.match(body.data.assistantMessage.text, /原话已保留/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
