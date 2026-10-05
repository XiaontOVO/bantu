// Actual model + business services; controlled forecasts exercise both sides of a condition.
import assert from 'node:assert/strict';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { runPersonalAgent } from '../dist/src/services/personal-agent-runtime.js';

const model = new ModelSettings('data/model-settings.json').provider;
if (!model) throw new Error('未启用真实模型。');
let calls = 0;
for (const probability of [80, 20, null]) {
  let weatherReads = 0;
  const ctx = createServerContext({ seedDemo: false, stateStore: new MemoryStateStore(), now: () => '2026-09-22T12:00:00+08:00', weatherProvider: {
    providerName: 'controlled-weather-for-acceptance', async read(input) {
      weatherReads++;
      if (probability === null) return { available: false, error: { code: 'TEST_UNAVAILABLE', message: '天气查询临时失败，未取得预报。' } };
      return { available: true, date: input.date, timezone: 'Asia/Shanghai', source: '验收用受控预报', hours: [{ time: '2026-09-22T14:00', precipitationProbability: probability, temperatureC: 25, precipitationMm: probability > 60 ? 2 : 0 }] };
    },
  }, modelProvider: { providerName: model.providerName, modelName: model.modelName, async generateTurn(request) {
    const turn = await model.generateTurn(request);
    console.log(JSON.stringify({ probability, call: ++calls, tools: turn.toolCalls.map(t => t.name) }));
    return turn;
  } } });
  ctx.accounts.register('weather_plan_tester', 'weather-plan-12345', 'tester');
  const find = async query => (await ctx.options.placeProvider.search({ cityCode: '310100', query })).places.find(p => p.name === query);
  const park = await find('徐家汇公园'), tower = await find('武康大楼'), indoor = await find('徐家汇书院');
  assert.ok(park && tower && indoor);
  const stop = (p, id, start) => ({ stopId: id, placeId: p.placeId, place: { placeId: p.placeId, name: p.name, coordinates: p.coordinates }, status: 'planned', startMinutes: start, endMinutes: start + 60 });
  const plan = ctx.planLibrary.save('tester', { name: '午后散步', kind: 'plan', localDate: '2026-09-22', snapshot: { stops: [stop(park, 'park', 840), stop(tower, 'tower', 960)], routeLegs: [], plannedCharges: [] } });
  const before = ctx.planLibrary.serialize();
  const result = await runPersonalAgent(ctx, 'tester', '请查今天徐家汇公园14点的降水概率。如果达到60%，把“午后散步”里14点的徐家汇公园换成徐家汇书院，时间和60分钟时长不变，直接保存。不到60%或查不到天气就保留原计划。16点武康大楼的安排无论如何都不要改。', []);
  assert.ok(weatherReads > 0, 'must query weather before evaluating the condition');
  const saved = ctx.planLibrary.list('tester').find(p => p.id === plan.id);
  if (probability === 80) {
    assert.ok(result.steps.some(s => s.tool === 'plans.replace_place' && s.ok), result.reply);
    assert.equal(saved.stops[0].placeId, indoor.placeId);
    assert.equal(saved.stops[0].startMinutes, 840);
    assert.equal(saved.stops[0].endMinutes, 900);
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.stops[1], plan.stops[1]);
  } else assert.equal(ctx.planLibrary.serialize(), before, 'false or unknown condition must not change any plan data');
  console.log(JSON.stringify({ probability, verified: true, reply: result.reply }));
}
console.log(JSON.stringify({ verified: true, calls, scenarios: ['condition-met-replace-once', 'condition-not-met-no-write', 'weather-unavailable-no-write'] }));
