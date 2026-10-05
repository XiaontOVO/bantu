import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { modelTurn, toolCall, type ModelToolCall } from '../src/providers/model.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

test('resuming after an inverse write restores the requested state despite old committed receipts', async () => {
  const store = new MemoryStateStore();
  let round = 0, placeId = '';
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      round++;
      if (round === 1) return modelTurn([toolCall('on', 'favorites.set', { placeId, favorite: true }), toolCall('off', 'favorites.set', { placeId, favorite: false })]);
      if (round === 2) throw new Error('模拟连接中断');
      if (round === 3) return modelTurn([toolCall('on-again', 'favorites.set', { placeId, favorite: true })]);
      return modelTurn([], '已收藏');
    },
  } };
  const ctx = createServerContext(options);
  placeId = (await ctx.options.placeProvider!.search({ cityCode: '310100', query: '武康大楼' })).places[0].placeId;
  await runPersonalAgent(ctx, 'owner', '先收藏、取消，再重新收藏', []);
  assert.equal(ctx.favoritesService.list('owner').length, 0);
  const restored = createServerContext(options);
  await runPersonalAgent(restored, 'owner', '继续', []);
  assert.equal(restored.favoritesService.list('owner').length, 1);
});

test('runtime reapplies final desired state after inverse actions instead of replaying stale receipts', async () => {
  let calls: ModelToolCall[] = [];
  const ctx = createServerContext({ seedDemo: false, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      const next = calls; calls = []; return modelTurn(next, next.length ? undefined : '完成');
    },
  } });
  ctx.accounts.register('state_owner', 'test-password-123', 'owner');
  const post = ctx.communityService.publishPost('owner', { text: '状态切换测试' }, '作者');
  const place = (await ctx.options.placeProvider!.search({ cityCode: '310100', query: '武康大楼' })).places[0];
  for (const [index, value] of [true, false, true, true].entries()) {
    calls.push(toolCall(`fav${index}`, 'favorites.set', { placeId: place.placeId, favorite: value }));
    calls.push(toolCall(`post${index}`, 'community.post_favorite', { postId: post.id, favorite: value }));
    calls.push(toolCall(`like${index}`, 'community.post_like', { postId: post.id, liked: value }));
    calls.push(toolCall(`tag${index}`, 'places.edit_tags', { placeId: place.placeId, action: value ? 'add' : 'remove', tags: ['想再去'] }));
  }
  const reply = await runPersonalAgent(ctx, 'owner', '收藏、取消、重新收藏；点赞与私人标签同样调整，最终全部保留。', []);
  assert.equal(reply.steps.filter(step => step.ok).length, 16);
  assert.equal(ctx.favoritesService.list('owner').filter(item => item.kind === 'place').length, 1);
  assert.equal(ctx.favoritesService.listPosts('owner').length, 1);
  assert.equal(ctx.communityService.postDetail(post.id, 'owner')!.liked, true);
  assert.equal(ctx.communityService.postDetail(post.id, 'owner')!.likes, 1);
  assert.deepEqual(ctx.communityService.myTags(place.placeId, 'owner'), ['想再去']);
});
