import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DemoPlace } from '../src/demo/demo-data.js';
import { AmapPlaceProvider } from '../src/providers/amap.js';
import { DemoPlaceProvider, type PlaceProvider, type PlaceSearchInput } from '../src/providers/travel.js';
import { CommunityService, communityPlaceProvider } from '../src/services/community-service.js';
import { createHttpServer } from '../src/server/http-server.js';

function place(index: number, prefix = 'catalog'): DemoPlace {
  return {
    placeId: `${prefix}_${index}`,
    name: `${prefix} 地点 ${index}`,
    category: 'culture',
    cityCode: '330100',
    coordinates: null,
    facilityCodes: [],
    evidenceIds: [],
    suggestedDurationMinutes: 60,
    openingIntervals: [],
  };
}

test('places API forwards numeric cursors and returns later pages beyond the first 50', async () => {
  const catalog = Array.from({ length: 73 }, (_, index) => place(index));
  const calls: Array<{ offset: number; limit: number }> = [];
  const provider: PlaceProvider = {
    providerName: 'fixture_catalog',
    async search(input: PlaceSearchInput) {
      const offset = input.offset ?? 0;
      const limit = Math.min(input.limit ?? 50, 50);
      calls.push({ offset, limit: input.limit ?? 0 });
      const places = catalog.slice(offset, offset + limit);
      const nextCursor = offset + places.length < catalog.length ? offset + places.length : null;
      return { places, empty: places.length === 0, nextCursor };
    },
    async detail() { return null; },
  };
  const server = createHttpServer({ seedDemo: false, placeProvider: provider });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const firstResponse = await fetch(`${baseUrl}/api/v1/places?limit=50`);
    const first = await firstResponse.json() as { data: Array<{ placeId: string }>; meta: { nextCursor: number | null } };
    assert.equal(first.data.length, 50);
    assert.equal(first.meta.nextCursor, 50);

    const secondResponse = await fetch(`${baseUrl}/api/v1/places?limit=50&cursor=${first.meta.nextCursor}`);
    const second = await secondResponse.json() as { data: Array<{ placeId: string }>; meta: { nextCursor: number | null } };
    assert.equal(second.data.length, 23);
    assert.equal(second.meta.nextCursor, null);
    assert.deepEqual([...first.data, ...second.data].map(item => item.placeId), catalog.map(item => item.placeId));
    assert.ok(calls.some(call => call.offset === 50), 'the route passes cursor=50 through to its provider');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('community places and AMap results share a cursor while AMap fetches in pages of 25', async () => {
  const requestedPages: number[] = [];
  const amapData = Array.from({ length: 55 }, (_, index) => ({
    id: `poi_${index}`,
    name: `散步地点 ${index}`,
    type: '风景名胜',
    citycode: '330100',
    location: '120.15,30.25',
  }));
  const amap = new AmapPlaceProvider({
    apiKey: 'test',
    fetchImpl: (async input => {
      const url = new URL(String(input));
      requestedPages.push(Number(url.searchParams.get('page')));
      assert.equal(url.searchParams.get('offset'), '25', 'each AMap request uses its 25-result maximum');
      const page = Number(url.searchParams.get('page'));
      const start = (page - 1) * 25;
      return new Response(JSON.stringify({ status: '1', count: '55', pois: amapData.slice(start, start + 25) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  const shared = [place(0, '旅人分享'), place(1, '旅人分享'), place(2, '旅人分享')]
    .map((item, index) => ({ ...item, name: `散步社区地点 ${index}`, provider: 'community_reviewed' }));
  const community = {
    hasMatchingTag: () => false,
    approvedPlaces: (input?: PlaceSearchInput) => input?.query
      ? shared.filter(item => item.name.includes(input.query!))
      : shared,
    myTags: () => [],
  } as unknown as CommunityService;
  const provider = communityPlaceProvider(amap, community, undefined, new DemoPlaceProvider());

  const first = await provider.search({ cityCode: '330100', query: '散步', limit: 30, offset: 0 });
  assert.equal(first.places.length, 30);
  assert.equal(first.nextCursor, 30);
  assert.deepEqual(first.places.slice(0, 3).map(item => item.name), shared.map(item => item.name));
  assert.deepEqual(first.places.slice(3).map(item => item.placeId), Array.from({ length: 27 }, (_, i) => `amap_poi_${i}`));

  const second = await provider.search({ cityCode: '330100', query: '散步', limit: 30, offset: first.nextCursor! });
  assert.equal(second.places.length, 28);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.places.map(item => item.placeId), Array.from({ length: 28 }, (_, i) => `amap_poi_${i + 27}`));
  assert.deepEqual(requestedPages, [1, 2, 3], 'overlapping AMap page 2 is reused');
});
