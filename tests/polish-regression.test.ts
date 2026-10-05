/**
 * 打磨优化阶段的回归测试。
 * 每个用例对应一个已修复的具体缺陷，防止再次退化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime.js';
import { ToolGateway } from '../src/agent/tools.js';
import { ActionAuthorizationService } from '../src/domain/authorization.js';
import { checkConstraint } from '../src/domain/constraints.js';
import { normalizeTripSnapshot } from '../src/domain/normalize.js';
import { applyProposal } from '../src/domain/versioning.js';
import { makeSnapshot, makeStop } from './helpers.js';
import { OperationStore } from '../src/domain/operations.js';
import type { Operation } from '../src/domain/types.js';
import { ExternalBudgetLedger } from '../src/services/external-budget.js';
import { InMemoryTripService } from '../src/services/trip-service.js';
import { AgentService } from '../src/services/agent-service.js';
import { MessageService } from '../src/services/message-service.js';
import { OpenAiCompatibleModelProvider } from '../src/providers/openai-compatible-model.js';
import { ScriptedModelProvider, modelTurn, toolCall } from '../src/providers/model.js';
import type { ModelProvider, ModelTurn } from '../src/providers/model.js';
import { AmapPlaceProvider } from '../src/providers/amap.js';
import { DemoPlaceProvider } from '../src/providers/travel.js';
import { MemoryStateStore, SqliteStateStore } from '../src/persistence/state-store.js';
import { createHttpServer } from '../src/server/http-server.js';

const NOW = '2026-09-20T13:00:00+08:00';

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    operationId: 'op_1',
    tripId: 'trip_1',
    actorId: 'actor_1',
    sessionId: 'session_1',
    kind: 'initial',
    status: 'queued',
    phase: 'queued',
    createdAt: NOW,
    updatedAt: NOW,
    usageTotals: {},
    ...overrides,
  } as Operation;
}

async function withServer(
  options: Parameters<typeof createHttpServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createHttpServer({ now: () => NOW, seedDemo: false, ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function createTrip(
  baseUrl: string,
  cookie: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/trips`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' }),
  });
  const body = (await response.json()) as { data: { trip: { tripId: string } } };
  return body.data.trip.tripId;
}

async function guest(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/session/guest`, { method: 'POST' });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}

// ---------------------------------------------------------------------------
// Agent 工具循环（真实 OpenAI-compatible 供应商要求）
// ---------------------------------------------------------------------------

test('runtime keeps the assistant tool_calls message before tool results', async () => {
  const authorization = new ActionAuthorizationService();
  const gateway = new ToolGateway(authorization);
  gateway.register({
    name: 'trip.read',
    description: '读取旅行',
    inputSchema: { type: 'object', properties: { tripId: { type: 'string' } } },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: () => ({ result: { ok: true } }),
  });

  const model = new ScriptedModelProvider([
    modelTurn([toolCall('call_1', 'trip.read', { tripId: 'trip_1' })]),
    modelTurn([], '完成'),
  ]);
  const runtime = new AgentRuntime(gateway);
  const result = await runtime.run({
    operationId: 'op_1',
    messages: [{ role: 'user', content: '读取旅行' }],
    allowedTools: ['trip.read'],
    context: { actorId: 'a', sessionId: 's', tripId: 'trip_1', now: NOW },
    model,
    gateway,
  });

  assert.equal(result.status, 'succeeded');
  const assistantIndex = result.messages.findIndex(
    (message) => message.role === 'assistant' && Array.isArray(message.toolCalls),
  );
  const toolIndex = result.messages.findIndex((message) => message.role === 'tool');
  assert.ok(assistantIndex >= 0, 'assistant tool_calls message is required by OpenAI-compatible APIs');
  assert.ok(toolIndex > assistantIndex, 'tool result must immediately follow the assistant tool_calls');
  assert.equal(toolIndex, assistantIndex + 1);
});

test('OpenAI adapter serializes assistant tool calls in the wire format', async () => {
  let sentBody: Record<string, unknown> | undefined;
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '好' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: 'https://model.example/v1',
    apiKey: 'k',
    modelName: 'm',
    fetchImpl: fakeFetch,
  });
  await provider.generateTurn({
    messages: [
      { role: 'user', content: '查一下' },
      {
        role: 'assistant',
        content: undefined,
        toolCalls: [{ callId: 'call_9', name: 'trip.read', arguments: { tripId: 'trip_1' } }],
      },
      { role: 'tool', toolCallId: 'call_9', toolName: 'trip.read', content: '{"status":"succeeded"}' },
    ],
    tools: [],
  });

  const messages = sentBody?.messages as Array<Record<string, unknown>>;
  const assistant = messages[1];
  const wireCalls = assistant.tool_calls as Array<Record<string, unknown>>;
  assert.equal(wireCalls.length, 1);
  assert.equal(wireCalls[0].id, 'call_9');
  assert.equal(wireCalls[0].type, 'function');
  const fn = wireCalls[0].function as { name: string; arguments: string };
  assert.equal(fn.name, 'trip__read');
  // 供应商标量要求 arguments 是 JSON 字符串，而不是对象。
  assert.equal(typeof fn.arguments, 'string');
  assert.deepEqual(JSON.parse(fn.arguments), { tripId: 'trip_1' });
  assert.equal(messages[2].tool_call_id, 'call_9');
});

test('OpenAI adapter rejects a 200 response without choices instead of faking success', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ id: 'x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: 'https://model.example/v1',
    apiKey: 'k',
    modelName: 'm',
    fetchImpl: fakeFetch,
  });
  const turn = await provider.generateTurn({ messages: [], tools: [] });
  assert.equal(turn.finishReason, 'error');
  assert.equal(turn.error?.code, 'MODEL_BAD_RESPONSE');
});

test('OpenAI adapter reports malformed tool arguments instead of silently passing {}', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [{ id: 'c1', function: { name: 'trip.read', arguments: '{not json' } }],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: 'https://model.example/v1',
    apiKey: 'k',
    modelName: 'm',
    fetchImpl: fakeFetch,
  });
  const turn = await provider.generateTurn({ messages: [], tools: [] });
  assert.equal(turn.finishReason, 'error');
  assert.equal(turn.error?.code, 'MODEL_BAD_TOOL_ARGS');
  assert.equal(turn.toolCalls.length, 0);
});

test('tool gateway rejects missing, non-finite and out-of-enum arguments before the handler runs', async () => {
  const gateway = new ToolGateway(new ActionAuthorizationService());
  let handlerCalls = 0;
  gateway.register({
    name: 'plan.propose',
    description: '生成提案',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['initial', 'replan'] },
        baseRevision: { type: 'number' },
      },
      required: ['kind', 'baseRevision'],
    },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: () => {
      handlerCalls += 1;
      return { result: { ok: true } };
    },
  });
  const context = { actorId: 'a', sessionId: 's', tripId: 't', now: NOW };

  const missing = await gateway.executeBatch(
    [toolCall('c1', 'plan.propose', { kind: 'initial' })],
    context,
  );
  assert.equal(missing.results[0].status, 'failed');
  assert.equal(missing.results[0].error?.code, 'INVALID_INPUT');

  const nan = await gateway.executeBatch(
    [toolCall('c2', 'plan.propose', { kind: 'initial', baseRevision: Number.NaN })],
    context,
  );
  assert.equal(nan.results[0].status, 'failed');
  assert.match(nan.results[0].error?.message ?? '', /有限数字/);

  const wrongEnum = await gateway.executeBatch(
    [toolCall('c3', 'plan.propose', { kind: 'nonsense', baseRevision: 0 })],
    context,
  );
  assert.equal(wrongEnum.results[0].status, 'failed');
  assert.match(wrongEnum.results[0].error?.message ?? '', /只能是/);

  // 合法参数仍然放行。
  const valid = await gateway.executeBatch(
    [toolCall('c4', 'plan.propose', { kind: 'replan', baseRevision: 3 })],
    context,
  );
  assert.equal(valid.results[0].status, 'succeeded');
  assert.equal(handlerCalls, 1);
});

// ---------------------------------------------------------------------------
// Operation 状态机
// ---------------------------------------------------------------------------

test('complete persists the cancelled terminal state instead of leaving a zombie', () => {
  const store = new OperationStore();
  store.create(makeOperation({ status: 'queued' }));
  const claimed = store.claim('op_1', 'lease_a', NOW);
  assert.equal(claimed.ok, true);
  store.cancel('op_1', NOW);

  const completed = store.complete('op_1', 'lease_a', { kind: 'proposal' }, NOW);
  assert.equal(completed.ok, false);
  assert.equal(completed.error?.code, 'OPERATION_CANCELLED');
  // 取消前必须落库：否则任务停在 running 且 canClaim 永远拒绝它。
  assert.equal(store.get('op_1')?.status, 'cancelled');
  assert.equal(store.get('op_1')?.leaseToken, null);
});

test('resume persists the cancelled terminal state for a waiting operation', () => {
  const store = new OperationStore();
  store.create(makeOperation({ status: 'queued' }));
  store.claim('op_1', 'lease_a', NOW);
  store.pause('op_1', 'lease_a', 'awaiting_approval', {
    now: NOW,
    waitUntil: new Date(Date.parse(NOW) + 600_000).toISOString(),
  });
  store.cancel('op_1', NOW);

  const resumed = store.resume('op_1', NOW, 'awaiting_approval');
  assert.equal(resumed.ok, false);
  assert.equal(resumed.error?.code, 'OPERATION_CANCELLED');
  assert.equal(store.get('op_1')?.status, 'cancelled');
});

// ---------------------------------------------------------------------------
// 外部调用预算台账
// ---------------------------------------------------------------------------

test('settle is idempotent and does not double count quota', () => {
  const ledger = new ExternalBudgetLedger({ model_requests: 10 });
  const reservation = ledger.reserve('model_requests', 2);
  assert.ok(reservation.reservationId);

  assert.equal(ledger.settle(reservation.reservationId!, 3).ok, true);
  assert.equal(ledger.usage('model_requests'), 3);

  const twice = ledger.settle(reservation.reservationId!, 5);
  assert.equal(twice.ok, false);
  assert.equal(twice.code, 'RESERVATION_NOT_FOUND');
  assert.equal(ledger.usage('model_requests'), 3);
});

test('release cannot be replayed after settle', () => {
  const ledger = new ExternalBudgetLedger({ model_requests: 10 });
  const reservation = ledger.reserve('model_requests', 2);
  ledger.settle(reservation.reservationId!, 2);
  assert.equal(ledger.release(reservation.reservationId!).ok, false);
  assert.equal(ledger.usage('model_requests'), 2);
});

test('a throwing model provider releases reservations and fails the operation', async () => {
  const trips = new InMemoryTripService(() => NOW);
  const ledger = new ExternalBudgetLedger({ model_requests: 5, tool_calls: 5 }, () => NOW);
  const throwingModel: ModelProvider = {
    providerName: 'throwing',
    modelName: 'throwing-1',
    generateTurn: async (): Promise<ModelTurn> => {
      throw new Error('供应商连接中断');
    },
  };
  const agents = new AgentService(trips, {
    now: () => NOW,
    modelProvider: throwingModel,
    externalBudget: ledger,
  });
  const { principal, session } = trips.createAnonymousSession();
  const created = trips.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const view = await agents.start({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId: created.value.trip.tripId,
    baseRevision: 0,
    kind: 'initial',
  });

  assert.equal(view.operation.status, 'failed');
  // 预占必须释放，否则额度会被 reserved 记录永久占用。
  assert.equal(ledger.usage('model_requests'), 0);
  assert.equal(ledger.usage('tool_calls'), 0);
  assert.equal(ledger.reserve('model_requests', 5).ok, true);
});

// ---------------------------------------------------------------------------
// HTTP 边界
// ---------------------------------------------------------------------------

test('chat history is scoped to the trip owner', async () => {
  await withServer({}, async (baseUrl) => {
    const owner = await guest(baseUrl);
    const tripId = await createTrip(baseUrl, owner);
    await fetch(`${baseUrl}/api/v1/trips/${tripId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner },
      body: JSON.stringify({ text: '记下：私人行程备注' }),
    });

    const stranger = await guest(baseUrl);
    const denied = await fetch(`${baseUrl}/api/v1/trips/${tripId}/messages`, {
      headers: { cookie: stranger },
    });
    assert.equal(denied.status, 404);
    const body = (await denied.json()) as { data?: unknown };
    assert.equal(body.data, undefined);

    // 归属者仍然读得到。
    const allowed = await fetch(`${baseUrl}/api/v1/trips/${tripId}/messages`, {
      headers: { cookie: owner },
    });
    assert.equal(allowed.status, 200);
    const allowedBody = (await allowed.json()) as { data: unknown[] };
    assert.equal(allowedBody.data.length, 2);
  });
});

test('a malformed percent-encoded cookie yields 401 instead of 500', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/me`, {
      headers: { cookie: 'bantu_session=%' },
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'SESSION_EXPIRED');
  });
});

test('non-array snapshot fields return 400 instead of an unhandled 500', async () => {
  await withServer({}, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    const tripId = await createTrip(baseUrl, cookie);
    for (const field of ['stops', 'routeLegs', 'constraints', 'plannedCharges']) {
      const response = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ expectedRevision: 0, [field]: 1 }),
      });
      assert.equal(response.status, 400, `${field} must be rejected as 400`);
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, 'INVALID_INPUT');
    }
  });
});

test('plan-edits rejects non-array stops with 400', async () => {
  await withServer({}, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    const tripId = await createTrip(baseUrl, cookie);
    const response = await fetch(`${baseUrl}/api/v1/trips/${tripId}/plan-edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ expectedRevision: 0, stops: 'nope' }),
    });
    assert.equal(response.status, 400);
  });
});

test('plan-edits with a stop whose place lacks facilityCodes is not a 500', async () => {
  // 端到端复现：修复前这条请求在 patchTrip 里抛 TypeError，响应是 500。
  await withServer({}, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    const tripId = await createTrip(baseUrl, cookie);
    const response = await fetch(`${baseUrl}/api/v1/trips/${tripId}/plan-edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        expectedRevision: 0,
        constraints: [
          {
            constraintId: 'facility:1',
            kind: 'facility_required',
            strength: 'hard',
            payload: { stopId: 'stop_1', facilityCode: 'toilet' },
          },
        ],
        stops: [
          { stopId: 'stop_1', placeId: 'place_1', startMinutes: 840, endMinutes: 900, place: { placeId: 'place_1', name: '西湖' } },
        ],
      }),
    });
    assert.equal(response.status, 200, `预期 200，实际 ${response.status}`);
    const body = (await response.json()) as {
      data: { snapshot: { stops: { place: { facilityCodes?: unknown } }[] } };
    };
    assert.equal(
      Array.isArray(body.data.snapshot.stops[0].place.facilityCodes),
      true,
      '响应里的 place.facilityCodes 必须是数组',
    );
  });
});

test('an invalid JSON body is still reported as 400', async () => {
  await withServer({}, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    const tripId = await createTrip(baseUrl, cookie);
    const response = await fetch(`${baseUrl}/api/v1/trips/${tripId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'INVALID_INPUT');
  });
});

test('expectedRevision is not persisted into the trip snapshot', async () => {
  await withServer({}, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    const tripId = await createTrip(baseUrl, cookie);
    const patched = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ expectedRevision: 0, partySize: 3 }),
    });
    assert.equal(patched.status, 200);
    const body = (await patched.json()) as {
      data: { snapshot: Record<string, unknown>; trip: { revision: number } };
    };
    assert.equal('expectedRevision' in body.data.snapshot, false);
    assert.equal(body.data.trip.revision, 1);
  });
});

test('place detail uses the injected provider instead of the hardcoded demo catalog', async () => {
  const calls: string[] = [];
  const stubPlaceProvider = {
    providerName: 'stub',
    search: new DemoPlaceProvider().search.bind(new DemoPlaceProvider()),
    detail: async (placeId: string) => {
      calls.push(placeId);
      return {
        placeId,
        provider: 'amap',
        name: '注入的地点',
        category: 'food',
        coordinates: { lat: 30.1, lng: 120.1, source: 'amap' as const },
        facilityCodes: ['food'],
        evidenceIds: ['evidence_1'],
        suggestedDurationMinutes: 60,
        openingIntervals: [],
      };
    },
  };

  await withServer({ placeProvider: stubPlaceProvider }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/places/amap_B123`);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['amap_B123']);
    const body = (await response.json()) as {
      data: { name: string };
      meta: { dataMode: string };
    };
    assert.equal(body.data.name, '注入的地点');
    assert.equal(body.meta.dataMode, 'online');
  });
});

test('online empty place search uses the curated local catalog without calling Amap', async () => {
  let calls = 0;
  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: (async () => {
    calls += 1;
    throw new Error('Amap should not be called for an empty catalog search');
  }) as typeof fetch });
  await withServer({ placeProvider: provider }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/places?cityCode=310100`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<{ placeId: string }>; meta: { dataMode: string } };
    assert.ok(body.data.some(place => place.placeId === '12143603120601'));
    assert.equal(body.meta.dataMode, 'demo');
    assert.equal(calls, 0);
  });
});

test('an unknown place still returns 404 through the provider path', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/places/does_not_exist`);
    assert.equal(response.status, 404);
  });
});

test('an online place provider outage returns a retryable 503 instead of a false 404', async () => {
  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: (async () => {
    throw new Error('network unavailable');
  }) as typeof fetch });
  await withServer({ placeProvider: provider }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/places/amap_B123`);
    assert.equal(response.status, 503);
    const body = await response.json() as { error: { code: string; retryable: boolean; message: string } };
    assert.equal(body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(body.error.retryable, true);
    assert.match(body.error.message, /暂时不可用/);
    assert.doesNotMatch(body.error.message, /不存在/);
  });
});

test('service retryable flag reaches the response envelope', async () => {
  await withServer({}, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    const tripId = await createTrip(baseUrl, cookie);
    // 用与 schema 不符的字段触发一次业务错误，确认错误体仍带 retryable 字段。
    const response = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ expectedRevision: 99 }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    assert.equal(body.error.code, 'REVISION_CONFLICT');
    assert.equal(typeof body.error.retryable, 'boolean');
  });
});

test('the undocumented global feedback stub is gone', async () => {
  await withServer({}, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    const response = await fetch(`${baseUrl}/api/v1/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ rating: 5 }),
    });
    assert.equal(response.status, 404);
    // 文档化的旅程级入口仍然记录。
    const tripId = await createTrip(baseUrl, cookie);
    const recorded = await fetch(`${baseUrl}/api/v1/trips/${tripId}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ rating: 5 }),
    });
    assert.equal(recorded.status, 200);
  });
});

test('an expired session is rejected at the auth boundary', async () => {
  let current = NOW;
  await withServer({ now: () => current }, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    const alive = await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } });
    assert.equal(alive.status, 200);

    // 默认会话 TTL 为 30 天；越过 TTL 后 token 不能继续有效。
    current = '2026-11-15T13:00:00+08:00';
    const expired = await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } });
    assert.equal(expired.status, 401);
    const body = (await expired.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'SESSION_EXPIRED');
  });
});

test('a revoked session stops authenticating before its TTL', async () => {
  await withServer({}, async (baseUrl) => {
    const cookie = await guest(baseUrl);
    assert.equal((await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } })).status, 200);
    await fetch(`${baseUrl}/api/v1/session`, { method: 'DELETE', headers: { cookie } });
    const after = await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } });
    assert.equal(after.status, 401);
  });
});

// ---------------------------------------------------------------------------
// 对话持久化与清理
// ---------------------------------------------------------------------------

test('MessageService round-trips through serialize/loadSerialized and clearTrip', async () => {
  const trips = new InMemoryTripService(() => NOW);
  const messages = new MessageService(trips, () => NOW);
  const { principal, session } = trips.createAnonymousSession();
  const created = trips.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const tripId = created.value.trip.tripId;

  await messages.handle({
    actorId: principal.principalId,
    sessionId: session.sessionId,
    tripId,
    text: '记下：今天很顺利',
  });
  assert.equal(messages.list(tripId).length, 2);

  const restored = new MessageService(trips, () => NOW);
  restored.loadSerialized(messages.serialize());
  assert.equal(restored.list(tripId).length, 2);
  assert.equal(restored.list(tripId)[0].text, '记下：今天很顺利');

  restored.clearTrip(tripId);
  assert.equal(restored.list(tripId).length, 0);
});

test('chat history survives a restart through SqliteStateStore', async () => {
  const { rmSync } = await import('node:fs');
  const fileName = `${process.cwd()}/data/test-messages-${process.pid}-${Date.now()}.sqlite`;

  let cookie = '';
  let tripId = '';
  const storeA = new SqliteStateStore(fileName);
  try {
    await withServer({ stateStore: storeA }, async (baseUrl) => {
      cookie = await guest(baseUrl);
      tripId = await createTrip(baseUrl, cookie);
      await fetch(`${baseUrl}/api/v1/trips/${tripId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text: '记下：重启后也要在' }),
      });
    });
  } finally {
    storeA.close();
  }

  const storeB = new SqliteStateStore(fileName);
  try {
    await withServer({ stateStore: storeB }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/trips/${tripId}/messages`, {
        headers: { cookie },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: Array<{ text: string }> };
      assert.equal(body.data.length, 2);
      assert.equal(body.data[0].text, '记下：重启后也要在');
    });
  } finally {
    storeB.close();
    rmSync(fileName, { force: true });
  }
});

test('MemoryStateStore also implements the batched write used by the server', () => {
  const store = new MemoryStateStore();
  store.setMany([
    ['a', '1'],
    ['b', '2'],
  ]);
  assert.equal(store.get('a'), '1');
  assert.equal(store.get('b'), '2');
  store.delete('a');
  assert.equal(store.get('a'), null);
});

// ---------------------------------------------------------------------------
// Amap 适配器边界
// ---------------------------------------------------------------------------

test('amap search uses place/text when no center is supplied', async () => {
  const urls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ status: '1', info: 'OK', pois: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: fakeFetch });
  await provider.search({ cityCode: '0571', query: '休息' });
  assert.ok(urls[0].includes('/v3/place/text?'), urls[0]);

  await provider.search({ cityCode: '0571', query: '休息', center: { lat: 30.2, lng: 120.1 } });
  assert.ok(urls[1].includes('/v3/place/around?'), urls[1]);
  assert.ok(urls[1].includes('location=120.1%2C30.2'), urls[1]);
});

test('amap place search maps municipality adcodes and limits to the chosen city', async () => {
  const urls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ status: '1', info: 'OK', pois: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: fakeFetch });
  const cityOf = (url: string) => new URL(url).searchParams.get('city');
  const limitOf = (url: string) => new URL(url).searchParams.get('citylimit');

  // 直辖市「市辖区」码换成高德认的市级 adcode，否则高德回退全国。
  await provider.search({ cityCode: '310100', query: '公园' });
  assert.equal(cityOf(urls[0]), '310000');
  assert.equal(limitOf(urls[0]), 'true');
  await provider.search({ cityCode: '110100', query: '公园' });
  assert.equal(cityOf(urls[1]), '110000');

  // 地级市码本就有效，原样透传。
  await provider.search({ cityCode: '330100', query: '公园' });
  assert.equal(cityOf(urls[2]), '330100');

  // 区县码优先且不改写。
  await provider.search({ cityCode: '310100', districtAdcode: '310104', query: '公园' });
  assert.equal(cityOf(urls[3]), '310104');
  assert.equal(limitOf(urls[3]), 'true');

  // 未选城市（空串）：不带 city，也不强制 citylimit（保留全国检索）。
  await provider.search({ cityCode: '', query: '公园' });
  assert.equal(cityOf(urls[4]), null);
  assert.equal(limitOf(urls[4]), null);
});

test('amap detail queries the POI id endpoint rather than a keyword search', async () => {
  const urls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({
        status: '1',
        info: 'OK',
        pois: [{ id: 'B123', name: '样例', type: '餐饮服务', location: '120.1,30.2' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: fakeFetch });
  const place = await provider.detail('amap_B123');
  assert.ok(urls[0].includes('/v3/place/detail?'), urls[0]);
  assert.ok(urls[0].includes('id=B123'), urls[0]);
  assert.equal(place?.placeId, 'amap_B123');
  assert.equal(place?.provider, 'amap');
});

test('amap detail derives a city-level cityCode from the POI district adcode', async () => {
  // 真实触发：伴途「安排徐汇一日游」→ plans.route 公共交通段。detail() 只有 POI ID，
  // 修复前 cityCode 为空，路线规划报「公共交通规划需要先确定起点和终点所在城市」，
  // 模型反复重试直到撞上回合上限，计划排不上路线。
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        status: '1',
        info: 'OK',
        pois: [{ id: 'B0FFIK0Z21', name: '武康路', type: '风景名胜', location: '121.43993,31.207255', adcode: '310104', citycode: '021' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: fakeFetch });
  const place = await provider.detail('amap_B0FFIK0Z21');
  // 区县 adcode 310104 → 市级 310100；电话区号 021 不能当城市码。
  assert.equal(place?.cityCode, '310100');
  assert.equal(place?.districtAdcode, '310104');
});

test('amap detail leaves cityCode empty when the POI has no usable adcode', async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ status: '1', info: 'OK', pois: [{ id: 'B999', name: '无区码', location: '121.4,31.2', citycode: '021' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: fakeFetch });
  const place = await provider.detail('amap_B999');
  assert.equal(place?.cityCode, '');
});

test('amap detail returns null for a genuine not-found instead of throwing', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ status: '1', info: 'OK', pois: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const provider = new AmapPlaceProvider({ apiKey: 'k', fetchImpl: fakeFetch });
  assert.equal(await provider.detail('amap_missing'), null);
});

// ---------------------------------------------------------------------------
// 手动编辑里形状不对的字段
//
// POST /trips/:id/plan-edits 把 body.stops 直接当成类型化数组（`as TripView['snapshot']['stops']`），
// 没有逐字段校验。类型系统因此认为可选字段一定合法，而领域层读它们时用的是
// `.length`／`.some`／`.includes`——缺字段会抛异常，传字符串会退化成子串匹配。
// 归一化的唯一入口是 normalizePlanStop，这三条测试都盯着它。
// ---------------------------------------------------------------------------

test('a plan stop whose place omits facilityCodes does not crash validation', async () => {
  // 真实触发：POST /plan-edits 带一条 facility_required 约束，某个 stop 的 place 只写了 placeId/name。
  // 修复前 evaluateSnapshot 在 patchTrip 里抛 TypeError，整个请求变成 500。
  const service = new InMemoryTripService(() => NOW);
  const { principal } = service.createAnonymousSession();
  const created = service.createTrip(principal.principalId, {
    cityCode: '330100',
    localDate: '2026-09-20',
    dataMode: 'demo',
  });
  assert.equal(created.ok, true);
  const tripId = created.ok ? created.value.trip.tripId : '';

  const patched = service.patchTrip(principal.principalId, tripId, {
    expectedRevision: created.ok ? created.value.trip.revision : 1,
    constraints: [
      {
        constraintId: 'facility:1',
        kind: 'facility_required',
        strength: 'hard',
        payload: { stopId: 'stop_1', facilityCode: 'toilet' },
      },
    ],
    stops: [
      {
        stopId: 'stop_1',
        placeId: 'place_1',
        startMinutes: 840, endMinutes: 900,
        place: { placeId: 'place_1', name: '西湖' },
      },
    ],
  } as never);

  // 结果本身如何（unknown／fail）由证据决定，这里只要求它**不崩**。
  assert.equal(patched.ok, true, patched.ok ? '' : patched.error.message);
  const stop = patched.ok ? patched.value.snapshot.stops?.[0] : undefined;
  assert.equal(
    Array.isArray(stop?.place?.facilityCodes),
    true,
    '归一化后 place.facilityCodes 必须是数组',
  );
});

test('a string facilityCodes cannot make a hard constraint pass by substring match', () => {
  // '.includes' 在字符串上是子串匹配：facilityCodes: 'no-toilet-here' 查 'toilet' 会命中。
  // 硬约束因此假通过——比抛异常更糟，因为它静默地把"没有证据"说成"满足"。
  const snapshot = normalizeTripSnapshot({
    tripId: 't1',
    stops: [
      {
        stopId: 's1',
        placeId: 'p1',
        place: { placeId: 'p1', name: '某地', facilityCodes: 'no-toilet-here' },
      },
    ],
  } as never);

  const check = checkConstraint(
    {
      constraintId: 'facility:1',
      kind: 'facility_required',
      strength: 'hard',
      payload: { stopId: 's1', facilityCode: 'toilet' },
    } as never,
    snapshot,
  );
  assert.notEqual(check.status, 'pass', `字符串被当成设施清单，约束假通过: ${check.status}`);
});

test('a non-array openingIntervals is normalized instead of reaching .some()', () => {
  // 窗口检查先过，才会走到 openingIntervals.some(...)；传字符串时那里抛 TypeError。
  const snapshot = normalizeTripSnapshot({
    tripId: 't1',
    stops: [
      {
        stopId: 's1',
        placeId: 'p1',
        startMinutes: 700,
        endMinutes: 760,
        openingIntervals: '540-1020',
      },
    ],
  } as never);

  const check = checkConstraint(
    {
      constraintId: 'window:1',
      kind: 'visit_window',
      strength: 'hard',
      payload: { stopId: 's1' },
    } as never,
    snapshot,
  );
  assert.equal(check.status, 'unknown', `畸形营业区间应如实报 unknown，实际 ${check.status}`);
  assert.equal(check.reasonCode, 'invalid_constraint');
});

test('a day walking limit in minutes never adds recorded meters as minutes', () => {
  // 工程契约的正式口径是米；maxWalkingMinutes 是早期字段。
  // 已记录的实际步行只有米这一个口径，首版不按假定步速换算（见 normalize.ts 的同一条判断）。
  // 修复前这里把 actualWalkingMeters 直接加进分钟总量：走 2 公里会被算成超 2000 分钟。
  const base = {
    tripId: 't1',
    stops: [
      { stopId: 's1', placeId: 'p1', startMinutes: 600, endMinutes: 660 },
      { stopId: 's2', placeId: 'p2', startMinutes: 700, endMinutes: 760 },
    ],
    routeLegs: [
      { legId: 'l1', fromStopId: 's1', toStopId: 's2', transportMode: 'walking', walkingMeters: 800, walkingMinutes: 10 },
    ],
    actualWalkingMeters: 2000,
    actualWalkingComplete: true,
  } as never;

  const constraint = {
    constraintId: 'walk:day',
    kind: 'walking_limit',
    strength: 'hard',
    payload: { scope: 'day', maxWalkingMinutes: 120 },
  } as never;

  const withActual = checkConstraint(constraint, normalizeTripSnapshot(base));
  assert.equal(
    withActual.status,
    'unknown',
    '有实测步行时分钟口径无法核定，必须如实 unknown 而不是拿米当分钟',
  );
  assert.equal(withActual.reasonCode, 'walking_units_incomparable');

  // 没有实测步行（或为 0）时，计划分钟数本身仍然可以判定。
  const noActual = checkConstraint(
    constraint,
    normalizeTripSnapshot({
      ...(base as Record<string, unknown>),
      actualWalkingMeters: 0,
      actualWalkingComplete: true,
    } as never),
  );
  assert.equal(noActual.status, 'pass', `仅计划 10 分钟步行不应超 120 分钟上限: ${noActual.reasonCode}`);
});

// ---------------------------------------------------------------------------
// 应用候选时的事实保留
//
// 候选快照是重新生成的（demo-data 会带上自己的样例预算、空约束和 draft 状态），
// 整体替换会把用户已经发生的事实和确认过的设定一起抹掉。
// 三条断言各管一件事：
//   1. 事实**要被继承**（候选里根本没有这些字段，不继承就丢）；
//   2/3. 继承必须**盖过候选**（候选会显式带上 draft／样例预算／空约束／planned 状态）。
// ---------------------------------------------------------------------------

const APPLY_NOW = '2026-09-20T13:00:00+08:00';

function candidateProposal(candidateSnapshot: ReturnType<typeof makeSnapshot>) {
  return {
    proposalId: 'proposal_1',
    tripId: 'trip_1',
    kind: 'replan' as const,
    baseRevision: 4,
    status: 'ready' as const,
    contextSnapshotId: null,
    createdAt: APPLY_NOW,
    expiresAt: '2026-09-21T13:00:00+08:00',
    candidates: [
      {
        candidateId: 'candidate_1',
        title: '插一次休息',
        summary: '保留后续节点',
        applicability: 'applicable' as const,
        snapshot: candidateSnapshot,
        checks: [],
      },
    ],
  };
}

/** 当前快照：已出发、去过一站、记了花费与实测步行，用户还设了预算和硬约束。 */
function snapshotWithFacts() {
  return makeSnapshot({
    version: 4,
    lifecycle: 'active',
    planningStatus: 'needs_review',
    stops: [
      makeStop({ stopId: 's1', placeId: 'p1', status: 'completed' }),
      makeStop({ stopId: 's2', placeId: 'p2', startMinutes: 10 * 60 }),
    ],
    budget: { currency: 'CNY', limitMinor: 50000, strength: 'hard', scope: 'trip' },
    constraints: [
      {
        constraintId: 'walk:day',
        kind: 'walking_limit',
        strength: 'hard',
        payload: { scope: 'day', maxWalkingMeters: 5000 },
      },
    ] as never,
    executionEvents: [
      {
        executionEventId: 'exec_1',
        tripId: 'trip_1',
        stopId: 's1',
        type: 'complete',
        occurredAt: '2026-09-20T04:10:00.000Z',
        recordedAt: '2026-09-20T04:10:00.000Z',
        source: 'user_report',
      },
    ] as never,
    spendEvents: [
      {
        spendEventId: 'spend_1',
        tripId: 'trip_1',
        amountMinor: 12345,
        currency: 'CNY',
        basis: 'party',
        occurredAt: '2026-09-20T04:20:00.000Z',
        recordedAt: '2026-09-20T04:20:00.000Z',
        completenessConfirmed: true,
        includedChargeIds: [],
      },
    ] as never,
    actualSpendMinor: 12345,
    actualSpendComplete: true,
    spendRef: 'spend_1',
    actualWalkingMeters: 2200,
    actualWalkingComplete: true,
    walkingRef: 'walk_1',
  });
}

test('applying a candidate keeps recorded execution and spend facts', () => {
  const current = snapshotWithFacts();
  // 候选是"重新生成的计划"：只有节点与路线，没有事实，还带着自己的样例预算与空约束。
  const candidateSnapshot = makeSnapshot({
    version: 0,
    lifecycle: 'draft',
    stops: [makeStop({ stopId: 's1', placeId: 'p1' }), makeStop({ stopId: 's2', placeId: 'p2', startMinutes: 840 }), makeStop({ stopId: 's3', placeId: 'p3', startMinutes: 900 })],
    budget: { currency: 'CNY', limitMinor: 20000, strength: 'hard', scope: 'trip' },
    constraints: [],
  });

  const applied = applyProposal(candidateProposal(candidateSnapshot), current, APPLY_NOW, 'plan.apply', {
    candidateId: 'candidate_1',
  });
  assert.equal(applied.ok, true, applied.ok ? '' : applied.message);
  if (!applied.ok) return;
  const snapshot = applied.version.snapshot;

  assert.equal(snapshot.executionEvents?.length, 1, '执行事实被候选覆盖了');
  assert.equal(snapshot.spendEvents?.length, 1, '花费事实被候选覆盖了');
  assert.equal(snapshot.actualSpendMinor, 12345, '累计花费被候选覆盖了');
  assert.equal(snapshot.actualWalkingMeters, 2200, '实测步行被候选覆盖了');
  assert.equal(snapshot.spendRef, 'spend_1');
  assert.equal(snapshot.walkingRef, 'walk_1');
  assert.equal(snapshot.actualSpendComplete, true);
  assert.equal(snapshot.actualWalkingComplete, true);
});

test('applying a candidate keeps the lifecycle and the user-confirmed settings', () => {
  const current = snapshotWithFacts();
  const candidateSnapshot = makeSnapshot({
    version: 0,
    lifecycle: 'draft',
    stops: [makeStop({ stopId: 's1', placeId: 'p1' })],
    budget: { currency: 'CNY', limitMinor: 20000, strength: 'hard', scope: 'trip' },
    constraints: [],
  });

  const applied = applyProposal(candidateProposal(candidateSnapshot), current, APPLY_NOW, 'plan.apply', {
    candidateId: 'candidate_1',
  });
  assert.equal(applied.ok, true, applied.ok ? '' : applied.message);
  if (!applied.ok) return;
  const snapshot = applied.version.snapshot;

  assert.equal(snapshot.lifecycle, 'active', '进行中的旅行被候选打回了 draft');
  assert.equal(snapshot.budget?.limitMinor, 50000, '用户设的预算上限被样例值覆盖了');
  assert.equal(
    snapshot.constraints?.some((item) => item.constraintId === 'walk:day'),
    true,
    '用户确认过的约束被候选清空了',
  );
  // 计划内容本身仍然来自候选。
  assert.equal(snapshot.stops?.length, 1);
  assert.equal(snapshot.version, 5);
});

test('applying a candidate does not reschedule a stop that already happened', () => {
  const current = snapshotWithFacts();
  // 候选把 s1 当成还没去的节点（status 缺省即 planned）。
  const candidateSnapshot = makeSnapshot({
    version: 0,
    stops: [
      makeStop({ stopId: 's1', placeId: 'p1' }),
      makeStop({ stopId: 's2', placeId: 'p2', startMinutes: 14 * 60 }),
    ],
    constraints: [],
  });

  const applied = applyProposal(candidateProposal(candidateSnapshot), current, APPLY_NOW, 'plan.apply', {
    candidateId: 'candidate_1',
  });
  assert.equal(applied.ok, true, applied.ok ? '' : applied.message);
  if (!applied.ok) return;
  const stops = applied.version.snapshot.stops ?? [];

  assert.equal(
    stops.find((stop) => stop.stopId === 's1')?.status,
    'completed',
    '已完成的节点在应用候选后变回了 planned（已完成事实被重排）',
  );
  // 还没去过的节点按候选安排。
  assert.equal(stops.find((stop) => stop.stopId === 's2')?.startMinutes, 14 * 60);
});
