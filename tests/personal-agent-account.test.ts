import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { modelTurn, toolCall } from '../src/providers/model.js';

test('agent nickname changes are scoped, reject stale names and persist without exposing credentials', async () => {
  const store = new MemoryStateStore();
  let next: any, receipt: any;
  const options = { seedDemo: false, stateStore: store, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn(request: any) {
    if (next) { const call = next; next = undefined; return modelTurn([call]); }
    receipt = JSON.parse(request.messages.at(-1).content);
    return modelTurn([], '处理结束');
  } } };
  const ctx = createServerContext(options);
  ctx.accounts.register('nick_owner', 'test-password-123', 'owner');
  ctx.accounts.register('nick_reader', 'test-password-456', 'reader');
  const invoke = async (tool: string, args: any, actor = 'owner') => {
    next = toolCall('nickname', tool, args);
    return runPersonalAgent(ctx, actor, '修改我的社区昵称', []);
  };
  await invoke('account.profile', {});
  assert.deepEqual(Object.keys(receipt.result).sort(), ['kind', 'nickname', 'username']);
  const changed = await invoke('account.nickname', { nickname: '徐汇散步者', expectedNickname: 'nick_owner' });
  assert.deepEqual(changed.refresh, ['profile']);
  assert.equal(ctx.accounts.nicknameOf('owner'), '徐汇散步者');
  assert.equal(ctx.accounts.nicknameOf('reader'), 'nick_reader');
  assert.equal((await invoke('account.nickname', { nickname: '覆盖', expectedNickname: 'nick_owner' })).steps[0].ok, false);
  assert.equal((await invoke('account.nickname', { nickname: '匿名修改', expectedNickname: '' }, 'guest')).steps[0].ok, false);
  assert.equal((await invoke('account.nickname', { nickname: '越权', expectedNickname: '徐汇散步者', actorId: 'reader' })).steps[0].ok, false);
  assert.equal(ctx.accounts.nicknameOf('owner'), '徐汇散步者');
  const restored = createServerContext(options);
  assert.equal(restored.accounts.nicknameOf('owner'), '徐汇散步者');
  assert.equal(restored.accounts.profile('owner').username, 'nick_owner');
});
