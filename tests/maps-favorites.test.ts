import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { AmapPlaceProvider, AmapRouteProvider } from '../src/providers/amap.js';

test('Xuhui map directory loads through the HTTP layer with an online AMap place provider', async () => {
  let amapCalls = 0;
  const server = createHttpServer({
    seedDemo: false,
    placeProvider: new AmapPlaceProvider({ apiKey: 'test-key', fetchImpl: (async () => {
      amapCalls += 1;
      return new Response(JSON.stringify({ status: '1', pois: [] }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch }),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/places?cityCode=310100&districtAdcode=310104&limit=50`);
    const result = await response.json() as { data: Array<{ name: string; placeId: string; districtAdcode: string }> };
    assert.equal(response.status, 200);
    assert.equal(result.data.length, 27);
    assert.ok(result.data.some(place => place.name === '巴金故居'));
    assert.ok(result.data.every(place => place.districtAdcode === '310104'));
    assert.equal(amapCalls, 0, 'the platform curated directory is not a keyword search against AMap');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('personal favorites work without a trip, isolate users, deduplicate and survive restart', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store });
  const start = async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
  };
  let base = await start();
  const guest = async () => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, cookie: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json() as any) };
  };
  try {
    const a = await guest(), b = await guest();
    const catalog = await call('/api/v1/places', a);
    const xuhuiCatalog = await call('/api/v1/places?cityCode=310100&districtAdcode=310104', a);
    assert.ok(xuhuiCatalog.data.length >= 27, 'Xuhui map directory should include its curated catalog, not just current itinerary stops');
    assert.ok(xuhuiCatalog.data.every((place: any) => place.cityCode === '310100' && place.districtAdcode === '310104'));
    assert.ok(xuhuiCatalog.data.some((place: any) => place.placeId === 'xh-long-museum-west-bund'));
    assert.ok(xuhuiCatalog.data.some((place: any) => place.placeId === 'xh-ba-jin-former-residence'));
    assert.ok(!xuhuiCatalog.data.some((place: any) => place.name === '徐家汇天主教堂'));
    const lake = catalog.data.find((place: any) => place.placeId === '12143603120601');
    const detail = await call('/api/v1/places/12143603120601', a);
    assert.equal(lake.suggestedDurationMinutes, 60);
    assert.deepEqual(lake.openingIntervals, detail.data.openingIntervals);
    assert.ok(lake.openingIntervals.length > 0, '地图列表必须保留开放时段，供加入计划前校验');
    assert.equal((await fetch(base + '/api/v1/favorites')).status, 401);
    const saved = await call('/api/v1/favorites', a, 'POST', { placeId: '12143603120601' });
    assert.equal(saved.status, 200); assert.equal(saved.data[0].place.name, '武康大楼');
    assert.equal((await call('/api/v1/favorites', a, 'POST', { placeId: '12143603120601' })).data.length, 1);
    assert.equal((await call('/api/v1/favorites', b)).data.length, 0);
    await call('/api/v1/favorites/12143603120601', b, 'DELETE');
    assert.equal((await call('/api/v1/favorites', a)).data.length, 1);
    assert.equal((await call('/api/v1/favorites', a, 'POST', { placeId: 'missing' })).status, 404);
    // 旧版旅行收藏仍能看到，取消后不会在刷新时复活。
    const trip = await call('/api/v1/trips', a, 'POST', { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
    const path = `/api/v1/trips/${trip.data.trip.tripId}/shortlist`;
    await call(path, a, 'POST', { placeId: '12143803119501' });
    assert.equal((await call('/api/v1/favorites', a)).data.length, 2);
    await call('/api/v1/favorites/12143803119501', a, 'DELETE');
    assert.equal((await call(path, a)).data.length, 0);
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: false, stateStore: store }); base = await start();
    assert.equal((await call('/api/v1/favorites', a)).data[0].place.placeId, '12143603120601');
    await call('/api/v1/favorites/12143603120601', a, 'DELETE');
    assert.equal((await call('/api/v1/favorites', a)).data.length, 0);
    assert.equal((await call('/api/v1/routes', a, 'POST', { origin: { lat: 999, lng: 120 }, destination: { lat: 30, lng: 120 } })).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a legacy favorite migration cannot resurrect a place deleted while lookup is pending', async () => {
  let resolvePlace: ((value: any) => void) | undefined;
  let placeLookupStarted: (() => void) | undefined;
  const lookupStarted = new Promise<void>(resolve => { placeLookupStarted = resolve; });
  const placeProvider = {
    providerName: 'delayed-test',
    async search() { return { places: [], empty: true }; },
    detail(id: string) {
      if (id !== 'legacy_place') return Promise.resolve(null);
      placeLookupStarted?.();
      return new Promise<any>(resolve => { resolvePlace = resolve; });
    },
  };
  const server = createHttpServer({ seedDemo: false, placeProvider });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json() as any) };
  };
  try {
    const trip = await call('/api/v1/trips', 'POST', { cityCode: '330100', localDate: '2026-09-20', dataMode: 'demo' });
    assert.equal(trip.status, 200);
    const shortlist = `/api/v1/trips/${trip.data.trip.tripId}/shortlist`;
    assert.equal((await call(shortlist, 'POST', { placeId: 'legacy_place' })).status, 200);

    const pendingRead = call('/api/v1/favorites');
    await lookupStarted;
    assert.equal((await call('/api/v1/favorites/legacy_place', 'DELETE')).status, 200);
    resolvePlace?.({ placeId: 'legacy_place', name: '旧收藏地点', coordinates: null, facilityCodes: [] });
    const result = await pendingRead;
    assert.equal(result.status, 200);
    assert.equal(result.data.length, 0, 'the completed migration must respect the intervening delete');
    assert.equal((await call(shortlist)).data.length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('online route adapter returns road geometry and instructions, converts GPS and rejects empty routes', async () => {
  let requested = '', empty = false;
  const provider = new AmapRouteProvider({ apiKey: 'test-key', fetchImpl: (async (url: string) => {
    requested = url;
    const coords = new URL(url).searchParams;
    return new Response(JSON.stringify({ status: '1', route: { paths: empty ? [] : [{ duration: '600', distance: '800', steps: [{ polyline: `${coords.get('origin')};${coords.get('destination')}`, instruction: '沿步道前行' }] }] } }));
  }) as typeof fetch });
  const input = { origin: { placeId: 'a', name: '起点', facilityCodes: [], coordinates: { lat: 30.25, lng: 120.15, source: 'gps' } }, destination: { lat: 30.26, lng: 120.16 }, transportMode: 'walking' as const };
  const result = await provider.plan(input);
  assert.equal(result.error, undefined); assert.equal(result.leg.durationSeconds, 600);
  const expectedGeometry = ['origin','destination'].map(key=>{const [lng,lat]=new URL(requested).searchParams.get(key)!.split(',').map(Number);return{lat,lng};});
  assert.deepEqual(result.leg.geometry, expectedGeometry);
  assert.equal(result.leg.geometryCrs, 'GCJ02'); assert.deepEqual(result.leg.instructions, ['沿步道前行']);
  assert.notEqual(new URL(requested).searchParams.get('origin'), '120.15,30.25');
  empty = true; assert.equal((await provider.plan({ ...input, destination: { lat: 30.261, lng: 120.16 } })).error?.code, 'ROUTE_NOT_FOUND');
});
