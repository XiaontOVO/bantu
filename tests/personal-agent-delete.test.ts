import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { modelTurn, toolCall, type ModelTurnRequest } from '../src/providers/model.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { prepareAgentDelete, confirmAgentDelete } from '../src/services/personal-agent-delete.js';

test('deletion confirmation survives restart, detects changes and resumes the remaining task', async () => {
  const store = new MemoryStateStore();
  let planId = '';
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request: ModelTurnRequest) {
      const receipts = request.messages.filter(m => m.role === 'tool').map(m => ({ tool: m.toolName, value: JSON.parse(m.content!) }));
      if (receipts.some(r => r.tool === 'memories.create' && r.value.ok)) return modelTurn([], '删除和记录已完成。');
      if (receipts.some(r => r.tool === 'plans.delete' && r.value.result?.deleted)) return modelTurn([toolCall('note', 'memories.create', { text: '已经清理旧方案' })]);
      return modelTurn([toolCall('delete', 'plans.delete', { planId })]);
    },
  } };
  const ctx = createServerContext(options);
  const days = [{ dayIndex: 0, stops: [], routeLegs: [], plannedCharges: [] }];
  planId = ctx.planLibrary.save('owner', { name: '旧方案', kind: 'scheme', days }).id;
  const reply = await runPersonalAgent(ctx, 'owner', '删除旧方案，再记下已经清理旧方案', []);
  assert.match(reply.reply, /旧方案.*确认删除/);
  assert.equal(ctx.planLibrary.list('owner').length, 1);
  assert.equal(ctx.personalMemoriesService.list('owner').length, 0);
  const restored = createServerContext(options);
  assert.equal(restored.personalAgentTasks.pendingAction('other'), undefined);
  restored.planLibrary.update('owner', planId, { name: '已改名方案', days });
  const stale = await runPersonalAgent(restored, 'owner', '确认删除', []);
  assert.match(stale.reply, /内容已变化/);
  assert.match(stale.reply, /已改名方案/);
  assert.equal(restored.planLibrary.list('owner').length, 1);
  const result = await runPersonalAgent(restored, 'owner', '确认删除', []);
  assert.match(result.reply, /已删除/);
  assert.equal(restored.planLibrary.list('owner').length, 0);
  assert.equal(restored.personalMemoriesService.list('owner').length, 1);
  assert.equal(restored.personalAgentTasks.pendingAction('owner'), undefined);
  assert.deepEqual(result.refresh, ['plans', 'memories']);
});

test('memory deletion can be cancelled and a different actor cannot confirm a prepared target', async () => {
  let memoryId = '';
  const ctx = createServerContext({ seedDemo: false, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
    return modelTurn([toolCall('delete', 'memories.delete', { memoryId })]);
  } } });
  const saved = ctx.personalMemoriesService.create('owner', { userText: '散步记忆' });
  assert.ok(saved.ok); memoryId = saved.value.memoryId;
  const approval = prepareAgentDelete(ctx, 'owner', 'memory', memoryId);
  assert.throws(() => confirmAgentDelete(ctx, 'other', approval), /不属于/);
  await runPersonalAgent(ctx, 'owner', '删除散步记忆', []);
  const continued = await runPersonalAgent(ctx, 'owner', '继续', []);
  assert.match(continued.reply, /确认删除/);
  const cancelled = await runPersonalAgent(ctx, 'owner', '取消', []);
  assert.match(cancelled.reply, /已取消/);
  assert.equal(ctx.personalMemoriesService.list('owner').length, 1);
  assert.equal(ctx.personalAgentTasks.pendingAction('owner'), undefined);
});
