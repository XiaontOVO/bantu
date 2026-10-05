import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) => import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;
const [mapModule, storeModule] = await Promise.all([load('public/lib/map.js'), load('public/lib/store.js')]);
const state = storeModule.state as Record<string, any>;

test('打开正在前往的计划站点时以当前位置为起点、该站为终点并沿用所选交通方式', () => {
  const keys = ['trip', 'savedPlans', 'planViewDate', 'mapPlaces', 'currentLocation', 'mapFrom', 'mapTo', 'mapRouteView', 'routeMode', 'routeModeSelected', 'routePreview', 'stopModes'];
  const before = Object.fromEntries(keys.map(key => [key, state[key]]));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const previous = { placeId: 'route-origin', name: '上一站', coordinates: { lat: 31.2, lng: 121.4 } };
  const destination = { placeId: 'route-destination', name: '计划终点', coordinates: { lat: 31.21, lng: 121.41 } };
  state.trip = null;
  state.planViewDate = today;
  state.mapPlaces = [previous, destination];
  state.currentLocation = { placeId: 'my-location', name: '我的位置', coordinates: { lat: 31.22, lng: 121.42, source: 'gps', accuracyMeters: 35, measuredAt: Date.now() } };
  state.savedPlans = [{ id: 'route-plan', kind: 'plan', localDate: today, stops: [
    { stopId: 'previous-stop', placeId: previous.placeId, place: previous, status: 'completed' },
    { stopId: 'active-stop', placeId: destination.placeId, place: destination, status: 'en_route', estimatedTransportMode: 'driving' },
  ], routeLegs: [{ fromStopId: 'previous-stop', toStopId: 'active-stop', transportMode: 'walking', durationMinutes: 30 }] }];
  state.stopModes = { 'active-stop': 'driving' };
  try {
    const selected = mapModule.selectStopRoute('active-stop');
    assert.equal(selected.from, 'my-location');
    assert.equal(selected.to, destination.placeId);
    assert.equal(selected.mode, 'driving');
    assert.equal(state.mapRouteView, 'endpoints');
  } finally {
    for (const [key, value] of Object.entries(before)) state[key] = value;
  }
});

test('收藏接口暂时失败时地图仍能加载徐汇地点目录', async () => {
  const before = { fetch: globalThis.fetch, mapPlaces: state.mapPlaces, mapConfig: state.mapConfig, loadStatus: state.loadStatus };
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/map-config') return new Response(JSON.stringify({ data: { cityCode: '310100', districtAdcode: '310104' } }), { status: 200 });
    if (url.pathname === '/api/v1/favorites' || url.pathname === '/api/v1/community/post-favorites') {
      return new Response(JSON.stringify({ error: { message: 'favorites unavailable' } }), { status: 503 });
    }
    if (url.pathname === '/api/v1/places') return new Response(JSON.stringify({ data: [{ placeId: 'xh-1', name: '测试地点' }], meta: { nextCursor: null } }), { status: 200 });
    if (url.pathname === '/api/v1/plans') return new Response(JSON.stringify({ data: [], meta: { nextCursor: null } }), { status: 200 });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  state.mapPlaces = [];
  state.mapConfig = null;
  try {
    await mapModule.loadMapData();
    assert.deepEqual(state.mapPlaces.map((place: any) => place.placeId), ['xh-1']);
    assert.equal(state.mapConfig.cityCode, '310100');
    assert.equal(state.loadStatus.favorites.status, 'error');
  } finally {
    globalThis.fetch = before.fetch;
    state.mapPlaces = before.mapPlaces;
    state.mapConfig = before.mapConfig;
    state.loadStatus = before.loadStatus;
  }
});

test('地图配置接口暂时失败时仍使用徐汇默认配置加载地点', async () => {
  const before = { fetch: globalThis.fetch, mapPlaces: state.mapPlaces, mapConfig: state.mapConfig, loadStatus: state.loadStatus };
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/map-config') return new Response(JSON.stringify({ error: { message: 'config unavailable' } }), { status: 503 });
    if (url.pathname === '/api/v1/favorites' || url.pathname === '/api/v1/community/post-favorites') {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.pathname === '/api/v1/places') return new Response(JSON.stringify({ data: [{ placeId: 'xh-fallback', name: '徐汇测试地点' }], meta: {} }), { status: 200 });
    if (url.pathname === '/api/v1/plans') return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  state.mapPlaces = [];
  state.mapConfig = null;
  try {
    await mapModule.loadMapData();
    assert.equal(state.mapConfig.cityCode, '310100');
    assert.equal(state.mapConfig.districtAdcode, '310104');
    assert.deepEqual(state.mapPlaces.map((place: any) => place.placeId), ['xh-fallback']);
  } finally {
    globalThis.fetch = before.fetch;
    state.mapPlaces = before.mapPlaces;
    state.mapConfig = before.mapConfig;
    state.loadStatus = before.loadStatus;
  }
});

test('地图重绘保留正在加载的目录，离页或切换身份后不应用迟到目录', async () => {
  const previous = { fetch: globalThis.fetch, principal: state.principal, mapPlaces: state.mapPlaces, mapConfig: state.mapConfig, favorites: state.favorites, postFavorites: state.postFavorites, loadStatus: state.loadStatus };
  try {
    for (const scenario of ['remount', 'leave', 'identity']) {
      state.principal = { principalId: 'map-owner-a', kind: 'anonymous' };
      state.mapPlaces = [];
      state.mapConfig = null;
      let release!: () => void;
      globalThis.fetch = (async input => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/v1/map-config') {
          await new Promise<void>(resolve => { release = resolve; });
          return new Response(JSON.stringify({ data: { cityCode: '310100', districtAdcode: '310104' } }));
        }
        return new Response(JSON.stringify({ data: url.pathname === '/api/v1/places' ? [{ placeId: 'map-loaded-place' }] : [], meta: {} }));
      }) as typeof fetch;
      const loading = mapModule.loadMapData();
      assert.ok(release, 'the request is pending before the map is replaced');
      if (scenario === 'remount') mapModule.disposeMap({ cancelData: false });
      if (scenario === 'leave') mapModule.disposeMap();
      if (scenario === 'identity') state.principal = { principalId: 'map-owner-b', kind: 'anonymous' };
      release();
      await loading;
      if (scenario === 'remount') {
        assert.equal(state.mapConfig.cityCode, '310100');
        assert.deepEqual(state.mapPlaces.map((place: any) => place.placeId), ['map-loaded-place']);
      } else {
        assert.equal(state.mapConfig, null, 'late configuration is not applied after leaving or changing identity');
        assert.deepEqual(state.mapPlaces, []);
      }
    }
  } finally {
    globalThis.fetch = previous.fetch;
    Object.assign(state, previous);
  }
});
