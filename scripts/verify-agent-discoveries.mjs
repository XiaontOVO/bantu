// Real configured model; two registered accounts and isolated business storage.
import assert from 'node:assert/strict';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { runPersonalAgent } from '../dist/src/services/personal-agent-runtime.js';

const provider = new ModelSettings('data/model-settings.json').provider;
if (!provider || provider.providerName === 'scripted') throw new Error('未启用真实模型。');
let calls = 0;
const ctx = createServerContext({ seedDemo: false, stateStore: new MemoryStateStore(), modelProvider: {
  providerName: provider.providerName, modelName: provider.modelName,
  async generateTurn(request) {
    const turn = await provider.generateTurn(request);
    console.log(JSON.stringify({ call: ++calls, tools: turn.toolCalls.map(c => c.name) }));
    return turn;
  },
} });
ctx.accounts.register('discovery_author', 'test-password-123', 'author');
ctx.accounts.register('discovery_reader', 'test-password-456', 'reader');
const consultation = await runPersonalAgent(ctx, 'author', '帮我推荐上海徐汇适合散步的两个地点，只要建议。', []);
assert.equal(consultation.steps.some(s => s.tool === 'community.discovery_publish'), false);
assert.equal(ctx.communityService.ownDiscoveries('author').length, 0);
assert.equal(ctx.personalAgentTasks.current('author').pendingAction, undefined);
const preview = await runPersonalAgent(ctx, 'author', '我要向平台保存一条新的地点推荐，名称“验收散步花园”，城市上海（310100），地址“验收步道入口”，推荐内容原文“适合慢慢散步”。暂时没有坐标。请帮我保存这条推荐。', []);
assert.ok(preview.steps.some(s => s.tool === 'community.discovery_publish' && s.ok));
assert.equal(ctx.communityService.ownDiscoveries('author').length, 0);
assert.match(preview.reply, /仅自己可见/);
await runPersonalAgent(ctx, 'author', '确认发布', []);
const [item] = ctx.communityService.ownDiscoveries('author');
assert.equal(item.name, '验收散步花园');
assert.equal(item.description, '适合慢慢散步');
assert.equal(item.status, 'shared');
assert.equal(item.lat, null);
assert.equal(ctx.communityService.approvedPlaces().some(p => p.name === item.name), false);
const submit = await runPersonalAgent(ctx, 'author', '给我保存的“验收散步花园”申请收录，核实依据是“公开步道说明”，纬度31.2、经度121.4，坐标系GCJ02。请提交审核。', []);
assert.ok(submit.steps.some(s => s.tool === 'community.discovery_submit' && s.ok));
assert.match(submit.reply, /确认提交/);
assert.equal(ctx.communityService.detail(item.id, 'author').status, 'shared');
await runPersonalAgent(ctx, 'author', '确认提交', []);
assert.equal(ctx.communityService.detail(item.id, 'author').status, 'pending');
assert.equal(ctx.communityService.detail(item.id, 'author').evidence, '公开步道说明');
assert.equal(ctx.communityService.approvedPlaces().some(p => p.name === item.name), false);
const read = await runPersonalAgent(ctx, 'reader', `查看地点推荐 ${item.id} 的详情。`, []);
assert.ok(read.steps.some(s => s.tool === 'community.discovery_detail' && !s.ok));
assert.equal(read.reply.includes(item.description), false);
const withdrawal = await runPersonalAgent(ctx, 'author', '撤回我保存的“验收散步花园”地点推荐。', []);
assert.ok(withdrawal.steps.some(s => s.tool === 'community.discovery_withdraw' && s.ok));
assert.equal(ctx.communityService.has(item.id), true);
await runPersonalAgent(ctx, 'author', '确认撤回', []);
assert.equal(ctx.communityService.has(item.id), false);
console.log(JSON.stringify({ verified: true, calls, scenarios: ['consultation without publication', 'preview and explicit save', 'confirmed submission waits for platform review', 'unapproved recommendation stays out of directory', 'second account cannot read private recommendation', 'lookup and confirmed withdrawal'] }));
