import assert from 'node:assert/strict';
import { ModelSettings } from '../dist/src/services/model-settings.js';
import { OpenMeteoWeatherProvider } from '../dist/src/providers/open-meteo.js';
import { createServerContext } from '../dist/src/server/http/bootstrap.js';
import { MemoryStateStore } from '../dist/src/persistence/state-store.js';
import { runPersonalAgent } from '../dist/src/services/personal-agent-runtime.js';

const model = new ModelSettings('data/model-settings.json').provider;
if (!model) throw new Error('未启用真实模型。');
const weather = new OpenMeteoWeatherProvider();
let observed, calls = 0;
const ctx = createServerContext({ seedDemo: false, stateStore: new MemoryStateStore(), weatherProvider: {
  providerName: weather.providerName, async read(input) { observed = await weather.read(input); return observed; },
}, modelProvider: { providerName: model.providerName, modelName: model.modelName, async generateTurn(request) {
  const turn = await model.generateTurn(request);
  console.log(JSON.stringify({ call: ++calls, tools: turn.toolCalls.map(t => t.name) }));
  return turn;
} } });
ctx.accounts.register('weather_tester', 'weather-test-12345', 'tester');
const result = await runPersonalAgent(ctx, 'tester', '查询今天武康大楼附近的天气，告诉我下午14点到17点的降水概率，附上来源。不需要创建或修改计划。', []);
assert.ok(result.steps.some(s => s.tool === 'weather.forecast' && s.ok), result.reply);
assert.equal(observed.available, true);
assert.equal(observed.source, 'Open-Meteo');
assert.ok(observed.hours.some(h => h.time.endsWith('T14:00')));
assert.match(result.reply, /Open.Meteo/i);
assert.equal(ctx.planLibrary.list('tester').length, 0);
console.log(JSON.stringify({ verified: true, calls, date: observed.date, forecast: observed.forecast, hours: observed.hours.length }));
