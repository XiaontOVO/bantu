import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { modelTurn, toolCall } from '../src/providers/model.js';
import { PersonalAgentTasks } from '../src/services/personal-agent-tasks.js';

test('continuing after cancellation cannot resurrect an older interrupted task', () => {
  const tasks = new PersonalAgentTasks();
  const old = tasks.start('owner', []);
  old.status = 'interrupted';
  const current = tasks.start('owner', []);
  tasks.cancel('owner', current.id);
  current.status = 'completed';
  assert.equal(tasks.resume('owner'), undefined);
  assert.equal(old.status, 'interrupted');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test('cancel during model thinking prevents proposed writes and survives restart', async () => {
  const entered = deferred(), release = deferred();
  const store = new MemoryStateStore();
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      entered.resolve(); await release.promise;
      return modelTurn([toolCall('note', 'memories.create', { text: '不得写入' })]);
    },
  } };
  const ctx = createServerContext(options);
  const response = runPersonalAgent(ctx, 'owner', '记笔记', []);
  await entered.promise;
  const task = ctx.personalAgentTasks.current('owner')!;
  assert.equal(task.status, 'running');
  assert.equal(ctx.personalAgentTasks.current('other'), null);
  assert.throws(() => ctx.personalAgentTasks.cancel('other', task.id), /不存在/);
  ctx.personalAgentTasks.cancel('owner', task.id);
  ctx.persistState();
  const interruptedRestart = createServerContext(options);
  assert.equal(interruptedRestart.personalAgentTasks.current('owner')!.status, 'completed');
  assert.equal(interruptedRestart.personalAgentTasks.resume('owner'), undefined);
  release.resolve();
  assert.match((await response).reply, /已停止/);
  assert.equal(ctx.personalMemoriesService.list('owner').length, 0);
});

test('cancel retains already committed writes and stops the next tool in a batch', async () => {
  const entered = deferred(), release = deferred();
  const ctx = createServerContext({ seedDemo: false, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      return modelTurn([
        toolCall('first', 'memories.create', { text: '保留这条' }),
        toolCall('read', 'places.search', { query: '等待' }),
        toolCall('last', 'memories.create', { text: '不应保存这条' }),
      ]);
    },
  } });
  const original = ctx.fallbackPlaceProvider.search.bind(ctx.fallbackPlaceProvider);
  ctx.fallbackPlaceProvider.search = async input => { entered.resolve(); await release.promise; return original(input); };
  const response = runPersonalAgent(ctx, 'owner', '执行多步安排', []);
  await entered.promise;
  const task = ctx.personalAgentTasks.current('owner')!;
  assert.equal(ctx.personalMemoriesService.list('owner').length, 1);
  ctx.personalAgentTasks.cancel('owner', task.id);
  release.resolve();
  const result = await response;
  assert.match(result.reply, /已经完成的改动已保留/);
  assert.deepEqual(ctx.personalMemoriesService.list('owner').map(m => m.userText), ['保留这条']);
  assert.ok(result.refresh.includes('memories'));
  assert.equal(ctx.personalAgentTasks.resume('owner'), undefined);
  const newer = ctx.personalAgentTasks.start('owner', []);
  assert.throws(() => ctx.personalAgentTasks.cancel('owner', task.id), /已经切换/);
  assert.equal(newer.cancelRequested, undefined);
});
