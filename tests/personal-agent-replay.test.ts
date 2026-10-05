import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { modelTurn } from '../src/providers/model.js';
import { replayAgentWrite } from '../src/services/personal-agent-replay.js';

for (const deleted of [false, true]) test(`resumed repeated creation reads current state without recreating a ${deleted ? 'deleted' : 'renamed'} scheme`, async () => {
  const store = new MemoryStateStore();
  let round = 0;
  const args = { name: '原方案', kind: 'scheme', days: [{ stops: [] }] };
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request: any) {
      round++;
      if (round === 1 || round === 3) return modelTurn([{ callId: `create-${round}`, name: 'plans.create', arguments: args }]);
      if (round === 2) {
        const plan = ctx.planLibrary.list('owner')[0];
        if (deleted) ctx.planLibrary.remove('owner', plan.id);
        else ctx.planLibrary.update('owner', plan.id, { name: '用户重新命名', days: plan.days });
        throw new Error('connection interrupted');
      }
      const receipt = JSON.parse(request.messages.at(-1).content);
      assert.equal(receipt.replayed, true);
      assert.equal(receipt.ok, !deleted);
      if (deleted) assert.match(receipt.error, /已不存在/);
      else assert.equal(receipt.result.name, '用户重新命名');
      return modelTurn([], '已核对当前状态。');
    },
  } };
  const ctx = createServerContext(options);
  const first = await runPersonalAgent(ctx, 'owner', '创建方案', []);
  assert.match(first.reply, /中断/);
  assert.doesNotMatch(first.reply, /已保存：「原方案」/);
  const restored = createServerContext(options);
  const before = restored.planLibrary.serialize();
  await runPersonalAgent(restored, 'owner', '继续', []);
  assert.equal(round, 4);
  assert.equal(restored.planLibrary.serialize(), before);
  assert.equal(restored.planLibrary.list('owner').length, deleted ? 0 : 1);
});

test('memory write replay returns updated notes and does not resurrect deleted or foreign notes', () => {
  const ctx = createServerContext({ seedDemo: false });
  const saved = ctx.personalMemoriesService.create('owner', { userText: '旧正文' });
  assert.ok(saved.ok);
  const cached = { ok: true, result: structuredClone(saved.value) };
  ctx.personalMemoriesService.patch('owner', saved.value.memoryId, { content: '最新正文' });
  const replay = replayAgentWrite(ctx, 'owner', 'memories.create', cached) as any;
  assert.equal(replay.result.content, '最新正文');
  assert.equal(replay.replayed, true);
  assert.equal((replayAgentWrite(ctx, 'other', 'memories.create', cached) as any).ok, false);
  ctx.personalMemoriesService.delete('owner', saved.value.memoryId);
  assert.equal((replayAgentWrite(ctx, 'owner', 'memories.create', cached) as any).ok, false);
  assert.equal(ctx.personalMemoriesService.list('owner').length, 0);
});

test('community write replay resolves current posts, comments and recommendation status without republishing', () => {
  const ctx = createServerContext({ seedDemo: false });
  ctx.accounts.register('replay_author', 'test-password-123', 'owner');
  ctx.accounts.register('replay_reader', 'test-password-456', 'reader');
  const wrap = (result: unknown) => ({ ok: true, result: { completed: true, result: structuredClone(result), reply: '旧的成功说明', refresh: ['community'] } });
  const post = ctx.communityService.publishPost('owner', { text: '旅行记录' }, '作者');
  const receipt = wrap(post);
  ctx.communityService.addComment('reader', post.id, { text: '后来添加的评论' }, '读者');
  let replay = replayAgentWrite(ctx, 'owner', 'community.post_publish', receipt) as any;
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.result.comments.length, 1);
  assert.doesNotMatch(replay.result.reply, /旧的成功说明/);
  assert.equal((replayAgentWrite(ctx, 'reader', 'community.post_publish', receipt) as any).ok, false);
  const withReply = ctx.communityService.addComment('owner', post.id, { text: '感谢' }, '作者');
  const replyReceipt = wrap(withReply);
  ctx.communityService.removeComment('owner', post.id, withReply.comments.find(c => c.mine)!.id);
  replay = replayAgentWrite(ctx, 'owner', 'community.post_reply', replyReceipt) as any;
  assert.equal(replay.result.result.comments.some((c: any) => c.text === '感谢'), false);
  ctx.communityService.removePost('owner', post.id);
  assert.equal((replayAgentWrite(ctx, 'owner', 'community.post_publish', receipt) as any).ok, false);
  assert.equal(ctx.communityService.listPosts('owner').length, 0);

  const discovery = ctx.communityService.publish('owner', { name: '验收步道', cityCode: '310100', address: '公开入口', description: '散步', lat: 31.2, lng: 121.4 }, '作者');
  const discoveryReceipt = wrap(discovery);
  ctx.communityService.submit(discovery.id, 'owner', { evidence: '公开介绍' });
  replay = replayAgentWrite(ctx, 'owner', 'community.discovery_publish', discoveryReceipt) as any;
  assert.equal(replay.result.result.status, 'pending');
  assert.equal((replayAgentWrite(ctx, 'reader', 'community.discovery_publish', discoveryReceipt) as any).ok, false);
  ctx.communityService.remove(discovery.id, 'owner');
  assert.equal((replayAgentWrite(ctx, 'owner', 'community.discovery_publish', discoveryReceipt) as any).ok, false);
  assert.equal(ctx.communityService.ownDiscoveries('owner').length, 0);
});

test('imported scheme and own review replay expose latest data instead of saved snapshot', () => {
  const ctx = createServerContext({ seedDemo: false });
  const plan = ctx.planLibrary.save('owner', { name: '导入的方案', kind: 'scheme', days: [{ stops: [], routeLegs: [], plannedCharges: [] }] }, 'imported');
  const receipt = { ok: true, result: structuredClone(plan) };
  ctx.planLibrary.update('owner', plan.id, { name: '我修改后的名称', days: plan.days });
  assert.equal((replayAgentWrite(ctx, 'owner', 'community.import_share', receipt) as any).result.name, '我修改后的名称');
  assert.equal((replayAgentWrite(ctx, 'reader', 'community.import_share', receipt) as any).ok, false);
  ctx.planLibrary.remove('owner', plan.id);
  assert.equal((replayAgentWrite(ctx, 'owner', 'community.import_share', receipt) as any).ok, false);
  const oldReview = ctx.communityService.reviewPlace('place', 'owner', { rating: 3, text: '以前的评价' }, '作者');
  const reviewReceipt = { ok: true, result: { completed: true, result: oldReview, reply: '已发布' } };
  ctx.communityService.reviewPlace('place', 'owner', { rating: 4, text: '补充后的评价' }, '作者');
  const replay = replayAgentWrite(ctx, 'owner', 'community.place_review', reviewReceipt, { placeId: 'place' }) as any;
  assert.equal(replay.result.result.rating, 4);
  assert.equal(replay.result.result.text, '补充后的评价');
  assert.equal(JSON.stringify(replay).includes('actorId'), false);
  assert.equal((replayAgentWrite(ctx, 'reader', 'community.place_review', reviewReceipt, { placeId: 'place' }) as any).ok, false);
});

test('confirmed post interrupted after withdrawal is not resurrected when resumed after restart', async () => {
  const store = new MemoryStateStore();
  let round = 0;
  const args = { text: '后来撤回的帖子' };
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request: any) {
      round++;
      if (round === 1 || round === 3) return modelTurn([{ callId: `publish-${round}`, name: 'community.post_publish', arguments: args }]);
      if (round === 2) {
        const post = ctx.communityService.listPosts('owner')[0];
        ctx.communityService.removePost('owner', post.id);
        throw new Error('connection interrupted');
      }
      const replay = JSON.parse(request.messages.at(-1).content);
      assert.equal(replay.replayed, true);
      assert.equal(replay.ok, false);
      assert.match(replay.error, /已不存在/);
      return modelTurn([], '帖子已撤回，没有重复发布。');
    },
  } };
  const ctx = createServerContext(options);
  ctx.accounts.register('replay_resume', 'test-password-123', 'owner');
  await runPersonalAgent(ctx, 'owner', '发布帖子', []);
  assert.equal(ctx.communityService.listPosts('owner').length, 0);
  await runPersonalAgent(ctx, 'owner', '确认发布', []);
  const restored = createServerContext(options);
  const before = restored.communityService.serialize();
  const continued = await runPersonalAgent(restored, 'owner', '继续', []);
  assert.equal(round, 4);
  assert.match(continued.reply, /已撤回/);
  assert.equal(restored.communityService.serialize(), before);
  assert.equal(restored.communityService.listPosts('owner').length, 0);
});
