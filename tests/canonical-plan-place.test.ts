import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import type { DemoPlace } from '../src/demo/demo-data.js';
import type { PlaceProvider } from '../src/providers/travel.js';

const directoryPlace: DemoPlace = {
  placeId: 'catalog-place-1',
  name: '目录正式地点',
  coordinates: { lat: 31.1901, lng: 121.4362, source: 'official-directory' },
  facilityCodes: ['restroom', 'accessible_entrance'],
  provider: 'official-catalog',
  providerPlaceId: 'catalog-source-1',
  cityCode: '310104',
  dataMode: 'demo',
  evidenceIds: ['directory-evidence-1'],
  category: 'museum',
  suggestedDurationMinutes: 60,
  openingIntervals: [],
  // Provider extensions must never be copied into the saved PlaceRef.
  customTags: ['another-visitor-private-tag'],
  officialTagIds: ['official-tag'],
};

function staleStop(stopId: string) {
  return {
    stopId,
    placeId: 'catalog-place-1',
    place: {
      placeId: 'catalog-place-1',
      name: '旧缓存地点名',
      coordinates: { lat: 30.5, lng: 120.2, source: 'client-cache' },
      facilityCodes: ['stale-facility'],
      customTags: ['private-tag-from-client'],
      category: 'fake-category',
    },
    startMinutes: 540,
    endMinutes: 600,
    departureMinutes: 600,
  };
}

test('plan saves, plan updates, and trip plan edits replace stale place refs from the directory', async () => {
  const placeProvider: PlaceProvider = {
    providerName: 'canonical-test-directory',
    async search() { return { places: [], empty: true, nextCursor: null }; },
    async detail(placeId) { return placeId === directoryPlace.placeId ? directoryPlace : null; },
  };
  const server = createHttpServer({ seedDemo: false, placeProvider, now: () => '2026-09-20T08:00:00+08:00' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + path, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.ok(response.ok, await response.clone().text());
      return (await response.json() as { data: any }).data;
    };
    const assertCanonicalRef = (stop: any) => {
      assert.equal(stop.placeId, directoryPlace.placeId);
      assert.deepEqual(stop.place, {
        placeId: directoryPlace.placeId,
        name: directoryPlace.name,
        coordinates: directoryPlace.coordinates,
        facilityCodes: directoryPlace.facilityCodes,
        provider: directoryPlace.provider,
        providerPlaceId: directoryPlace.providerPlaceId,
        cityCode: directoryPlace.cityCode,
        dataMode: directoryPlace.dataMode,
        evidenceIds: directoryPlace.evidenceIds,
      });
      assert.equal(JSON.stringify(stop.place).includes('private'), false);
      assert.equal('customTags' in stop.place, false);
      assert.equal('category' in stop.place, false);
    };

    const created = await call('/api/v1/plans', 'POST', {
      kind: 'scheme', name: '目录来源方案', days: [{ dayIndex: 0, stops: [staleStop('scheme-stop')] }],
    });
    let savedPlan = (await call('/api/v1/plans')).find((item: any) => item.id === created.id);
    assertCanonicalRef(savedPlan.days[0].stops[0]);

    await call(`/api/v1/plans/${created.id}`, 'PUT', {
      kind: 'scheme', name: '目录来源方案已更新', days: [{ dayIndex: 0, stops: [staleStop('updated-stop')] }],
    });
    savedPlan = (await call('/api/v1/plans')).find((item: any) => item.id === created.id);
    assertCanonicalRef(savedPlan.days[0].stops[0]);

    const trip = await call('/api/v1/trips', 'POST', { cityCode: '310104', localDate: '2026-09-20', dataMode: 'demo' });
    const tripPath = `/api/v1/trips/${trip.trip.tripId}`;
    await call(`${tripPath}/plan-edits`, 'POST', {
      expectedRevision: trip.trip.revision,
      stops: [staleStop('trip-stop')],
      routeLegs: [],
    });
    const savedTrip = await call(tripPath);
    assertCanonicalRef(savedTrip.snapshot.stops[0]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('plan save keeps a legacy PlaceRef when its place ID is no longer in the directory', async () => {
  const placeProvider: PlaceProvider = {
    providerName: 'empty-test-directory',
    async search() { return { places: [], empty: true, nextCursor: null }; },
    async detail() { return null; },
  };
  const server = createHttpServer({ seedDemo: false, placeProvider });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const guest = await fetch(base + '/api/v1/session/guest', { method: 'POST' });
    const cookie = guest.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(base + '/api/v1/plans', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'scheme', name: '兼容旧地点', days: [{ dayIndex: 0, stops: [{
          stopId: 'legacy-stop', placeId: 'removed-place',
          place: { placeId: 'removed-place', name: '已下架地点', coordinates: { lat: 31, lng: 121, source: 'legacy' }, facilityCodes: [] },
        }] }],
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const created = (await response.json() as { data: { id: string } }).data;
    const list = await fetch(base + '/api/v1/plans', { headers: { cookie } });
    const plans = (await list.json() as { data: any[] }).data;
    assert.equal(plans.find(item => item.id === created.id).days[0].stops[0].place.name, '已下架地点');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
