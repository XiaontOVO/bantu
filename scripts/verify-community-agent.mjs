// Real configured model, two registered accounts, isolated in-memory community.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { runPersonalAgent } from '../dist/src/services/personal-agent-runtime.js';

const provider = new ModelSettings('data/model-settings.json').provider;
if (!provider) throw new Error('请先配置真实模型。');
let calls = 0;
const ctx = createServerContext({ seedDemo: false, stateStore: new MemoryStateStore(), modelProvider: {
  providerName: provider.providerName, modelName: provider.modelName, async generateTurn(request) {
    const result = await provider.generateTurn(request);
    console.log(JSON.stringify({ turn: ++calls, tools: result.toolCalls.map(c => c.name), errorCode: result.error?.code }));
    return result;
  },
} });
for (const actor of ['author', 'reader']) {
  const password = randomBytes(16).toString('hex');
  ctx.accounts.register(`verify_${actor}`, password, actor);
  assert.equal(ctx.accounts.login(`verify_${actor}`, password), actor);
}
const publish = await runPersonalAgent(ctx, 'author', '帮我发布一个帖子，正文是“徐汇散步验收记：今天走过武康大楼，很开心。”，关联地点武康大楼。请生成正式发布预览，等我确认。', []);
assert.match(publish.reply, /确认发布/);
assert.equal(ctx.communityService.listPosts('author').length, 0);
await runPersonalAgent(ctx, 'author', '确认发布', []);
const post = ctx.communityService.listPosts('author')[0];
assert.ok(post);
assert.equal(post.text, '徐汇散步验收记：今天走过武康大楼，很开心。');
assert.equal(post.placeRefs[0].name, '武康大楼');
const parent = ctx.communityService.addComment('author', post.id, { text: '欢迎讨论出行时间。' }, ctx.accounts.nicknameOf('author')).comments[0];
const reply = await runPersonalAgent(ctx, 'reader', '找到“徐汇散步验收记”这篇帖子，阅读里面的评论。我要回复“欢迎讨论出行时间。”那条评论，回复内容是“傍晚人多吗？”。请准备回复，等我确认后再发布，然后收藏这篇帖子。', []);
assert.match(reply.reply, /确认发布/);
assert.equal(ctx.communityService.postDetail(post.id, 'reader').comments.length, 1);
await runPersonalAgent(ctx, 'reader', '确认发布', []);
const comments = ctx.communityService.postDetail(post.id, 'reader').comments;
assert.equal(comments.length, 2);
assert.equal(comments[1].text, '傍晚人多吗？');
assert.equal(comments[1].parentCommentId, parent.id);
assert.equal(comments[1].mine, true);
assert.equal(ctx.favoritesService.listPosts('reader').length, 1);
assert.equal(ctx.favoritesService.listPosts('author').length, 0);
const withdrawal = await runPersonalAgent(ctx, 'author', '撤回我发布的“徐汇散步验收记”帖子。请先生成撤回确认。', []);
assert.match(withdrawal.reply, /确认撤回/);
assert.ok(ctx.communityService.postDetail(post.id, 'author'));
await runPersonalAgent(ctx, 'author', '确认撤回', []);
assert.equal(ctx.communityService.postDetail(post.id, 'reader'), null);
assert.equal(ctx.favoritesService.listPosts('reader')[0].post.source, 'withdrawn');
const place = await ctx.fallbackPlaceProvider.detail(post.placeRefs[0].placeId);
const scheme = ctx.planLibrary.save('author', { name: '徐汇两日散步', kind: 'scheme', days: [{ dayIndex: 0, stops: [{ stopId: 'visit', placeId: place.placeId, place, startMinutes: 870, endMinutes: 930, status: 'planned' }], routeLegs: [], plannedCharges: [] }, { dayIndex: 1, stops: [], routeLegs: [], plannedCharges: [] }] });
const sharePreview = await runPersonalAgent(ctx, 'author', '把我的完整方案“徐汇两日散步”分享到社区，请先生成分享预览。', []);
assert.match(sharePreview.reply, /确认发布/);
assert.equal(ctx.communityService.listPlanShares('reader').length, 0);
await runPersonalAgent(ctx, 'author', '确认发布', []);
const share = ctx.communityService.listPlanShares('reader')[0];
assert.ok(share);
assert.match(share.shareCode, /^BT-[A-F0-9]{10}$/);
const imported = await runPersonalAgent(ctx, 'reader', `查找方案码 ${share.shareCode}，看一下内容，并完整导入我的方案候选，不要载入日期。`, []);
assert.ok(imported.steps.some(s => s.tool === 'community.import_share' && s.ok));
const readerPlan = ctx.planLibrary.list('reader')[0];
assert.ok(imported.detailLinks?.some(link => link.view === 'plan' && link.planId === readerPlan.id));
assert.equal(readerPlan.days.length, 2);
assert.equal(readerPlan.days[1].stops.length, 0);
assert.equal(readerPlan.days[0].stops[0].startMinutes, 870);
assert.equal(readerPlan.localDate, undefined);
const removeShare = await runPersonalAgent(ctx, 'author', '撤回我分享到社区的“徐汇两日散步”，保留我自己的方案。', []);
assert.match(removeShare.reply, /确认撤回/);
await runPersonalAgent(ctx, 'author', '确认撤回', []);
assert.equal(ctx.communityService.listPlanShares('reader').length, 0);
assert.ok(ctx.planLibrary.get('author', scheme.id));
assert.ok(ctx.planLibrary.get('reader', readerPlan.id));
const memory = ctx.personalMemoriesService.createJourney('author', {
  plan: { id: 'verified-walk', localDate: '2026-09-22' },
  places: [{ stopId: 'walk-stop', placeId: place.placeId, name: place.name, visitMinutes: 60 }],
  firstEventAt: null, completedAt: null, elapsedMinutes: 75, generatedBy: 'manual',
});
assert.ok(memory.ok);
ctx.personalMemoriesService.patch('author', memory.value.memoryId, { title: '徐汇午后足迹' });
const memoryPreview = await runPersonalAgent(ctx, 'author', '把我的旅行记忆“徐汇午后足迹”作为路线卡附到新帖子里，正文写“留下今天的足迹。”，先给我发布预览。', []);
assert.match(memoryPreview.reply, /确认发布/);
assert.match(memoryPreview.reply, /武康大楼/);
await runPersonalAgent(ctx, 'author', '确认发布', []);
const memoryPost = ctx.communityService.listPosts('reader').find(p => p.text === '留下今天的足迹。');
assert.ok(memoryPost?.journeyMemory);
assert.equal(memoryPost.journeyMemory.places[0].name, place.name);
assert.equal(memoryPost.journeyMemory.elapsedMinutes, 75);
console.log(JSON.stringify({ journeyAttachmentVerified: true, calls }));
const image = { dataUrl: `data:image/jpeg;base64,${readFileSync('public/images/places/wukang-2.jpg').toString('base64')}`, alt: '武康大楼照片.jpg' };
await runPersonalAgent(ctx, 'author', '先保留上传的这张照片，暂时不要发布，我下一条消息再给正文。', [], [image]);
const photoPreview = await runPersonalAgent(ctx, 'author', '用刚才上传的照片发一篇帖子，正文是“散步时拍下的一角。”。先准备发布预览。', []);
assert.match(photoPreview.reply, /照片（1 张）/);
await runPersonalAgent(ctx, 'author', '确认发布', []);
const photoPost = ctx.communityService.listPosts('reader').find(p => p.text === '散步时拍下的一角。');
assert.equal(photoPost?.images.length, 1);
assert.equal(photoPost.images[0].alt, image.alt);
console.log(JSON.stringify({ photoAttachmentVerified: true, calls }));
const cleared = await runPersonalAgent(ctx, 'author', '忘掉我在聊天里上传的照片，保留已发布的帖子。', []);
assert.ok(cleared.steps.some(s => s.tool === 'attachments.clear' && s.ok));
const nextTask = ctx.personalAgentTasks.start('author', []);
assert.equal(nextTask.images.length, 0);
nextTask.status = 'completed';
assert.equal(ctx.communityService.postDetail(photoPost.id, 'reader').images.length, 1);
console.log(JSON.stringify({ verified: true, model: provider.modelName, calls, scenarios: ['publish-with-place', 'reply-to-comment', 'favorite-after-confirmation', 'withdraw-own-post', 'share-whole-scheme', 'import-by-short-code', 'withdraw-share-without-deleting-copies'] }));
