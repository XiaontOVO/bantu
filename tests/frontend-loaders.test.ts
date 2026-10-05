import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const store = await load('public/lib/store.js');
const loaders = await load('public/lib/loaders.js');
const state = store.state as Record<string, any>;

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('place search returns its first page promptly and exposes later reviewed places through load more', async () => {
  const before = {
    fetch: globalThis.fetch, places: state.places, officialTags: state.officialTags,
    placeQuery: state.placeQuery, placeCategory: state.placeCategory, placeCity: state.placeCity,
    placesCursor: state.placesCursor, placesLoadingMore: state.placesLoadingMore, placeMoreError: state.placeMoreError,
  };
  const urls: string[] = [];
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    urls.push(url.pathname + url.search);
    if (url.pathname === '/api/v1/places') {
      return jsonResponse(url.searchParams.has('cursor')
        ? { data: [{ placeId: 'reviewed-second-page' }], meta: { nextCursor: null } }
        : { data: [{ placeId: 'reviewed-first-page' }], meta: { nextCursor: '50' } });
    }
    if (url.pathname === '/api/v1/place-tags') return jsonResponse({ data: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  state.places = []; state.officialTags = undefined; state.placeQuery = ''; state.placeCategory = '全部'; state.placeCity = '';
  try {
    await loaders.loadPlaces();
    assert.deepEqual(state.places.map((place: any) => place.placeId), ['reviewed-first-page']);
    assert.equal(urls.filter(url => url.startsWith('/api/v1/places?')).length, 1, 'no eager walk through every result page');
    assert.equal(state.placesCursor, '50');
    await loaders.loadMorePlaces();
    assert.deepEqual(state.places.map((place: any) => place.placeId), ['reviewed-first-page', 'reviewed-second-page']);
    assert.equal(urls.filter(url => url.startsWith('/api/v1/places?')).length, 2);
    assert.match(urls.filter(url => url.startsWith('/api/v1/places?'))[1], /cursor=50/);
  } finally {
    globalThis.fetch = before.fetch;
    for (const [key, value] of Object.entries(before)) if (key !== 'fetch') state[key] = value;
  }
});

test('地点标签接口失败时仍保留地点目录', async () => {
  const before = { fetch: globalThis.fetch, places: state.places, officialTags: state.officialTags, placeQuery: state.placeQuery, placeCategory: state.placeCategory, placeCity: state.placeCity };
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/places') return jsonResponse({ data: [{ placeId: 'place-kept' }], meta: { nextCursor: null } });
    if (url.pathname === '/api/v1/place-tags') return new Response(JSON.stringify({ error: { message: 'tag service unavailable' } }), { status: 503 });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  state.places = []; state.officialTags = undefined; state.placeQuery = ''; state.placeCategory = '全部'; state.placeCity = '';
  try {
    await loaders.loadPlaces();
    assert.deepEqual(state.places.map((place: any) => place.placeId), ['place-kept']);
    assert.deepEqual(state.officialTags, []);
  } finally {
    globalThis.fetch = before.fetch;
    for (const [key, value] of Object.entries(before)) if (key !== 'fetch') state[key] = value;
  }
});

test('a stale general chat load cannot replace messages written while its request is pending', async () => {
  const before = {
    fetch: globalThis.fetch,
    trip: state.trip,
    messages: state.messages,
    chatPending: state.chatPending,
  };
  let resolveHistory: ((response: Response) => void) | undefined;
  state.trip = null;
  state.messages = [];
  state.chatPending = false;
  globalThis.fetch = (async () => new Promise<Response>(resolve => { resolveHistory = resolve; })) as typeof fetch;

  try {
    const pendingLoad = loaders.loadGeneralMessages();
    await turn();
    state.messages.push({ role: 'user', text: '刚发出的新消息' });
    resolveHistory?.(jsonResponse({ data: [{ messageId: 'old', role: 'assistant', text: '旧消息' }] }));
    await pendingLoad;
    assert.deepEqual(state.messages.map((message: any) => message.text), ['刚发出的新消息']);
  } finally {
    globalThis.fetch = before.fetch;
    state.trip = before.trip;
    state.messages = before.messages;
    state.chatPending = before.chatPending;
  }
});

test('community search results from an older request cannot replace the latest filter', async () => {
  const before = {
    fetch: globalThis.fetch,
    officialTags: state.officialTags,
    communityQuery: state.communityQuery,
    communityTag: state.communityTag,
    communityCity: state.communityCity,
    communitySort: state.communitySort,
    community: state.community,
    communityCursor: state.communityCursor,
    communityPosts: state.communityPosts,
    postCursor: state.postCursor,
    communityMine: state.communityMine,
    planShares: state.planShares,
  };
  const pending = new Map<string, (response: Response) => void>();
  state.officialTags = [];
  state.communityTag = '';
  state.communityCity = '';
  state.communitySort = 'newest';
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/community/places') {
      const query = url.searchParams.get('query') || '';
      return new Promise<Response>(resolve => pending.set(query, resolve));
    }
    return jsonResponse({ data: [], meta: { nextCursor: null } });
  }) as typeof fetch;

  try {
    state.communityQuery = '旧关键词';
    const older = loaders.loadCommunity(false);
    await turn();
    state.communityQuery = '新关键词';
    const newer = loaders.loadCommunity(false);
    await turn();

    pending.get('新关键词')?.(jsonResponse({ data: [{ id: 'new-result' }], meta: { nextCursor: null } }));
    await newer;
    pending.get('旧关键词')?.(jsonResponse({ data: [{ id: 'old-result' }], meta: { nextCursor: null } }));
    await older;

    assert.deepEqual(state.community.map((item: any) => item.id), ['new-result']);
  } finally {
    globalThis.fetch = before.fetch;
    for (const [key, value] of Object.entries(before)) if (key !== 'fetch') state[key] = value;
  }
});

test('方案分享接口失败时社区帖子仍然可以显示', async () => {
  const before = {
    fetch: globalThis.fetch,
    officialTags: state.officialTags,
    communityQuery: state.communityQuery,
    communityTag: state.communityTag,
    communityCity: state.communityCity,
    communitySort: state.communitySort,
    community: state.community,
    communityPosts: state.communityPosts,
    communityMine: state.communityMine,
    planShares: state.planShares,
  };
  state.officialTags = [];
  state.communityQuery = ''; state.communityTag = ''; state.communityCity = ''; state.communitySort = 'newest';
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/community/posts') return jsonResponse({ data: [{ id: 'post-visible' }], meta: { nextCursor: null } });
    if (url.pathname === '/api/v1/community/mine') return jsonResponse({ data: { posts: [], places: [], planShares: [] } });
    if (url.pathname === '/api/v1/community/plan-shares') return new Response(JSON.stringify({ error: { message: 'share service unavailable' } }), { status: 503 });
    if (url.pathname === '/api/v1/community/places') return jsonResponse({ data: [], meta: { nextCursor: null } });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    await loaders.loadCommunity(false);
    assert.deepEqual(state.communityPosts.map((post: any) => post.id), ['post-visible']);
  } finally {
    globalThis.fetch = before.fetch;
    for (const [key, value] of Object.entries(before)) if (key !== 'fetch') state[key] = value;
  }
});

test('地点标签接口失败时社区帖子仍然可以显示', async () => {
  const before = {
    fetch: globalThis.fetch,
    officialTags: state.officialTags,
    communityQuery: state.communityQuery,
    communityTag: state.communityTag,
    communityCity: state.communityCity,
    communitySort: state.communitySort,
    community: state.community,
    communityPosts: state.communityPosts,
    communityMine: state.communityMine,
    planShares: state.planShares,
  };
  state.officialTags = undefined;
  state.communityQuery = ''; state.communityTag = ''; state.communityCity = ''; state.communitySort = 'newest';
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/place-tags') return new Response(JSON.stringify({ error: { message: 'tag service unavailable' } }), { status: 503 });
    if (url.pathname === '/api/v1/community/posts') return jsonResponse({ data: [{ id: 'post-without-tags' }], meta: { nextCursor: null } });
    if (url.pathname === '/api/v1/community/mine') return jsonResponse({ data: { posts: [], places: [], planShares: [] } });
    if (url.pathname === '/api/v1/community/plan-shares') return jsonResponse({ data: [], meta: { nextCursor: null } });
    if (url.pathname === '/api/v1/community/places') return jsonResponse({ data: [], meta: { nextCursor: null } });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    await loaders.loadCommunity(false);
    assert.deepEqual(state.communityPosts.map((post: any) => post.id), ['post-without-tags']);
    assert.deepEqual(state.officialTags, []);
  } finally {
    globalThis.fetch = before.fetch;
    for (const [key, value] of Object.entries(before)) if (key !== 'fetch') state[key] = value;
  }
});

test('一个收藏接口失败时另一个收藏源仍然可以加载', async () => {
  const favorites = await load('public/lib/favorites.js');
  const before = { fetch: globalThis.fetch, favorites: state.favorites, postFavorites: state.postFavorites };
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/favorites') return new Response(JSON.stringify({ error: { message: 'place favorites unavailable' } }), { status: 503 });
    if (url.pathname === '/api/v1/community/post-favorites') return jsonResponse({ data: [{ post: { postId: 'post-kept' } }] });
    if (url.pathname === '/api/v1/plans') return jsonResponse({ data: [], meta: { nextCursor: null } });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    await favorites.loadFavorites();
    assert.deepEqual(state.postFavorites.map((entry: any) => entry.post.postId), ['post-kept']);
  } finally {
    globalThis.fetch = before.fetch;
    state.favorites = before.favorites;
    state.postFavorites = before.postFavorites;
  }
});

test('rapid memory pagination appends a cursor page only once', async () => {
  const before = {
    fetch: globalThis.fetch,
    trip: state.trip,
    memories: state.memories,
    memoryCursor: state.memoryCursor,
  };
  let calls = 0;
  let resolvePage: ((response: Response) => void) | undefined;
  state.trip = { trip: { tripId: 'trip_memory_page' } };
  state.memories = [{ memoryId: 'first-page' }];
  state.memoryCursor = 2;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Promise<Response>(resolve => { resolvePage = resolve; });
  }) as typeof fetch;

  try {
    const first = loaders.loadMemories(true);
    const second = loaders.loadMemories(true);
    assert.equal(calls, 1, 'a pending cursor request is reused');
    resolvePage?.(jsonResponse({ data: [{ memoryId: 'second-page' }], meta: { nextCursor: null } }));
    await Promise.all([first, second]);
    assert.deepEqual(state.memories.map((item: any) => item.memoryId), ['first-page', 'second-page']);
  } finally {
    globalThis.fetch = before.fetch;
    state.trip = before.trip;
    state.memories = before.memories;
    state.memoryCursor = before.memoryCursor;
  }
});

test('rapid post pagination issues one request and does not duplicate entries', async () => {
  const journal = await load('public/lib/travel-journal.js');
  const before = {
    fetch: globalThis.fetch,
    document: (globalThis as any).document,
    currentView: state.currentView,
    principal: state.principal,
    trip: state.trip,
    communityPosts: state.communityPosts,
    postCursor: state.postCursor,
  };
  let calls = 0;
  let resolvePage: ((response: Response) => void) | undefined;
  const elements = new Map<string, any>();
  for (const id of ['pageTitle', 'pageSubtitle', 'sidebarTrip', 'view']) elements.set(id, { innerHTML: '', textContent: '' });
  (globalThis as any).document = {
    getElementById: (id: string) => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  state.currentView = 'community';
  state.principal = null;
  state.trip = null;
  state.communityPosts = [{ id: 'first-page' }];
  state.postCursor = 2;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Promise<Response>(resolve => { resolvePage = resolve; });
  }) as typeof fetch;

  try {
    const first = journal.morePosts();
    const second = journal.morePosts();
    assert.equal(calls, 1, 'a pending post page request is reused');
    resolvePage?.(jsonResponse({ data: [{ id: 'second-page' }], meta: { nextCursor: null } }));
    await Promise.all([first, second]);
    assert.deepEqual(state.communityPosts.map((post: any) => post.id), ['first-page', 'second-page']);
  } finally {
    globalThis.fetch = before.fetch;
    (globalThis as any).document = before.document;
    state.currentView = before.currentView;
    state.principal = before.principal;
    state.trip = before.trip;
    state.communityPosts = before.communityPosts;
    state.postCursor = before.postCursor;
  }
});
