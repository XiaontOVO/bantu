import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenMeteoWeatherProvider } from '../src/providers/open-meteo.js';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { modelTurn, toolCall } from '../src/providers/model.js';
import { createProviderBundle } from '../src/providers/factory.js';

const fixture = () => ({ timezone: 'Asia/Shanghai', daily: { time: ['2026-09-22'], temperature_2m_min: [21], temperature_2m_max: [28], weather_code: [61], precipitation_probability_max: [null], precipitation_sum: [2] }, daily_units: { temperature_2m_min: '°C', temperature_2m_max: '°C', precipitation_probability_max: '%', precipitation_sum: 'mm' }, hourly: { time: ['2026-09-22T14:00'], temperature_2m: [25], precipitation_probability: [80], precipitation: [1] }, hourly_units: { temperature_2m: '°C', precipitation_probability: '%', precipitation: 'mm' } });
const input = { cityCode: '310100', date: '2026-09-22', center: { lat: 31.2, lng: 121.43 } };

test('weather provider validates location/date/units, preserves missing probabilities and caches independently', async () => {
  let calls = 0, now = '2026-09-22T12:00:00+08:00';
  const provider = new OpenMeteoWeatherProvider({ now: () => now, fetchImpl: (async url => {
    calls++;
    const request = new URL(String(url));
    assert.equal(request.searchParams.get('timezone'), 'Asia/Shanghai');
    assert.equal(request.searchParams.get('latitude'), String(input.center.lat));
    return new Response(JSON.stringify(fixture()), { status: 200 });
  }) as typeof fetch });
  for (const invalid of [{ ...input, center: undefined }, { ...input, date: '2026-02-30' }, { ...input, date: '2026-09-21' }, { ...input, date: '2026-10-08' }]) assert.equal((await provider.read(invalid)).available, false);
  assert.equal(calls, 0);
  const result = await provider.read(input);
  assert.equal(result.available, true);
  assert.equal(result.forecast?.precipitationProbabilityMax, null);
  assert.equal(result.hours?.[0].precipitationProbability, 80);
  assert.equal(result.observedAt, undefined, 'retrieval time must not be represented as observation time');
  result.forecast!.temperatureMinC = 99;
  assert.equal((await provider.read(input)).forecast?.temperatureMinC, 21);
  assert.equal(calls, 1);
  now = '2026-09-22T12:11:00+08:00';
  await provider.read(input);
  assert.equal(calls, 2);
  assert.equal(createProviderBundle({}).weatherProvider.providerName, 'open_meteo');
  assert.equal(createProviderBundle({ WEATHER_PROVIDER: 'disabled' }).weatherProvider.providerName, 'weather_disabled');
});

test('weather errors and malformed responses never become a usable sunny forecast', async () => {
  for (const data of [{}, { ...fixture(), timezone: 'UTC' }, { ...fixture(), daily_units: {} }, { ...fixture(), daily: { ...fixture().daily, temperature_2m_min: [null] } }]) {
    const provider = new OpenMeteoWeatherProvider({ now: () => '2026-09-22T12:00:00+08:00', fetchImpl: (async () => new Response(JSON.stringify(data))) as typeof fetch });
    assert.equal((await provider.read(input)).available, false);
  }
  const unavailable = new OpenMeteoWeatherProvider({ now: () => '2026-09-22T12:00:00+08:00', fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch });
  assert.equal((await unavailable.read(input)).available, false);
});

test('Agent queries canonical weather coordinates without mutating plans and rejects absent location', async () => {
  let placeId: string | undefined;
  let reads = 0;
  const ctx = createServerContext({ seedDemo: false, weatherProvider: { providerName: 'test-weather', async read(request) {
    reads++;
    assert.ok(request.center);
    assert.equal(request.date, '2026-09-22');
    return { available: true, summary: '小雨', source: 'test-weather' };
  } }, modelProvider: { providerName: 'test', modelName: 'test', async generateTurn(request) {
    if (request.messages.at(-1)?.role === 'tool') return modelTurn([], '查询结束');
    return modelTurn([toolCall('weather', 'weather.forecast', { date: '2026-09-22', ...(placeId ? { placeId } : {}) })]);
  } } });
  assert.equal((await runPersonalAgent(ctx, 'owner', '查天气', [])).steps[0].ok, false);
  assert.equal(reads, 0);
  placeId = (await ctx.options.placeProvider!.search({ cityCode: '310100', query: '武康大楼' })).places[0].placeId;
  const before = ctx.planLibrary.serialize();
  assert.equal((await runPersonalAgent(ctx, 'owner', '查武康大楼天气', [])).steps[0].ok, true);
  assert.equal(reads, 1);
  assert.equal(ctx.planLibrary.serialize(), before);
});
