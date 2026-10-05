import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { modelTurn, toolCall } from '../src/providers/model.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { communityAgentTools } from '../src/services/personal-agent-community.js';
import { confirmCommunityActionWithDirectory, type PendingCommunityAction } from '../src/services/personal-agent-community-actions.js';

const recommendation = { name: '测试散步花园', cityCode: '310100', address: '测试公开步道入口', description: '适合慢慢散步。' };

test('agent discovery is confirmed after restart, private until approved, and withdrawable only by author', async () => {
  const store = new MemoryStateStore();
  const options = { seedDemo: false, stateStore: store, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(request: any) {
      if (request.messages.some((m: any) => m.role === 'tool' && JSON.parse(m.content).result?.completed)) return modelTurn([], '推荐已保存，尚未收录。');
      return modelTurn([toolCall('recommend', 'community.discovery_publish', recommendation)]);
    },
  } };
  const ctx = createServerContext(options);
  ctx.accounts.register('discovery_author', 'test-password-123', 'author');
  ctx.accounts.register('discovery_reader', 'test-password-456', 'reader');
  const preview = await runPersonalAgent(ctx, 'author', '帮我保存地点推荐', []);
  assert.match(preview.reply, /测试散步花园/);
  assert.match(preview.reply, /仅自己可见/);
  assert.equal(ctx.communityService.ownDiscoveries('author').length, 0);
  const restored = createServerContext(options);
  await runPersonalAgent(restored, 'author', '确认发布', []);
  const [item] = restored.communityService.ownDiscoveries('author');
  assert.equal(item.status, 'shared');
  assert.equal(item.lat, null);
  assert.equal(restored.communityService.list('reader').length, 0);
  assert.equal(restored.communityService.approvedPlaces().some(p => p.name === recommendation.name), false);
  const reader = communityAgentTools(restored, 'reader', new Set());
  const own = await reader.find(t => t.name === 'community.discoveries')!.run({ mine: true }) as any;
  assert.equal(own.total, 0);
  assert.throws(() => reader.find(t => t.name === 'community.discovery_detail')!.run({ discoveryId: item.id }), /不可查看/);
  assert.throws(() => reader.find(t => t.name === 'community.discovery_withdraw')!.run({ discoveryId: item.id }), /自己的/);
  let approval!: PendingCommunityAction;
  const author = communityAgentTools(restored, 'author', new Set(), value => { approval = value; });
  const detail = await author.find(t => t.name === 'community.discovery_detail')!.run({ discoveryId: item.id });
  assert.equal(JSON.stringify(detail).includes('authorId'), false);
  await author.find(t => t.name === 'community.discovery_withdraw')!.run({ discoveryId: item.id });
  assert.match(approval.prompt, /确认撤回/);
  assert.equal(restored.communityService.has(item.id), true);
  await confirmCommunityActionWithDirectory(restored, 'author', approval);
  assert.equal(restored.communityService.has(item.id), false);
});

test('recommendation validates without writes, rechecks duplicate and identity, and does not invent coordinates', async () => {
  const ctx = createServerContext({ seedDemo: false });
  ctx.accounts.register('discovery_owner', 'test-password-123', 'owner');
  let approval!: PendingCommunityAction;
  const publish = communityAgentTools(ctx, 'owner', new Set(), value => { approval = value; }).find(t => t.name === 'community.discovery_publish')!;
  assert.throws(() => publish.run({ ...recommendation, lat: 31.2, lng: 121.4 }), /坐标系/);
  assert.throws(() => publish.run({ ...recommendation, lat: 31.2, coordinateCrs: 'WGS84' }), /同时填写/);
  assert.throws(() => publish.run({ ...recommendation, cityCode: '上海' }), /有效的城市/);
  assert.throws(() => publish.run({ ...recommendation, description: '' }), /发现与体验/);
  assert.equal(ctx.communityService.ownDiscoveries('owner').length, 0);
  await publish.run(recommendation);
  await assert.rejects(confirmCommunityActionWithDirectory(ctx, 'other', approval), /其他账号/);
  ctx.accounts.setNickname('owner', '新昵称');
  const stale = await confirmCommunityActionWithDirectory(ctx, 'owner', approval);
  assert.equal(stale.completed, false);
  assert.equal(ctx.communityService.ownDiscoveries('owner').length, 0);
  ctx.communityService.publish('owner', recommendation, '新昵称');
  await assert.rejects(confirmCommunityActionWithDirectory(ctx, 'owner', stale.pending!), /同名/);
  assert.equal(ctx.communityService.ownDiscoveries('owner').length, 1);
});

test('agent submission requires coordinates and evidence, waits for approval, and never approves itself', async () => {
  const ctx = createServerContext({ seedDemo: false });
  ctx.accounts.register('submission_owner', 'test-password-123', 'owner');
  ctx.accounts.register('submission_reader', 'test-password-456', 'reader');
  const item = ctx.communityService.publish('owner', recommendation, '发布者');
  let approval!: PendingCommunityAction;
  const submit = communityAgentTools(ctx, 'owner', new Set(), value => { approval = value; }).find(t => t.name === 'community.discovery_submit')!;
  assert.throws(() => submit.run({ discoveryId: item.id, evidence: '公开步道说明' }), /经纬度/);
  const args = { discoveryId: item.id, evidence: '公开步道说明', lat: 31.2, lng: 121.4, coordinateCrs: 'GCJ02' };
  assert.throws(() => submit.run({ ...args, evidence: '' }), /核实依据/);
  const reader = communityAgentTools(ctx, 'reader', new Set()).find(t => t.name === 'community.discovery_submit')!;
  assert.throws(() => reader.run(args), /发布者/);
  await submit.run(args);
  assert.match(approval.prompt, /确认提交/);
  assert.match(approval.prompt, /等待平台审核/);
  assert.equal(ctx.communityService.detail(item.id, 'owner').status, 'shared');
  assert.equal(ctx.communityService.detail(item.id, 'owner').lat, null);
  const completed = await confirmCommunityActionWithDirectory(ctx, 'owner', approval);
  assert.equal(completed.completed, true);
  const pending = ctx.communityService.detail(item.id, 'owner');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.coordinateCrs, 'WGS84');
  assert.notEqual(pending.lat, args.lat);
  assert.equal(pending.evidence, args.evidence);
  assert.equal(ctx.communityService.canView(item.id, 'reader'), false);
  assert.equal(ctx.communityService.approvedPlaces().some(p => p.name === item.name), false);
  await assert.rejects(confirmCommunityActionWithDirectory(ctx, 'owner', approval), /已提交/);
});
