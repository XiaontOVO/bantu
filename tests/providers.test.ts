import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DemoClockProvider,
  DemoPlaceProvider,
  DemoRouteProvider,
  DisabledWeatherProvider,
} from '../src/providers/travel.js';
import { createProviderBundle } from '../src/providers/factory.js';
import { FossgisOsrmRouteProvider } from '../src/providers/osrm.js';
import { AmapRouteProvider } from '../src/providers/amap.js';
import { checkConstraint } from '../src/domain/constraints.js';
import { makeSnapshot } from './helpers.js';

test('demo place provider separates empty result from error', async () => {
  const provider = new DemoPlaceProvider();
  const found = await provider.search({ cityCode: '310100', query: '公园' });
  assert.equal(found.empty, false);
  assert.ok(found.places.some((place) => place.facilityCodes.includes('rest_area')));

  const empty = await provider.search({ cityCode: '310100', query: '不存在的地点' });
  assert.equal(empty.empty, true);
  assert.equal(empty.error, undefined);
});

test('demo places carry complete structured info and filter by city', async () => {
  const provider = new DemoPlaceProvider();
  const all = await provider.search({ cityCode: '' });
  assert.equal(all.empty, false);
  const byName = new Map(all.places.map(place => [place.name, place]));
  const correctedCoordinates: Record<string, [number, number]> = {
    '武康大楼': [31.206298, 121.433655],
    '徐家汇书院': [31.192304, 121.432458],
    '上海图书馆': [31.209211, 121.440142],
    '龙华寺': [31.177080, 121.447249],
    '西岸美术馆': [31.171541, 121.454705],
    '徐家汇公园': [31.199279, 121.437846],
    '桂林公园': [31.167189, 121.413286],
  };
  for (const [name, [lat, lng]] of Object.entries(correctedCoordinates)) {
    assert.deepEqual([byName.get(name)?.coordinates?.lat, byName.get(name)?.coordinates?.lng], [lat, lng], name + ' 使用已核对坐标');
  }
  for (const place of all.places) {
    assert.equal(place.cityCode, '310100', `${place.placeId} 缺少城市代码`);
    assert.ok(place.address, `${place.placeId} 缺少地址`);
    assert.ok(Array.isArray(place.openingIntervals), `${place.placeId} 缺少开放时段字段`);
    if (place.placeId.startsWith('xh-')) {
      assert.equal(place.districtAdcode, '310104');
      assert.deepEqual(place.openingIntervals, [], '未核实的营业时间保持为空，不应猜测');
      assert.equal(place.costEstimate, undefined, '未核实的票价保持为空，不应伪造');
    } else {
      assert.ok(place.openingIntervals.length > 0, `${place.placeId} 缺少已知开放时段`);
      assert.ok(place.costEstimate, `${place.placeId} 缺少费用参考`);
    }
  }

  const shanghai = await provider.search({ cityCode: '310100' });
  assert.equal(shanghai.places.length, all.places.length);
  // 目录当前只收录上海徐汇样例；其他城市应返回明确的空结果，而不是假装有地点。
  const hangzhou = await provider.search({ cityCode: '330100' });
  assert.equal(hangzhou.places.length, 0);
  assert.equal(hangzhou.empty, true);
});

test('demo route adapter returns known walking data but leaves transit walking unknown', async () => {
  const provider = new DemoRouteProvider();
  const origin = { lat: 30.259, lng: 120.149, placeId: 'a' };
  const destination = { lat: 30.256, lng: 120.153, placeId: 'b' };
  const walking = await provider.plan({ origin, destination, transportMode: 'walking' });
  assert.ok(walking.leg.walkingMeters !== undefined && walking.leg.walkingMeters > 0);

  const transit = await provider.plan({ origin, destination, transportMode: 'transit' });
  assert.equal(transit.leg.walkingMeters, undefined);
  const check = checkConstraint(
    {
      constraintId: 'walk:leg',
      kind: 'walking_limit',
      strength: 'hard',
      payload: { scope: 'leg', maxWalkingMeters: 500 },
    },
    makeSnapshot({ routeLegs: [transit.leg] }),
  );
  assert.equal(check.status, 'unknown');
});

test('disabled weather provider reports unavailable without fabricating weather', async () => {
  const provider = new DisabledWeatherProvider();
  const result = await provider.read({ cityCode: '330100', date: '2026-09-20' });
  assert.equal(result.available, false);
  assert.equal(result.error?.code, 'WEATHER_PROVIDER_DISABLED');
});

test('demo clock is controlled and separate from wall clock', () => {
  const clock = new DemoClockProvider('2026-09-20T13:00:00+08:00');
  assert.equal(clock.now('demo'), '2026-09-20T13:00:00+08:00');
  clock.advanceMinutes(30);
  assert.equal(clock.now('demo'), '2026-09-20T13:30:00+08:00');
});

test('provider factory uses real OSM routing by default and keeps Amap routing when its key exists', () => {
  const demo = createProviderBundle({});
  assert.equal(demo.hasOnlineModel, false);
  assert.equal(demo.hasOnlinePlaces, false);
  assert.ok(demo.placeProvider instanceof DemoPlaceProvider);
  assert.ok(demo.routeProvider instanceof FossgisOsrmRouteProvider);
  assert.equal(demo.hasOnlineRoutes, true);

  const online = createProviderBundle({
    MODEL_API_KEY: 'k',
    MODEL_BASE_URL: 'https://model.example/v1',
    MODEL_NAME: 'm',
    AMAP_API_KEY: 'amap-key',
  } as NodeJS.ProcessEnv);
  assert.equal(online.hasOnlineModel, true);
  assert.equal(online.hasOnlinePlaces, true);
  assert.equal(online.hasOnlineRoutes, true);
  assert.ok(online.modelProvider);
  assert.ok(online.routeProvider instanceof AmapRouteProvider);
});
