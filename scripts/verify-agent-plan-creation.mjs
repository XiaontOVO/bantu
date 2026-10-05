// Real configured model and travel providers; all writes stay in isolated memory.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createProviderBundle } from '../dist/src/providers/factory.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { runPersonalAgent } from '../dist/src/services/personal-agent-runtime.js';

if (existsSync('.env')) loadEnvFile('.env');
const providers = createProviderBundle(process.env);
const model = new ModelSettings('data/model-settings.json', providers.modelProvider).provider;
assert.ok(model, 'Configure the official model before running real acceptance.');
const cases = [
  { text: '安排明天上午9点去武康大楼和龙华寺，按这个顺序，各游览60分钟，步行，直接保存日计划。', kind: 'plan', date: '2026-10-01', stops: 2 },
  { text: '安排徐汇一日游，生成无日期的一日方案，选择3个地点，步行，直接保存。', kind: 'scheme', days: 1, stops: 3 },
  { text: '帮我生成国庆10月1日至7日的徐汇7日旅行方案，每天两个地点，可重复去同一地点，轻松一些。先保存完整七天方案，不要载入日计划。', kind: 'scheme', days: 7, stops: 14 },
  { text: '安排徐汇一日游', kind: 'scheme', days: 1 },
  { text: '安排明天下午两点半先去武康大楼，再去龙华寺，最后西岸美术馆。每站游览45分钟。去武康大楼驾车，去龙华寺公共交通，去西岸美术馆步行。请按此顺序直接保存明天的日计划，并计算道路时间，不要建无日期方案。', kind: 'plan', date: '2026-10-01', stops: 3, names: ['武康大楼','龙华寺','西岸美术馆'], modes: ['driving','transit','walking'], duration: 45, firstStart: 870 },
];
const index = process.argv.indexOf('--case');
const selected = index >= 0 ? [Number(process.argv[index + 1])] : cases.map((_, i) => i);
let failures = 0;
for (const caseIndex of selected) {
  const item = cases[caseIndex]; assert.ok(item, 'Unknown case');
  let modelCalls = 0;
  const started = performance.now();
  const ctx = createServerContext({ ...providers, seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-09-30T01:00:00.000Z',
    modelProvider: { providerName: model.providerName, modelName: model.modelName, async generateTurn(request) {
      const turn = await model.generateTurn(request);
      console.log(JSON.stringify({ case: caseIndex, round: ++modelCalls, finish: turn.finishReason, tools: turn.toolCalls.map(c => c.name), errorCode: turn.error?.code }));
      return turn;
    } },
  });
  const result = await runPersonalAgent(ctx, 'isolated-plan-tester', item.text, []);
  const plans = ctx.planLibrary.list('isolated-plan-tester');
  try {
    const saved = plans.find(p => p.kind === item.kind);
    assert.ok(saved, result.reply);
    if (item.date) assert.equal(saved.localDate, item.date);
    const days = saved.kind === 'scheme' ? saved.days : [saved];
    if (item.days) assert.equal(days.length, item.days);
    const stopCount = days.reduce((count, day) => count + day.stops.length, 0);
    if (item.stops) assert.equal(stopCount, item.stops);
    else assert.ok(stopCount > 0, 'A broad planning request must still save real places.');
    if (item.names) assert.deepEqual(days[0].stops.map(stop=>stop.place.name),item.names,'preserve the named order');
    if (item.modes) assert.deepEqual(days[0].stops.map(stop=>stop.preferredTransportMode || days[0].routeLegs.find(leg=>leg.toStopId===stop.stopId)?.transportMode || 'walking'),item.modes,'save the mode for going to each place, including the first');
    if (item.duration) assert.ok(days[0].stops.every(stop=>stop.plannedDurationMinutes===item.duration),'preserve every requested visit duration');
    if (item.firstStart) assert.equal(days[0].stops[0].startMinutes,item.firstStart);
    if (item.modes) writeFileSync('tmp/agent-mixed-transport-live-fixture.json',JSON.stringify({name:saved.name,kind:saved.kind,localDate:saved.localDate,timezone:saved.timezone,cityCode:saved.cityCode,snapshot:{stops:saved.stops,routeLegs:saved.routeLegs,plannedCharges:saved.plannedCharges}},null,2));
    assert.ok(result.steps.some(step => step.tool === 'plans.create' && step.ok));
    assert.equal(ctx.personalAgentTasks.current('isolated-plan-tester').status, 'completed');
    console.log(JSON.stringify({ case: caseIndex, passed: true, modelCalls, elapsedMs: Math.round(performance.now() - started), days: days.length, stops: stopCount, steps: result.steps }));
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ case: caseIndex, passed: false, error: error.message, reply: result.reply, steps: result.steps, task: ctx.personalAgentTasks.current('isolated-plan-tester') }));
  }
}
console.log(JSON.stringify({ realModel: true, realTravelProviders: true, isolatedData: true, cases: selected.length, failures }));
if (failures && !process.argv.includes('--observe')) process.exitCode = 1;
