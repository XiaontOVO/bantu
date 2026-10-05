// Run after npm run build. Uses the configured model, with isolated in-memory business data.
import assert from 'node:assert/strict';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { runPersonalAgent as executePersonalAgent } from '../dist/src/services/personal-agent-runtime.js';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const configHash=()=>createHash('sha256').update(readFileSync('data/model-settings.json')).digest('hex');
const officialConfigBefore=configHash();
let currentStage=0;
async function runPersonalAgent(...args) {
  const stage=++currentStage,started=Date.now();
  console.log(JSON.stringify({phase:'task-start',stage,instruction:args[2]}));
  const result=await executePersonalAgent(...args);
  console.log(JSON.stringify({phase:'task-receipt',stage,elapsedMs:Date.now()-started,reply:result.reply,steps:result.steps}));
  return result;
}
process.on('exit',()=>{
  const unchanged=configHash()===officialConfigBefore;
  console.log(JSON.stringify({phase:'config-audit',officialConfigUnchanged:unchanged,lastStage:currentStage}));
  if(!unchanged)process.exitCode=1;
});

const settings = new ModelSettings('data/model-settings.json');
if (!settings.provider) throw new Error('未启用真实模型，无法执行真实模型验收。');
const provider = settings.provider;
assert.equal(provider.thinking?.mode,'on','retain the explicitly chosen official thinking mode');
assert.equal(provider.thinking?.effort,'low','retain the explicitly chosen official thinking intensity');
let calls = 0;
const ctx = createServerContext({ seedDemo: false, stateStore: new MemoryStateStore(), modelProvider: {
  providerName: provider.providerName, modelName: provider.modelName,
  async generateTurn(request) {
    const started=Date.now();
    const result = await provider.generateTurn(request);
    console.log(JSON.stringify({ turn: ++calls, elapsedMs:Date.now()-started, tools: result.toolCalls.map(c => c.name), errorCode: result.error?.code }));
    return result;
  },
} });
ctx.accounts.register('personal_acceptance', 'personal-test-12345', 'isolated-agent-acceptance');
const result = await runPersonalAgent(ctx, 'isolated-agent-acceptance', '帮我安排明天下午两点去武康大楼，游览60分钟，直接保存为明天的计划。', []);
const plans = ctx.planLibrary.list('isolated-agent-acceptance').filter(p => p.kind === 'plan');
assert.ok(result.steps.some(s => s.tool === 'places.search' && s.ok), '模型应查询真实目录');
assert.ok(result.steps.some(s => s.tool === 'plans.create' && s.ok), '模型应实际保存计划');
assert.equal(plans.length, 1);
assert.equal(plans[0].stops.length, 1);
assert.equal(plans[0].stops[0].place.name, '武康大楼');
assert.equal(plans[0].stops[0].startMinutes, 840);
assert.equal(plans[0].stops[0].plannedDurationMinutes, 60);
const actor = 'isolated-agent-acceptance';
const tomorrow = new Date(Date.now() + 86400000);
const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(tomorrow);
const part = type => dateParts.find(p => p.type === type).value;
assert.equal(plans[0].localDate, `${part('year')}-${part('month')}-${part('day')}`);
const edited = await runPersonalAgent(ctx, actor, '把明天的计划改名为“徐汇慢慢走”，武康大楼改成15点开始，游览时间保持60分钟。直接修改。', []);
let saved = ctx.planLibrary.list(actor).find(p => p.id === plans[0].id);
assert.equal(saved.name, '徐汇慢慢走');
assert.equal(saved.stops[0].startMinutes, 900);
assert.equal(saved.stops[0].plannedDurationMinutes, 60);
const added = await runPersonalAgent(ctx, actor, '在明天“徐汇慢慢走”的计划里再加入徐家汇书院，17点开始，游览45分钟。直接保存。', []);
saved = ctx.planLibrary.list(actor).find(p => p.id === plans[0].id);
assert.equal(saved.stops.length, 2);
const newStop = saved.stops.find(s => s.place.name === '徐家汇书院');
assert.ok(newStop);
assert.equal(newStop.startMinutes, 1020);
assert.equal(newStop.plannedDurationMinutes, 45);
const removed = await runPersonalAgent(ctx, actor, '把明天计划里的徐家汇书院移除，武康大楼保留。直接修改。', []);
saved = ctx.planLibrary.list(actor).find(p => p.id === plans[0].id);
assert.equal(saved.stops.length, 1);
assert.equal(saved.stops[0].place.name, '武康大楼');
const scheme = ctx.planLibrary.save(actor, { name: '复合验收方案', kind: 'scheme', days: [{ dayIndex: 0, stops: structuredClone(saved.stops), routeLegs: [], plannedCharges: [] }] });
const composite = await runPersonalAgent(ctx, actor, '将“复合验收方案”载入到明天，覆盖明天待进行的安排，并把武康大楼加入收藏。如果需要确认覆盖，请先问我，确认后完成剩下的操作。', []);
assert.ok(ctx.personalAgentTasks.pendingLoad(actor), 'existing plans require confirmation');
const confirmation = await runPersonalAgent(ctx, actor, '确认载入', []);
assert.equal(ctx.personalAgentTasks.pendingLoad(actor), undefined);
assert.ok(ctx.planLibrary.list(actor).some(p => p.sourceSchemeId === scheme.id && p.localDate === saved.localDate));
const favorites = ctx.favoritesService.list(actor);
assert.ok(favorites.some(p => p.kind === 'place' && p.place.placeId === saved.stops[0].placeId), 'confirmed composite request completes the favorite operation');
const progressContext = createServerContext({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-09-22T12:00:00+08:00', modelProvider: ctx.options.modelProvider });
progressContext.accounts.register('progress_acceptance', 'progress-test-12345', actor);
const progressPlan = progressContext.planLibrary.save(actor, { name: '今日武康大楼', kind: 'plan', localDate: '2026-09-22', snapshot: {
  stops: [{ ...structuredClone(saved.stops[0]), startMinutes: 540, plannedArrivalMinutes: 540, endMinutes: 660, departureMinutes: 660 }], routeLegs: [], plannedCharges: [],
} });
const recorded = await runPersonalAgent(progressContext, actor, '补记今天武康大楼的实际进度：我9点出发，9点10分到达，10点游览完成。请直接记录这些真实时间。', []);
let progress = progressContext.planLibrary.get(actor, progressPlan.id);
assert.equal(progress.executionEvents.length, 3);
assert.deepEqual(progress.executionEvents.map(e => [e.type, Date.parse(e.occurredAt)]), [
  ['depart', Date.parse('2026-09-22T09:00:00+08:00')], ['arrive', Date.parse('2026-09-22T09:10:00+08:00')], ['complete', Date.parse('2026-09-22T10:00:00+08:00')],
]);
const completeEventId = progress.executionEvents.at(-1).executionEventId;
const corrected = await runPersonalAgent(progressContext, actor, '今天武康大楼的完成时间记错了，实际是10点15分。只纠正完成时间，出发和到达时间保持不变。', []);
progress = progressContext.planLibrary.get(actor, progressPlan.id);
assert.equal(progress.executionEvents.length, 4);
assert.equal(progress.executionEvents.at(-1).correctsEventId, completeEventId);
assert.equal(Date.parse(progress.executionEvents.at(-1).occurredAt), Date.parse('2026-09-22T10:15:00+08:00'));
const loadedBeforeEdit = structuredClone(ctx.planLibrary.list(actor).filter(p => p.kind === 'plan'));
const resized = await runPersonalAgent(ctx, actor, '把“复合验收方案”改成一共3天，把第1天的武康大楼移到第3天下午2点，仍然游览60分钟。只改方案，不要重新载入。', []);
const movedScheme = ctx.planLibrary.get(actor, scheme.id);
assert.equal(movedScheme.days.length, 3);
assert.equal(movedScheme.days[0].stops.length, 0);
assert.equal(movedScheme.days[2].stops.length, 1);
assert.equal(movedScheme.days[2].stops[0].startMinutes, 840);
assert.equal(movedScheme.days[2].stops[0].endMinutes, 900);
assert.deepEqual(ctx.planLibrary.list(actor).filter(p => p.kind === 'plan'), loadedBeforeEdit);
const rescheduled = await runPersonalAgent(ctx, actor, '把明天唯一的日计划改到后天，时间和地点不变。然后把改期后的这份日计划复制为新的无日期方案，命名为“下次徐汇”。', []);
const dayAfter = new Date(Date.now() + 2 * 86400000);
const afterParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(dayAfter);
const afterPart = type => afterParts.find(p => p.type === type).value;
const movedPlan = ctx.planLibrary.list(actor).find(p => p.kind === 'plan');
assert.equal(movedPlan.localDate, `${afterPart('year')}-${afterPart('month')}-${afterPart('day')}`);
assert.deepEqual(movedPlan.stops, loadedBeforeEdit[0].stops);
const copied = ctx.planLibrary.list(actor).find(p => p.kind === 'scheme' && p.name === '下次徐汇');
assert.ok(copied);
assert.equal(copied.localDate, undefined);
assert.equal(copied.days.length, 1);
assert.equal(copied.days[0].stops[0].place.placeId, movedPlan.stops[0].place.placeId);
assert.notEqual(copied.days[0].stops[0].stopId, movedPlan.stops[0].stopId);
const beforeRestore = movedPlan.stops[0].startMinutes;
await runPersonalAgent(ctx, actor, '把后天日计划里的武康大楼改到下午4点，仍游览60分钟。直接修改。', []);
assert.equal(ctx.planLibrary.get(actor, movedPlan.id).stops[0].startMinutes, 960);
const restored = await runPersonalAgent(ctx, actor, '将后天的日计划恢复到最近一次修改前的历史版本，日期不要改变。', []);
assert.ok(restored.steps.some(step => step.tool === 'plans.versions' && step.ok));
assert.ok(restored.steps.some(step => step.tool === 'plans.restore' && step.ok));
assert.equal(ctx.planLibrary.get(actor, movedPlan.id).stops[0].startMinutes, beforeRestore);
assert.equal(ctx.planLibrary.get(actor, movedPlan.id).localDate, movedPlan.localDate);
const deleteRequest = await runPersonalAgent(ctx, actor, '删除名为“下次徐汇”的方案。删除成功后，再新建一条旅行记忆，内容就是“已经清理旧方案”。', []);
assert.ok(ctx.personalAgentTasks.pendingAction(actor));
assert.ok(ctx.planLibrary.list(actor).some(p => p.id === copied.id));
assert.equal(ctx.personalMemoriesService.list(actor).filter(m => m.userText === '已经清理旧方案').length, 0);
const deleted = await runPersonalAgent(ctx, actor, '确认删除', []);
assert.equal(ctx.planLibrary.list(actor).some(p => p.id === copied.id), false);
assert.ok(ctx.planLibrary.list(actor).some(p => p.id === movedPlan.id));
assert.equal(ctx.personalMemoriesService.list(actor).filter(m => m.userText === '已经清理旧方案').length, 1);
console.log(JSON.stringify({ verified: true, model: provider.modelName, calls, planDate: saved.localDate,
  scenarios: [result, edited, added, removed, composite, confirmation, recorded, corrected, resized, rescheduled, restored, deleteRequest, deleted].map(r => r.steps) }));
