import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (relativePath: string) =>
  import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;

const { state } = await load('public/lib/store.js');
const favorites = await load('public/lib/favorites.js');
const { toggleFavorite, loadFavorites } = favorites;
const { togglePostFavorite } = await load('public/lib/community.js');
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const jsonResponse = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });

test('a stale unselected favorite button adds the place instead of toggling off server state', async () => {
  const before = {
    fetch: globalThis.fetch,
    document: (globalThis as any).document,
    window: (globalThis as any).window,
    favorites: state.favorites,
    favoritePending: state.favoritePending,
    currentView: state.currentView,
  };
  const elements = new Map<string, any>();
  for (const id of ['pageTitle', 'pageSubtitle', 'sidebarTrip', 'view', 'toast', 'appbarTime', 'appbarPlace', 'trip-clock']) {
    elements.set(id, { textContent: '', innerHTML: '', className: '', setAttribute() {}, removeAttribute() {} });
  }
  (globalThis as any).document = {
    activeElement: null,
    getElementById: (id: string) => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  (globalThis as any).window = {};
  state.favorites = [];
  state.favoritePending = null;
  state.currentView = 'home';
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input, options = {}) => {
    requests.push({ path: new URL(String(input), 'http://localhost').pathname, method: options.method || 'GET' });
    return new Response(JSON.stringify({ data: [{ kind: 'place', place: { placeId: 'place_saved_in_other_tab' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await toggleFavorite('place_saved_in_other_tab');
    assert.deepEqual(requests, [{ path: '/api/v1/favorites', method: 'POST' }]);
    assert.equal(state.favorites[0].place.placeId, 'place_saved_in_other_tab');
  } finally {
    globalThis.fetch = before.fetch;
    (globalThis as any).document = before.document;
    (globalThis as any).window = before.window;
    state.favorites = before.favorites;
    state.favoritePending = before.favoritePending;
    state.currentView = before.currentView;
  }
});

test('an in-flight stale post-favorites read cannot undo a successful un-favorite', async () => {
  const before = {
    fetch: globalThis.fetch,
    document: (globalThis as any).document,
    window: (globalThis as any).window,
    favorites: state.favorites,
    postFavorites: state.postFavorites,
    principal: state.principal,
    currentView: state.currentView,
  };
  const elements = new Map<string, any>();
  for (const id of ['pageTitle', 'pageSubtitle', 'sidebarTrip', 'view', 'toast', 'appbarTime', 'appbarPlace', 'trip-clock']) {
    elements.set(id, { textContent: '', innerHTML: '', className: '', setAttribute() {}, removeAttribute() {} });
  }
  (globalThis as any).document = {
    activeElement: null,
    getElementById: (id: string) => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  (globalThis as any).window = {};
  state.favorites = [];
  state.postFavorites = [{ post: { postId: 'post_1', title: '已收藏' } }];
  state.principal = { kind: 'account' };
  state.currentView = 'home';
  let resolveOldRead: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (input, options = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = options.method || 'GET';
    if (url.pathname === '/api/v1/favorites') return jsonResponse([]);
    if (url.pathname === '/api/v1/community/post-favorites' && method === 'GET') {
      return new Promise<Response>(resolve => { resolveOldRead = resolve; });
    }
    if (url.pathname === '/api/v1/community/posts/post_1/favorite' && method === 'DELETE') {
      return jsonResponse({ favorited: false, postFavorites: [] });
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  }) as typeof fetch;

  try {
    const oldRead = loadFavorites();
    await turn();
    assert.ok(resolveOldRead, 'the old favorites read should be pending');
    await togglePostFavorite({ dataset: { post: 'post_1' } });
    assert.equal(state.postFavorites.length, 0);
    resolveOldRead(jsonResponse([{ post: { postId: 'post_1', title: '已收藏' } }]));
    await oldRead;
    assert.equal(state.postFavorites.length, 0, 'stale server data must not put the removed favorite back');
  } finally {
    globalThis.fetch = before.fetch;
    (globalThis as any).document = before.document;
    (globalThis as any).window = before.window;
    state.favorites = before.favorites;
    state.postFavorites = before.postFavorites;
    state.principal = before.principal;
    state.currentView = before.currentView;
  }
});

test('a repeated post-favorite click while the request is pending sends only one mutation', async () => {
  const before = {
    fetch: globalThis.fetch,
    document: (globalThis as any).document,
    window: (globalThis as any).window,
    postFavorites: state.postFavorites,
    principal: state.principal,
    currentView: state.currentView,
    communityPosts: state.communityPosts,
    communityMine: state.communityMine,
  };
  const elements = new Map<string, any>();
  for (const id of ['pageTitle', 'pageSubtitle', 'sidebarTrip', 'view', 'toast', 'appbarTime', 'appbarPlace', 'trip-clock']) {
    elements.set(id, { textContent: '', innerHTML: '', className: '', setAttribute() {}, removeAttribute() {} });
  }
  (globalThis as any).document = {
    activeElement: null,
    getElementById: (id: string) => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  (globalThis as any).window = {};
  state.postFavorites = [];
  state.principal = { kind: 'account' };
  state.currentView = 'home';
  state.communityPosts = [];
  state.communityMine = null;
  let resolvePost: ((response: Response) => void) | undefined;
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input, options = {}) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push({ path: url.pathname, method: options.method || 'GET' });
    return new Promise<Response>(resolve => { resolvePost = resolve; });
  }) as typeof fetch;

  try {
    const makeButton = () => ({ dataset: { post: 'post_rapid' }, disabled: false, setAttribute() {}, removeAttribute() {} });
    const first = togglePostFavorite(makeButton());
    await turn();
    assert.deepEqual(requests, [{ path: '/api/v1/community/posts/post_rapid/favorite', method: 'POST' }]);

    await togglePostFavorite(makeButton());
    assert.equal(requests.length, 1, 'same-post mutations must be serialized while the first request is pending');

    assert.ok(resolvePost);
    resolvePost(jsonResponse({ favorited: true, postFavorites: [{ post: { postId: 'post_rapid', title: '帖' } }] }));
    await first;
    assert.equal(state.postFavorites.length, 1);
    assert.equal(state.postFavorites[0].post.postId, 'post_rapid');
  } finally {
    globalThis.fetch = before.fetch;
    (globalThis as any).document = before.document;
    (globalThis as any).window = before.window;
    state.postFavorites = before.postFavorites;
    state.principal = before.principal;
    state.currentView = before.currentView;
    state.communityPosts = before.communityPosts;
    state.communityMine = before.communityMine;
  }
});
