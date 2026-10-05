import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usableAgentLocation } from '../src/services/personal-agent-location.js';
import { createServerContext } from '../src/server/http/bootstrap.js';
import { runPersonalAgent } from '../src/services/personal-agent-runtime.js';
import { modelTurn, toolCall } from '../src/providers/model.js';

const now = '2026-09-22T10:00:00+08:00';
const fix = { lat: 31.2, lng: 121.43, accuracyMeters: 25, measuredAt: Date.parse(now) };
test('location accepts only fresh finite precise coordinates', () => {
  assert.deepEqual(usableAgentLocation(fix, now), fix);
  for (const invalid of [undefined, { label: '杭州' }, { ...fix, lat: 91 }, { ...fix, accuracyMeters: 500 }, { ...fix, measuredAt: fix.measuredAt - 300001 }, { ...fix, measuredAt: fix.measuredAt + 31000 }, { ...fix, lng: NaN }]) assert.equal(usableAgentLocation(invalid, now), undefined);
});

test('location tools use supplied coordinates and never reuse another conversation or account fix', async () => {
  let round = 0;
  let seen: any;
  const ctx = createServerContext({ seedDemo: false, now: () => now, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn(input) {
      if (++round % 2 === 1) return modelTurn([toolCall('position', 'location.current', {})]);
      seen = JSON.parse(input.messages.at(-1)!.content!);
      return modelTurn([], '已查询');
    },
  } });
  await runPersonalAgent(ctx, 'owner', '我在哪里', [], [], fix);
  assert.equal(seen.result.available, true);
  assert.equal(seen.result.lat, fix.lat);
  assert.equal(seen.result.label, null);
  await runPersonalAgent(ctx, 'other', '我在哪里', []);
  assert.equal(seen.result.available, false);
  await runPersonalAgent(ctx, 'owner', '定位权限已关闭', []);
  assert.equal(seen.result.available, false);
});

test('nearby tool passes actor and coordinates, not a hardcoded city', async () => {
  let round = 0, query: any;
  const ctx = createServerContext({ seedDemo: false, now: () => now, modelProvider: {
    providerName: 'test', modelName: 'test', async generateTurn() {
      return ++round === 1 ? modelTurn([toolCall('near', 'places.nearby', { radiusMeters: 1500 })]) : modelTurn([], '已查询');
    },
  } });
  const catalog = ctx.options.placeProvider!;
  const original = catalog.search.bind(catalog);
  catalog.search = async input => { query = input; return original(input); };
  await runPersonalAgent(ctx, 'owner', '附近有什么', [], [], fix);
  assert.equal(query.actorId, 'owner');
  assert.equal(query.cityCode, '');
  assert.deepEqual(query.center, { lat: fix.lat, lng: fix.lng });
  assert.equal(query.radiusMeters, 1500);
});
