import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

test('map data loader follows place pagination cursors', async () => {
  const { state } = await load('public/lib/store.js');
  const mapActions = await load('public/lib/map.js');
  const originalFetch = globalThis.fetch;
  const previous = {
    trip: state.trip,
    mapPlaces: state.mapPlaces,
    mapConfig: state.mapConfig,
    favorites: state.favorites,
    postFavorites: state.postFavorites,
  };
  const requestedPlaceUrls: string[] = [];
  const firstPage = Array.from({ length: 50 }, (_, index) => ({ placeId: `place_${index}` }));
  const lastPage = [{ placeId: 'place_50' }];
  state.trip = null;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('/api/v1/places?')) {
      requestedPlaceUrls.push(url);
      return new Response(JSON.stringify(requestedPlaceUrls.length === 1
        ? { data: firstPage, meta: { nextCursor: 'page-2' } }
        : { data: lastPage, meta: {} }), { status: 200 });
    }
    if (url === '/api/v1/favorites' || url === '/api/v1/community/post-favorites') {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url === '/api/v1/map-config') {
      return new Response(JSON.stringify({ data: { onlineRoutes: false } }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    await mapActions.loadMapData();
    assert.equal(requestedPlaceUrls.length, 2);
    assert.match(requestedPlaceUrls[0], /cityCode=310100/);
    assert.match(requestedPlaceUrls[0], /districtAdcode=310104/);
    assert.match(requestedPlaceUrls[1], /cursor=page-2/);
    assert.equal(state.mapPlaces.length, 51);
    assert.equal(state.mapPlaces.at(-1).placeId, 'place_50');
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(state, previous);
  }
});
