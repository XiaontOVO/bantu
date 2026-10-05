import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (file: string) => import(pathToFileURL(join(process.cwd(), file)).href) as Promise<Record<string, any>>;
const { state } = await load('public/lib/store.js');
const { renderPlaces } = await load('public/views/places.js');
const search = await load('public/lib/place-search.js');
const loaders = await load('public/lib/loaders.js');
const json = (data: unknown) => new Response(JSON.stringify({ data, meta: { nextCursor: null } }));

function setup() {
  const previous = { ...state }, browser = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const nodes: Record<string, any> = {
    pageTitle: {}, pageSubtitle: {}, sidebarTrip: {}, view: {}, placeSearch: { value: '武康' },
  };
  globalThis.document = { activeElement: null, getElementById: (id: string) => nodes[id] || null,
    querySelector: () => null, querySelectorAll: () => [] } as unknown as Document;
  globalThis.window = {} as Window & typeof globalThis;
  Object.assign(state, { currentView: 'places', principal: { kind: 'guest', principalId: 'place-reader' }, trip: null,
    officialTags: [], communityPosts: [], communityMine: { places: [], posts: [] }, favorites: [], savedPlans: [],
    placeQuery: '武康', communityQuery: '武康', placeCategory: '全部', placeCity: '310100', communityCity: '310100',
    communitySort: 'rating', placeAdvanced: { facilities: [], cost: '', duration: '', rating: '' }, loadStatus: {},
    places: [{ placeId: 'wukang', name: '武康大楼', category: 'landmark', facilityCodes: ['outdoor'], tags: [],
      costEstimate: { lowerMinor: 0, upperMinor: 0 }, suggestedDurationMinutes: 60, reviews: [], cityCode: '310100' }] });
  globalThis.fetch = (async (path: string) => json(path === '/api/v1/community/mine' ? { places: [], posts: [] } : [])) as typeof fetch;
  return { nodes, restore() { Object.assign(state, previous); Object.assign(globalThis, browser); } };
}

test('directory count follows the visible results after advanced filters, including zero matches', () => {
  const h = setup();
  try {
    assert.match(renderPlaces(), /role="status">1 个地点/);
    state.placeAdvanced.cost = 'paid';
    const empty = renderPlaces();
    assert.match(empty, /role="status">0 个地点/);
    assert.doesNotMatch(empty, /class="place-card/);
    assert.match(empty, /data-action="clear-place-search"/);
    assert.match(empty, /data-action="relax-place-filters"/);
    state.placeAdvanced.cost = ''; state.placeAdvanced.facilities = ['indoor'];
    assert.match(renderPlaces(), /role="status">0 个地点/);
  } finally { h.restore(); }
});

test('pending and failed queries do not present stale cards or claim zero search results', () => {
  const h = setup();
  try {
    for (const status of ['loading', 'error']) {
      state.loadStatus.places = { status, message: '网络不可用' };
      const html = renderPlaces();
      assert.doesNotMatch(html, /class="place-card|没有符合当前条件|0 个地点/);
      assert.match(html, status === 'loading' ? /查询中/ : /暂未加载/);
      assert.match(html, /value="武康"/);
    }
  } finally { h.restore(); }
});

test('relaxing filters retains the city, keyword and ordering; clearing search retains the filters', async () => {
  const h = setup(); const urls: URL[] = [];
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (path: string, options: any) => { urls.push(new URL(path, 'http://localhost')); return originalFetch(path, options); }) as typeof fetch;
    state.placeCategory = 'landmark'; state.communityTag = 'landmark';
    state.placeAdvanced = { facilities: ['indoor'], cost: 'paid', duration: 'short', rating: '4' };
    await search.relaxPlaceFilters();
    assert.equal(state.placeQuery, '武康'); assert.equal(state.placeCity, '310100'); assert.equal(state.communitySort, 'rating');
    assert.equal(state.placeCategory, '全部'); assert.equal(state.communityTag, '');
    assert.deepEqual(state.placeAdvanced, { facilities: [], cost: '', duration: '', rating: '' });
    let request = urls.filter(url => url.pathname === '/api/v1/places').at(-1)!;
    assert.equal(request.searchParams.get('query'), '武康'); assert.equal(request.searchParams.get('cityCode'), '310100');
    assert.equal(request.searchParams.get('tag'), '');
    state.placeAdvanced.cost = 'paid'; state.placeCategory = 'culture';
    await search.clearPlaceSearch();
    assert.equal(h.nodes.placeSearch.value, ''); assert.equal(state.placeQuery, ''); assert.equal(state.communityQuery, '');
    assert.equal(state.placeAdvanced.cost, 'paid'); assert.equal(state.placeCategory, 'culture'); assert.equal(state.placeCity, '310100');
    request = urls.filter(url => url.pathname === '/api/v1/places').at(-1)!;
    assert.equal(request.searchParams.get('query'), ''); assert.equal(request.searchParams.get('tag'), 'culture');
  } finally { h.restore(); }
});

test('a failed directory query preserves the keyword and filters and exposes a retryable error', async () => {
  const h = setup();
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (path: string, options: any) => {
      if (path.startsWith('/api/v1/places?')) throw new TypeError('Failed to fetch');
      return originalFetch(path, options);
    }) as typeof fetch;
    state.placeAdvanced.cost = 'paid';
    await search.refreshPlaceSearch();
    assert.equal(state.loadStatus.places.status, 'error');
    assert.match(state.loadStatus.places.message, /检查网络.*搜索与筛选已保留/);
    assert.equal(state.placeQuery, '武康'); assert.equal(state.placeAdvanced.cost, 'paid');
    assert.match(h.nodes.view.innerHTML, /data-action="retry-current-view"/);
    assert.doesNotMatch(h.nodes.view.innerHTML, /没有符合当前条件的地点/);
  } finally { h.restore(); }
});

test('a late directory response cannot apply another principal’s places or private tags', async () => {
  const h = setup();
  try {
    let complete: (response: Response) => void = () => {};
    globalThis.fetch = (async () => await new Promise<Response>(resolve => { complete = resolve; })) as typeof fetch;
    const pending = loaders.loadPlaces();
    state.principal = { kind: 'guest', principalId: 'new-reader' }; state.places = []; state.officialTags = [];
    complete(json([{ placeId: 'old-private-tags', name: '旧页面地点', tags: [{ label: '旧账号私人标签' }] }]));
    await pending;
    assert.deepEqual(state.places, []); assert.deepEqual(state.officialTags, []);
  } finally { h.restore(); }
});

test('search returns one page without community side loads, then reuses pending pagination and keeps cards on failure', async () => {
  const h = setup();
  try {
    const requests: string[] = [];
    let finish: (response: Response) => void = () => {};
    let rejectPage: (error: Error) => void = () => {};
    globalThis.fetch = (async (path: string) => {
      requests.push(path);
      if (new URL(path, 'http://localhost').searchParams.has('cursor')) return new Promise<Response>((resolve, reject) => { finish = resolve; rejectPage = reject; });
      return new Response(JSON.stringify({ data: [{ placeId: 'first', name: '武康大楼' }], meta: { nextCursor: 24 } }));
    }) as typeof fetch;
    await search.refreshPlaceSearch();
    assert.equal(requests.length, 1); assert.match(requests[0], /limit=24/);
    assert.equal(state.loadStatus.places.status, 'loaded'); assert.equal(state.placesCursor, 24);
    const a = loaders.loadMorePlaces(), b = loaders.loadMorePlaces();
    assert.equal(requests.length, 2); assert.equal(state.placesLoadingMore, true);
    finish(new Response(JSON.stringify({ data: [{ placeId: 'first' }, { placeId: 'second', name: '武康路' }], meta: { nextCursor: 48 } })));
    await Promise.all([a, b]);
    assert.deepEqual(state.places.map((p: any) => p.placeId), ['first', 'second']);
    const failed = loaders.loadMorePlaces(); rejectPage(new Error('暂时离线')); await assert.rejects(failed, /暂时离线/);
    assert.deepEqual(state.places.map((p: any) => p.placeId), ['first', 'second']);
    assert.equal(state.placesCursor, 48); assert.equal(state.placesLoadingMore, false); assert.match(state.placeMoreError, /暂时离线/);
  } finally { h.restore(); }
});

test('identical pending searches share one request and a new keyword aborts the old one without applying its response', async () => {
  const h = setup();
  try {
    const pending: Array<{ signal: AbortSignal; finish: (response: Response) => void }> = [];
    globalThis.fetch = (async (_path: string, options: any) => new Promise<Response>(finish => { pending.push({ signal: options.signal, finish }); })) as typeof fetch;
    const old = loaders.loadPlaces(), same = loaders.loadPlaces(); assert.equal(pending.length, 1); assert.equal(old, same);
    state.placeQuery = '徐汇'; const current = loaders.loadPlaces();
    assert.equal(pending[0].signal.aborted, true);
    pending[1].finish(json([{ placeId: 'latest' }])); await current;
    pending[0].finish(json([{ placeId: 'stale' }])); await old;
    assert.deepEqual(state.places.map((p: any) => p.placeId), ['latest']);
  } finally { h.restore(); }
});
