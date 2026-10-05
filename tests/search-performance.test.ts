import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AmapPlaceProvider } from '../src/providers/amap.js';
import { communityPlaceProvider, type CommunityService } from '../src/services/community-service.js';

const pois = Array.from({ length: 150 }, (_, i) => ({ id: `poi_${i}`, name: `散步地点 ${i}`, type: '风景名胜', location: '121.44,31.20', adcode: '310104' }));
const community = (own: any[] = []) => ({ approvedPlaces: () => own, hasMatchingTag: () => false, myTags: (_id: string, actor: string) => actor ? [`${actor}的私有标签`] : [] }) as unknown as CommunityService;

test('a 24-result directory query needs one upstream page, and overlapping/repeated searches reuse it', async () => {
  const pages: number[] = [];
  const amap = new AmapPlaceProvider({ apiKey: 'test', fetchImpl: async input => {
    const url = new URL(String(input)), page = Number(url.searchParams.get('page')); pages.push(page);
    return Response.json({ status: '1', count: '150', pois: pois.slice((page - 1) * 25, page * 25) });
  } });
  const provider = communityPlaceProvider(amap, community());
  const input = { cityCode: '310100', query: '散步', limit: 24 };
  const first = await provider.search({ ...input, actorId: 'alice' });
  assert.equal(first.places.length, 24); assert.equal(first.nextCursor, 24); assert.deepEqual(pages, [1]);
  const repeated = await provider.search({ ...input, actorId: 'bob' });
  assert.deepEqual(pages, [1], 'same public source data does not issue another HTTP request');
  assert.deepEqual(first.places[0].customTags, ['alice的私有标签']);
  assert.deepEqual(repeated.places[0].customTags, ['bob的私有标签']);
  first.places[0].coordinates!.lat = 0;
  const unaffected = await provider.search(input);
  assert.equal(unaffected.places[0].coordinates!.lat, 31.2, 'callers cannot mutate cached public results');
  const next = await provider.search({ ...input, offset: first.nextCursor! });
  assert.equal(next.places.length, 24); assert.equal(next.nextCursor, 48); assert.deepEqual(pages, [1, 2]);
  assert.equal(next.places[0].placeId, 'amap_poi_24');
});

test('concurrent identical upstream requests are coalesced; provider failures are retried rather than cached', async () => {
  let calls = 0, release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const amap = new AmapPlaceProvider({ apiKey: 'test', fetchImpl: async () => {
    calls++; await wait; return Response.json({ status: '1', count: '1', pois: pois.slice(0, 1) });
  } });
  const a = amap.search({ cityCode: '310100', query: '散步', limit: 24 });
  const b = amap.search({ cityCode: '310100', query: '散步', limit: 24 });
  assert.equal(calls, 1); release(); assert.deepEqual(await a, await b);
  let retry = 0;
  const flaky = new AmapPlaceProvider({ apiKey: 'test', fetchImpl: async () => {
    retry++; return retry === 1 ? Response.json({ status: '0', infocode: '10003', info: 'limit' }) : Response.json({ status: '1', count: '1', pois: pois.slice(0, 1) });
  } });
  assert.equal((await flaky.search({ cityCode: '310100', query: '散步' })).error?.code, 'AMAP_10003');
  assert.equal((await flaky.search({ cityCode: '310100', query: '散步' })).places.length, 1);
  assert.equal(retry, 2);
});

test('an exact full page of reviewed community places keeps the cursor for remaining provider results', async () => {
  const own = pois.slice(0, 24).map((p, i) => ({ placeId: `own_${i}`, name: p.name, category: 'landmark', coordinates: null, facilityCodes: [], openingIntervals: [], evidenceIds: [], suggestedDurationMinutes: 60 }));
  const amap = new AmapPlaceProvider({ apiKey: 'test', fetchImpl: async () => Response.json({ status: '1', count: '1', pois: pois.slice(0, 1) }) });
  const provider = communityPlaceProvider(amap, community(own));
  const first = await provider.search({ cityCode: '310100', query: '散步', limit: 24 });
  assert.equal(first.places.length, 24); assert.equal(first.nextCursor, 24);
  const last = await provider.search({ cityCode: '310100', query: '散步', limit: 24, offset: 24 });
  assert.equal(last.places[0].placeId, 'amap_poi_0'); assert.equal(last.nextCursor, null);
});
