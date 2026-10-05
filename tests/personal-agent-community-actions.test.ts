import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { modelTurn, toolCall, type ModelToolCall } from '../src/providers/model.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { prepareCommunityAction, confirmCommunityAction } from '../src/services/personal-agent-community-actions.js';
import { prepareAgentPlanShare } from '../src/services/personal-agent-share.js';
import { communityAgentTools } from '../src/services/personal-agent-community.js';

test('photo clarification continues after restart without another upload and never crosses accounts', async () => {
  const images = [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', alt: '旧照片.png' }];
  const store = new MemoryStateStore();
  let phase = 'upload';
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request: any) {
      const messages = JSON.stringify(request.messages);
      assert.doesNotMatch(messages, /iVBOR/);
      if (phase === 'upload') { assert.match(messages, /旧照片.png/); return modelTurn([], '想写什么正文？'); }
      if (phase === 'other') { assert.doesNotMatch(messages, /旧照片.png/); return modelTurn([], '请先选择照片。'); }
      if (phase === 'clear') { phase = 'done'; return modelTurn([toolCall('clear', 'attachments.clear', {})]); }
      if (phase === 'reply') {
        assert.match(messages, /此前上传、当前仍可使用/);
        assert.match(messages, /旧照片.png/);
        phase = 'done';
        return modelTurn([toolCall('publish', 'community.post_publish', { text: '下午散步', imageIndexes: [1] })]);
      }
      return modelTurn([], '已完成');
    },
  } };
  const ctx = createServerContext(options);
  ctx.accounts.register('clarify_author', 'test-password-123', 'author');
  await runPersonalAgent(ctx, 'author', '想用照片发帖', [], images);
  const restored = createServerContext(options);
  phase = 'other';
  await runPersonalAgent(restored, 'other', '用刚才的照片', []);
  phase = 'reply';
  const pending = await runPersonalAgent(restored, 'author', '正文写“下午散步”，用刚才的照片', []);
  assert.match(pending.reply, /旧照片.png/);
  await runPersonalAgent(restored, 'author', '确认发布', []);
  assert.equal(restored.communityService.listPosts('author')[0].images[0].alt, '旧照片.png');
  phase = 'clear';
  await runPersonalAgent(restored, 'author', '忘掉上传的照片', []);
  const cleared = createServerContext(options);
  phase = 'other';
  await runPersonalAgent(cleared, 'author', '现在还有哪些照片？', []);
  assert.equal(cleared.communityService.listPosts('author')[0].images.length, 1);
});

test('uploaded photos stay out of model context and survive confirmation restart', async () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const store = new MemoryStateStore();
  let called = false;
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request: any) {
      assert.doesNotMatch(JSON.stringify(request), /iVBORw0KGgo/);
      if (!called) {
        called = true;
        assert.match(JSON.stringify(request.messages), /午后.png/);
        return modelTurn([toolCall('photo', 'community.post_publish', { text: '散步照片', imageIndexes: [1] })]);
      }
      return modelTurn([], '已发布');
    },
  } };
  const ctx = createServerContext(options);
  ctx.accounts.register('photo_author', 'test-password-123', 'author');
  const preview = await runPersonalAgent(ctx, 'author', '用这张照片发帖，正文“散步照片”', [], [{ dataUrl, alt: '午后.png' }]);
  assert.match(preview.reply, /照片（1 张）/);
  assert.equal(ctx.communityService.listPosts('author').length, 0);
  const restored = createServerContext(options);
  await runPersonalAgent(restored, 'author', '确认发布', []);
  const posts = restored.communityService.listPosts('author');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].images.length, 1);
  assert.equal(posts[0].images[0].alt, '午后.png');
  const tools = communityAgentTools(restored, 'author', new Set());
  await assert.rejects(tools.find(t => t.name === 'community.post_publish')!.run({ text: '无附件', imageIndexes: [1] }) as Promise<unknown>, /照片编号无效/);
});

test('agent attaches owned journey memory, requires a new preview after edits, and blocks deleted or foreign memories', async () => {
  const ctx = createServerContext({ seedDemo: false });
  ctx.accounts.register('memory_author', 'test-password-123', 'author');
  ctx.accounts.register('memory_reader', 'test-password-456', 'reader');
  const created = ctx.personalMemoriesService.createJourney('author', {
    plan: { id: 'walk', localDate: '2026-09-22' },
    places: [{ stopId: 'one', name: '武康大楼', visitMinutes: 60 }, { stopId: 'two', name: '徐家汇书院', visitMinutes: 30 }],
    firstEventAt: null, completedAt: null, elapsedMinutes: 110, generatedBy: 'manual',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const memoryId = created.value.memoryId;
  let approval: ReturnType<typeof prepareCommunityAction> | undefined;
  const tools = communityAgentTools(ctx, 'author', new Set(), pending => { approval = pending; });
  await tools.find(t => t.name === 'community.post_publish')!.run({ text: '今天走过的地方。', memoryId });
  assert.match(approval!.prompt, /武康大楼（60 分钟） → 徐家汇书院（30 分钟）/);
  assert.equal(ctx.communityService.listPosts('reader').length, 0);
  assert.throws(() => prepareCommunityAction(ctx, 'reader', 'post_publish', { text: '不能借用别人的记忆' }, memoryId), /找不到/);
  ctx.personalMemoriesService.patch('author', memoryId, { title: '徐汇散步' });
  const stale = confirmCommunityAction(ctx, 'author', approval!);
  assert.equal(stale.completed, false);
  assert.match(stale.pending!.prompt, /徐汇散步/);
  assert.equal(ctx.communityService.listPosts('reader').length, 0);
  const restored = JSON.parse(JSON.stringify(stale.pending));
  assert.equal(confirmCommunityAction(ctx, 'author', restored).completed, true);
  const post = ctx.communityService.listPosts('reader')[0];
  assert.equal(post.journeyMemory?.places.length, 2);
  assert.equal(post.journeyMemory?.elapsedMinutes, 110);
  assert.equal(post.journeyMemory?.currentCity, '');
  const pending = prepareCommunityAction(ctx, 'author', 'post_publish', { text: '再次分享' }, memoryId);
  ctx.personalMemoriesService.delete('author', memoryId);
  assert.throws(() => confirmCommunityAction(ctx, 'author', pending), /找不到/);
  assert.equal(ctx.communityService.listPosts('reader').length, 1);
});

test('whole scheme sharing resolves catalog metadata, preserves blank days and times, and can be withdrawn', async () => {
  const ctx = createServerContext({ seedDemo: false });
  ctx.accounts.register('share_author', 'test-password-123', 'author');
  ctx.accounts.register('share_reader', 'test-password-456', 'reader');
  const place = (await ctx.fallbackPlaceProvider.search({ cityCode: '310100', query: '武康大楼', limit: 5 })).places[0];
  const days = [{ dayIndex: 0, stops: [{ stopId: 'visit', placeId: place.placeId, place: { placeId: place.placeId, name: '过时地点名称', cityCode: '330100' }, status: 'planned', startMinutes: 870, endMinutes: 930 }], routeLegs: [], plannedCharges: [] }, { dayIndex: 1, stops: [], routeLegs: [], plannedCharges: [] }];
  const plan = ctx.planLibrary.save('author', { name: '两天徐汇', kind: 'scheme', days });
  const approval = await prepareAgentPlanShare(ctx, 'author', plan.id);
  assert.match(approval.prompt, /武康大楼/);
  assert.doesNotMatch(approval.prompt, /过时地点名称/);
  assert.equal(ctx.communityService.listPlanShares('reader').length, 0);
  assert.equal(confirmCommunityAction(ctx, 'author', approval).completed, true);
  const share = ctx.communityService.listPlanShares('reader')[0];
  assert.equal(share.cityCode, place.cityCode);
  assert.match(share.shareCode, /^BT-[A-F0-9]{10}$/);
  const tools = communityAgentTools(ctx, 'reader', new Set());
  const imported = await tools.find(t => t.name === 'community.import_share')!.run({ shareId: share.shareCode }) as any;
  assert.equal(imported.days.length, 2);
  assert.equal(imported.days[1].stops.length, 0);
  assert.equal(imported.days[0].stops[0].startMinutes, 870);
  assert.equal(imported.days[0].stops[0].endMinutes, 930);
  assert.throws(() => prepareCommunityAction(ctx, 'reader', 'share_withdraw', { shareId: share.id }), /自己/);
  confirmCommunityAction(ctx, 'author', prepareCommunityAction(ctx, 'author', 'share_withdraw', { shareId: share.id }));
  assert.equal(ctx.communityService.listPlanShares('reader').length, 0);
  assert.equal(ctx.planLibrary.list('reader').length, 1);
  const stale = await prepareAgentPlanShare(ctx, 'author', plan.id);
  ctx.planLibrary.update('author', plan.id, { name: '改名后的方案', days });
  assert.throws(() => confirmCommunityAction(ctx, 'author', stale), /已有更新/);
  assert.equal(ctx.communityService.listPlanShares('reader').length, 0);
});

test('publishing uses frozen preview after restart and nickname changes require renewed confirmation', async () => {
  const store = new MemoryStateStore();
  let next: ModelToolCall | undefined = toolCall('publish', 'community.post_publish', { text: '今天在徐汇散步。' });
  const options = { seedDemo: false, stateStore: store, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn() {
    if (next) { const call = next; next = undefined; return modelTurn([call]); }
    return modelTurn([], '已完成。');
  } } };
  const ctx = createServerContext(options);
  ctx.accounts.register('author_test', 'test-password-123', 'author');
  const pending = await runPersonalAgent(ctx, 'author', '发布帖子：今天在徐汇散步。', []);
  assert.match(pending.reply, /今天在徐汇散步/);
  assert.match(pending.reply, /确认发布/);
  assert.equal(ctx.communityService.listPosts('author').length, 0);
  const restored = createServerContext(options);
  restored.accounts.setNickname('author', '新的昵称');
  const stale = await runPersonalAgent(restored, 'author', '确认发布', []);
  assert.match(stale.reply, /内容已变化/);
  assert.equal(restored.communityService.listPosts('author').length, 0);
  const result = await runPersonalAgent(restored, 'author', '确认发布', []);
  assert.match(result.reply, /帖子已发布/);
  const posts = restored.communityService.listPosts('author');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].nickname, '新的昵称');
  assert.equal(posts[0].text, '今天在徐汇散步。');
  assert.equal(restored.personalAgentTasks.pendingAction('author'), undefined);
});

test('two accounts can reply to a floor; withdrawal and deletion preserve ownership and other replies', () => {
  const ctx = createServerContext({ seedDemo: false });
  ctx.accounts.register('author_test', 'test-password-123', 'author');
  ctx.accounts.register('reader_test', 'test-password-456', 'reader');
  const post = ctx.communityService.publishPost('author', { text: '散步记录' }, '作者');
  const parent = ctx.communityService.addComment('author', post.id, { text: '欢迎讨论' }, '作者').comments[0];
  const reply = prepareCommunityAction(ctx, 'reader', 'post_reply', { postId: post.id, parentCommentId: parent.id, text: '这里适合傍晚去吗？' });
  assert.throws(() => confirmCommunityAction(ctx, 'author', reply), /其他账号/);
  const published = confirmCommunityAction(ctx, 'reader', reply);
  assert.equal(published.completed, true);
  const comments = ctx.communityService.postDetail(post.id, 'reader')!.comments;
  assert.equal(comments[1].parentCommentId, parent.id);
  assert.equal(comments[1].mine, true);
  assert.throws(() => prepareCommunityAction(ctx, 'reader', 'post_withdraw', { postId: post.id }), /自己/);
  assert.throws(() => prepareCommunityAction(ctx, 'reader', 'comment_delete', { postId: post.id, commentId: parent.id }), /自己/);
  confirmCommunityAction(ctx, 'author', prepareCommunityAction(ctx, 'author', 'comment_delete', { postId: post.id, commentId: parent.id }));
  assert.equal(ctx.communityService.postDetail(post.id, 'reader')!.comments.length, 2);
  assert.equal(ctx.communityService.postDetail(post.id, 'reader')!.comments[0].deleted, true);
  const snapshot = ctx.communityService.postSnapshot(post.id)!;
  ctx.favoritesService.addPost('reader', snapshot);
  confirmCommunityAction(ctx, 'author', prepareCommunityAction(ctx, 'author', 'post_withdraw', { postId: post.id }));
  assert.equal(ctx.communityService.postDetail(post.id, 'reader'), null);
  assert.equal(ctx.favoritesService.listPosts('reader')[0].post.source, 'withdrawn');
});
