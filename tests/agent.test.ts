import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/agent/runtime.js';
import { ToolGateway } from '../src/agent/tools.js';
import { ActionAuthorizationService } from '../src/domain/authorization.js';
import { ScriptedModelProvider, modelTurn, toolCall } from '../src/providers/model.js';

function context(now = '2026-09-20T13:00:00+08:00') {
  return {
    actorId: 'actor_1',
    sessionId: 'session_1',
    tripId: 'trip_1',
    now,
  };
}

test('tool gateway executes read tools and returns callId-matched structured result', async () => {
  const gateway = new ToolGateway(new ActionAuthorizationService());
  gateway.register({
    name: 'places.search',
    description: '检索地点',
    inputSchema: { type: 'object' },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: (args) => ({ result: { items: ['place_1'], query: args.query } }),
  });
  const batch = await gateway.executeBatch(
    [toolCall('call_1', 'places.search', { query: '休息' })],
    context(),
  );
  assert.equal(batch.status, 'completed');
  assert.equal(batch.results[0].status, 'succeeded');
  assert.deepEqual(batch.results[0].result, { items: ['place_1'], query: '休息' });
});

test('write tool without grant creates action request and waits instead of writing', async () => {
  const authorization = new ActionAuthorizationService();
  const gateway = new ToolGateway(authorization);
  let writes = 0;
  gateway.register({
    name: 'memory.create',
    description: '保存随手记',
    inputSchema: { type: 'object' },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    handler: () => {
      writes += 1;
      return { result: { saved: true }, mutationId: 'mutation_1' };
    },
  });
  const batch = await gateway.executeBatch(
    [toolCall('call_memory', 'memory.create', { text: '今天很开心' })],
    context(),
  );
  assert.equal(batch.status, 'awaiting_approval');
  assert.equal(writes, 0);
  assert.equal(batch.results[0].actionRequestId, 'action_call_memory');
  assert.equal(authorization.getRequest('action_call_memory')?.status, 'pending');
});

test('one model turn executes at most one write call and rejects the rest', async () => {
  const gateway = new ToolGateway(new ActionAuthorizationService());
  let writes = 0;
  for (const name of ['memory.create', 'progress.record']) {
    gateway.register({
      name,
      description: name,
      inputSchema: { type: 'object' },
      effect: 'write',
      permissionPolicy: 'requires_user_grant',
      handler: () => {
        writes += 1;
        return { result: { ok: true } };
      },
    });
  }
  const batch = await gateway.executeBatch(
    [
      toolCall('call_1', 'memory.create', { text: 'a' }),
      toolCall('call_2', 'progress.record', { stopId: 's' }),
    ],
    context(),
  );
  assert.equal(batch.status, 'awaiting_approval');
  assert.equal(batch.results[1].error?.code, 'WRITE_BATCH_NOT_SUPPORTED');
  assert.equal(writes, 0);
});

test('agent runtime observes tool results and stops on a text turn', async () => {
  const gateway = new ToolGateway(new ActionAuthorizationService());
  gateway.register({
    name: 'trip.read',
    description: '读取旅行',
    inputSchema: { type: 'object' },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: () => ({ result: { revision: 7, stops: ['west_lake'] } }),
  });
  const provider = new ScriptedModelProvider([
    modelTurn([toolCall('call_1', 'trip.read', { tripId: 'trip_1' })]),
    modelTurn([], '已根据当前版本给出建议。', { inputTokens: 10, outputTokens: 5 }),
  ]);
  const runtime = new AgentRuntime(gateway);
  const result = await runtime.run({
    operationId: 'op_1',
    messages: [{ role: 'user', content: '看看当前计划' }],
    allowedTools: ['trip.read'],
    context: context(),
    model: provider,
    gateway,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].toolResults[0].callId, 'call_1');
  assert.equal(result.usage.inputTokens, 10);
});

test('agent runtime pauses on write tool and reports pending action request', async () => {
  const authorization = new ActionAuthorizationService();
  const gateway = new ToolGateway(authorization);
  gateway.register({
    name: 'memory.create',
    description: '保存随手记',
    inputSchema: { type: 'object' },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    handler: () => ({ result: { saved: true } }),
  });
  const provider = new ScriptedModelProvider([
    modelTurn([toolCall('call_1', 'memory.create', { text: '今天很开心' })]),
  ]);
  const runtime = new AgentRuntime(gateway);
  const result = await runtime.run({
    operationId: 'op_2',
    messages: [{ role: 'user', content: '记下今天很开心' }],
    allowedTools: ['memory.create'],
    context: context(),
    model: provider,
    gateway,
  });
  assert.equal(result.status, 'awaiting_approval');
  assert.equal(result.pendingActionRequestIds[0], 'action_call_1');
});
