// Real configured model, registered accounts, isolated business storage.
import assert from 'node:assert/strict';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { runPersonalAgent } from '../dist/src/services/personal-agent-runtime.js';

const provider = new ModelSettings('data/model-settings.json').provider;
if (!provider) throw new Error('未启用真实模型。');
let calls = 0;
const ctx = createServerContext({ seedDemo: false, stateStore: new MemoryStateStore(), modelProvider: {
  providerName: provider.providerName, modelName: provider.modelName,
  async generateTurn(request) {
    const turn = await provider.generateTurn(request);
    console.log(JSON.stringify({ call: ++calls, tools: turn.toolCalls.map(c => c.name) }));
    return turn;
  },
} });
ctx.accounts.register('review_author', 'test-password-123', 'author');
ctx.accounts.register('review_reader', 'test-password-456', 'reader');
const place = (await ctx.options.placeProvider.search({ cityCode: '310100', query: '武康大楼' })).places[0];
const requested = await runPersonalAgent(ctx, 'author', '给武康大楼评4星，评价原文是“街角建筑很有特色”。请帮我发布。', []);
assert.ok(requested.steps.some(s => s.tool === 'community.place_review' && s.ok));
assert.equal(ctx.communityService.placeUserReviews(place.placeId).length, 0);
await runPersonalAgent(ctx, 'author', '确认发布', []);
assert.equal(ctx.communityService.ownPlaceReview(place.placeId, 'author').rating, 4);
assert.equal(ctx.communityService.ownPlaceReview(place.placeId, 'author').text, '街角建筑很有特色');
const read = await runPersonalAgent(ctx, 'reader', '看看武康大楼的用户评价，也查一下我有没有评价过。只查看。', []);
assert.ok(read.steps.some(s => s.tool === 'community.place_reviews' && s.ok));
assert.equal(ctx.communityService.ownPlaceReview(place.placeId, 'reader'), undefined);
assert.equal(ctx.communityService.placeUserReviews(place.placeId).length, 1);
console.log(JSON.stringify({ verified: true, calls, scenarios: ['review preview', 'confirmed exact rating and text', 'second registered account reads without writing'] }));
