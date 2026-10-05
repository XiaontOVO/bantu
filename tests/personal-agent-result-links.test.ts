import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentResultLinks, agentPostResultLinks, agentPersonalResultLinks } from '../src/services/personal-agent-result-links.js';
import { createServerContext } from '../src/server/http/bootstrap.js';
import type { ModelMessage } from '../src/providers/model.js';

test('dated plan and completion links return to the owned plan and its private journey',()=>{
  const ctx=createServerContext({seedDemo:false,now:()=> '2026-10-01T05:00:00Z'});
  const plan=ctx.planLibrary.save('owner',{name:'半日慢行',kind:'plan',localDate:'2026-10-01',snapshot:{stops:[],routeLegs:[],plannedCharges:[]}});
  const journey=ctx.personalMemoriesService.createJourney('owner',{plan,places:[{stopId:'first-visit',placeId:'known',name:'武康大楼',visitMinutes:45,arrivedAt:null,completedAt:null,transferMode:null,transferMinutes:null}],generatedBy:'manual',firstEventAt:null,completedAt:null,elapsedMinutes:null});
  assert.ok(journey.ok);
  const messages:ModelMessage[]=[{role:'tool',toolName:'progress.record',content:JSON.stringify({ok:true,result:plan})}];
  const links=agentPersonalResultLinks(ctx,'owner',messages);
  assert.deepEqual(links,[{view:'home',label:'回到首页随行',planId:plan.id,date:'2026-10-01'},{view:'memories',label:'查看这次旅行记录',memoryId:journey.value.memoryId}]);
  assert.deepEqual(agentPersonalResultLinks(ctx,'other',messages),[]);
  assert.deepEqual(agentPersonalResultLinks(ctx,'owner',[{...messages[0],content:JSON.stringify({ok:false,result:plan})}]),[]);
});

test('personal result links locate saved schemes and notes only within the current identity', () => {
  const ctx = createServerContext({ seedDemo: false });
  const plan = ctx.planLibrary.save('owner', { name: '周末散步', kind: 'scheme', days: [{ dayIndex: 0, stops: [], routeLegs: [], plannedCharges: [] }] });
  const memory = ctx.personalMemoriesService.create('owner', { userText: '今天很开心' });
  assert.ok(memory.ok);
  const receipt = (toolName: string, result: unknown): ModelMessage => ({ role: 'tool', toolName, toolCallId: 'call', content: JSON.stringify({ ok: true, result }) });
  const messages = [receipt('plans.create', plan), receipt('memories.create', memory.value), receipt('plans.edit', plan)];
  const links = agentPersonalResultLinks(ctx, 'owner', messages);
  assert.equal(links.length, 2);
  assert.equal(links[0].planId, plan.id);
  assert.equal(links[1].memoryId, memory.value.memoryId);
  assert.deepEqual(agentPersonalResultLinks(ctx, 'other', messages), []);
  assert.deepEqual(agentPersonalResultLinks(ctx, 'owner', [receipt('plans.list', plan)]), []);
});

test('post result links use committed receipts and exclude previews, missing and withdrawn posts', () => {
  const ctx = createServerContext({ seedDemo: false });
  ctx.accounts.register('link_author', 'link-password-12345', 'owner');
  const post = ctx.communityService.publishPost('owner', { text: '查看刚发布的帖子' }, ctx.accounts.nicknameOf('owner'));
  const receipt = (name: string, result: unknown): ModelMessage => ({ role: 'tool', toolName: name, toolCallId: 'call', content: JSON.stringify({ ok: true, result }) });
  const messages = [receipt('community.post_publish', { pending: true }), receipt('community.post_publish', { completed: true, result: post }), receipt('community.post_detail', post), receipt('community.post_detail', { id: 'https://untrusted.example' })];
  assert.deepEqual(agentPostResultLinks(ctx, 'owner', messages), [{ view: 'community', label: '查看帖子', postId: post.id }]);
  assert.deepEqual(agentPostResultLinks(ctx, 'owner', [{ ...messages[1], role: 'user' }]), []);
  ctx.communityService.removePost('owner', post.id);
  assert.deepEqual(agentPostResultLinks(ctx, 'owner', messages), []);
});

test('import and comparison links target current owned schemes and ignore failed or deleted results', () => {
  const ctx = createServerContext({ seedDemo: false });
  const save = (actor: string, name: string) => ctx.planLibrary.save(actor, { name, kind: 'scheme', days: [{ dayIndex: 0, stops: [], routeLegs: [], plannedCharges: [] }] });
  const first = save('owner', '导入时的名称');
  const second = save('owner', '另一份方案');
  const foreign = save('reader', '其他账号的方案');
  const receipt = (toolName: string, result: unknown, ok = true): ModelMessage => ({ role: 'tool', toolName, toolCallId: 'call', content: JSON.stringify({ ok, result }) });
  const imported = receipt('community.import_share', first);
  ctx.planLibrary.update('owner', first.id, { name: '已改名的方案', days: first.days });
  const comparison = receipt('plans.compare', { comparisons: [first, second, foreign].map(plan => ({ planId: plan.id, name: '旧名称' })) });
  const links = agentPersonalResultLinks(ctx, 'owner', [imported, comparison]);
  assert.deepEqual(links.map(link => link.planId), [first.id, second.id]);
  assert.equal(links[0].label, '查看「已改名的方案」');
  assert.deepEqual(agentPersonalResultLinks(ctx, 'owner', [receipt('community.import_share', second, false)]), []);
  assert.deepEqual(agentPersonalResultLinks(ctx, 'owner', [{ ...imported, role: 'assistant' }]), []);
  ctx.planLibrary.remove('owner', first.id);
  assert.deepEqual(agentPersonalResultLinks(ctx, 'owner', [imported, comparison]).map(link => link.planId), [second.id]);
});

test('result destinations follow actual refreshes and preserve the affected date', () => {
  assert.deepEqual(agentResultLinks([], '2026-09-22'), []);
  assert.deepEqual(agentResultLinks(['plans', 'plans'], '2026-09-23'), [{ view: 'today', label: '查看计划', date: '2026-09-23' }]);
  assert.deepEqual(agentResultLinks(['plans']).map(link => link.view), ['today', 'plan']);
  assert.deepEqual(agentResultLinks(['favorites', 'memories']).map(link => link.view), ['favorites', 'memories']);
  assert.deepEqual(agentResultLinks(['https://example.invalid', 'places']).map(link => link.view), ['places']);
  assert.equal(agentResultLinks(['plans'], 'javascript:alert(1)')[0].date, undefined);
  assert.deepEqual(agentResultLinks(['community', 'favorites'], undefined, ['community.post_publish']).map(link => link.view), ['community']);
});
