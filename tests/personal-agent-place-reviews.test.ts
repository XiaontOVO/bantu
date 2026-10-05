import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { communityAgentTools } from '../src/services/personal-agent-community.js';
import { confirmCommunityActionWithDirectory, type PendingCommunityAction } from '../src/services/personal-agent-community-actions.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { modelTurn, toolCall } from '../src/providers/model.js';

test('agent review waits for confirmation, survives restart and keeps each registered author review', async () => {
  const store = new MemoryStateStore();
  let placeId = '';
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request: any) {
      if (request.messages.some((m: any) => m.role === 'tool' && JSON.parse(m.content).result?.completed)) return modelTurn([], '评价已发布。');
      return modelTurn([toolCall('review', 'community.place_review', { placeId, rating: 4, text: '建筑很有特色。' })]);
    },
  } };
  const ctx = createServerContext(options);
  ctx.accounts.register('review_author', 'test-password-123', 'author');
  ctx.accounts.register('review_reader', 'test-password-456', 'reader');
  placeId = (await ctx.options.placeProvider!.search({ cityCode: '310100', query: '武康大楼' })).places[0].placeId;
  const preview = await runPersonalAgent(ctx, 'author', '给武康大楼4星，评价：建筑很有特色。', []);
  assert.match(preview.reply, /武康大楼.*4 星/);
  assert.equal(ctx.communityService.placeUserReviews(placeId).length, 0);
  const restored = createServerContext(options);
  const result = await runPersonalAgent(restored, 'author', '确认发布', []);
  assert.ok(result.refresh.includes('places'));
  assert.equal(restored.communityService.ownPlaceReview(placeId, 'author')?.rating, 4);
  assert.equal(restored.communityService.ownPlaceReview(placeId, 'reader'), undefined);
  let approval: PendingCommunityAction | undefined;
  const tools = communityAgentTools(restored, 'reader', new Set(), value => { approval = value; });
  const read = await tools.find(t => t.name === 'community.place_reviews')!.run({ placeId }) as any;
  assert.equal(read.total, 1);
  assert.equal(read.ownReview, undefined);
  assert.equal(JSON.stringify(read).includes('actorId'), false);
  await tools.find(t => t.name === 'community.place_review')!.run({ placeId, rating: 5, text: '喜欢街角的景色。' });
  await assert.rejects(confirmCommunityActionWithDirectory(restored, 'author', approval!), /其他账号/);
  await confirmCommunityActionWithDirectory(restored, 'reader', approval!);
  assert.equal(restored.communityService.placeUserReviews(placeId).length, 2);
  assert.equal(restored.communityService.ownPlaceReview(placeId, 'author')?.rating, 4);
});

test('review confirmation rechecks directory and changed personal review', async () => {
  const ctx = createServerContext({ seedDemo: false });
  ctx.accounts.register('review_owner', 'test-password-123', 'owner');
  const placeId = (await ctx.options.placeProvider!.search({ cityCode: '310100', query: '武康大楼' })).places[0].placeId;
  let approval: PendingCommunityAction | undefined;
  const tool = communityAgentTools(ctx, 'owner', new Set(), p => { approval = p; }).find(t => t.name === 'community.place_review')!;
  await assert.rejects(tool.run({ placeId: 'missing', rating: 5, text: '好看' }) as Promise<unknown>, /不存在/);
  await tool.run({ placeId, rating: 4, text: '这次的评价' });
  ctx.communityService.reviewPlace(placeId, 'owner', { rating: 3, text: '另一个页面刚提交的评价' }, ctx.accounts.nicknameOf('owner'));
  const stale = await confirmCommunityActionWithDirectory(ctx, 'owner', approval!);
  assert.equal(stale.completed, false);
  assert.equal(ctx.communityService.ownPlaceReview(placeId, 'owner')?.rating, 3);
  await confirmCommunityActionWithDirectory(ctx, 'owner', stale.pending!);
  assert.equal(ctx.communityService.placeUserReviews(placeId).length, 1);
  assert.equal(ctx.communityService.ownPlaceReview(placeId, 'owner')?.rating, 4);
  await tool.run({ placeId, rating: 5, text: '不要发布' });
  ctx.options.placeProvider!.detail = async () => null;
  await assert.rejects(confirmCommunityActionWithDirectory(ctx, 'owner', approval!), /不存在/);
  assert.equal(ctx.communityService.ownPlaceReview(placeId, 'owner')?.rating, 4);
});

test('review confirmation cannot be duplicated and cancellation during directory lookup prevents publishing', async () => {
  let placeId = '';
  const ctx = createServerContext({ seedDemo: false, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      return modelTurn([toolCall('review', 'community.place_review', { placeId, rating: 4, text: '不应发布' })]);
    },
  } });
  ctx.accounts.register('review_cancel', 'test-password-123', 'owner');
  placeId = (await ctx.options.placeProvider!.search({ cityCode: '310100', query: '武康大楼' })).places[0].placeId;
  await runPersonalAgent(ctx, 'owner', '评价武康大楼4星', []);
  const directory = ctx.options.placeProvider!;
  const original = directory.detail.bind(directory);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  directory.detail = async id => { await gate; return original(id); };
  const confirming = runPersonalAgent(ctx, 'owner', '确认发布', []);
  const duplicate = await runPersonalAgent(ctx, 'owner', '确认发布', []);
  assert.match(duplicate.reply, /仍在处理/);
  const task = ctx.personalAgentTasks.current('owner')!;
  ctx.personalAgentTasks.cancel('owner', task.id);
  release();
  const stopped = await confirming;
  assert.match(stopped.reply, /停止/);
  assert.equal(ctx.communityService.placeUserReviews(placeId).length, 0);
});
