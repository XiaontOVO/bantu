import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';

const { encodePlanCode } = await import(pathToFileURL(join(process.cwd(), 'public', 'lib', 'plan-code.js')).href) as {
  encodePlanCode: (plan: unknown) => string;
};

async function startServer() {
  const store = new MemoryStateStore();
  const server = createHttpServer({ seedDemo: false, stateStore: store });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { server, base, close };
}

async function register(base: string, username: string) {
  const guest = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
  const guestCookie = guest.headers.get('set-cookie')!.split(';')[0];
  const response = await fetch(`${base}/api/v1/account/register`, {
    method: 'POST',
    headers: { cookie: guestCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function call(base: string, path: string, cookie: string, method = 'GET', data?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, ...(await response.json() as any) };
}

test('plan shares expose multiple API pages and the client appends them with an independent cursor', async () => {
  const { base, close } = await startServer();
  try {
    const author = await register(base, 'share_pager');
    for (let index = 0; index < 22; index += 1) {
      const name = `分页方案 ${index}`;
      const code = encodePlanCode({
        name, cityCode: '330100', cityLabel: '杭州',
        stops: [{ name: `地点 ${index}`, coordinates: { lat: 30.25, lng: 120.15 }, durationMinutes: 60 }],
      });
      const response = await call(base, '/api/v1/community/plan-shares', author, 'POST', {
        code, name, cityLabel: '杭州', cityCode: '330100', stopCount: 1, nickname: '分页旅人',
      });
      assert.equal(response.status, 200);
    }

    const first = await call(base, '/api/v1/community/plan-shares?limit=20', author);
    assert.equal(first.data.length, 20);
    assert.equal(first.meta.nextCursor, 20);
    const second = await call(base, `/api/v1/community/plan-shares?limit=20&cursor=${first.meta.nextCursor}`, author);
    assert.equal(second.data.length, 2);
    assert.equal(second.meta.nextCursor, null);
    assert.equal(new Set([...first.data, ...second.data].map((share: any) => share.id)).size, 22);
  } finally {
    await close();
  }
});

test('a malformed historical plan share does not take down the public share list', async () => {
  const store = new MemoryStateStore();
  store.set('bantu-trip-service:community', JSON.stringify({
    posts: [], discoveries: [], contributions: {}, planShares: [{
      id: 'share-corrupt', authorId: 'legacy-author', code: 'BT1-corrupt',
      name: '旧方案', cityCode: '310100', cityLabel: '上海', stopCount: 1,
      nickname: '旧旅人', createdAt: '2026-09-20T00:00:00.000Z',
    }], placeReviews: {}, retiredPlaceIds: [],
  }));
  const server = createHttpServer({ seedDemo: false, stateStore: store });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = await fetch(`${base}/api/v1/session/guest`, { method: 'POST' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${base}/api/v1/community/plan-shares`, { headers: { cookie } });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].cityLabel, '上海', '无法解析旧方案时保留已保存的城市元数据');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('post search includes older public posts and author names while excluding private posts even for their author', async () => {
  const {base,close}=await startServer();
  try {
    const author=await register(base,'post_search_author'),reader=await register(base,'post_search_reader');
    const target=await call(base,'/api/v1/community/posts',author,'POST',{text:'深秋梧桐\n街角的记忆'});
    const privatePost=await call(base,'/api/v1/community/posts',author,'POST',{text:'深秋梧桐 · 私人记录',visibility:'private'});
    for(let index=0;index<25;index++)await call(base,'/api/v1/community/posts',author,'POST',{text:`日常散步 ${index}`});
    assert.ok(!(await call(base,'/api/v1/community/posts?stable=1',reader)).data.some((p:any)=>p.id===target.data.id));
    for(const cookie of [author,reader]) {
      const found=await call(base,'/api/v1/community/posts?stable=1&query='+encodeURIComponent(' 深秋梧桐 '),cookie);
      assert.equal(found.status,200);assert.deepEqual(found.data.map((p:any)=>p.id),[target.data.id]);assert.equal(found.meta.nextCursor,null);
      assert.ok(!(await call(base,'/api/v1/community/posts?stable=1&query=POST_SEARCH_AUTHOR',cookie)).data.some((p:any)=>p.id===privatePost.data.id));
    }
    const byName=await call(base,'/api/v1/community/posts?stable=1&query=POST_SEARCH_AUTHOR&limit=50',reader);
    assert.equal(byName.data.length,26);
    assert.ok((await call(base,'/api/v1/community/mine',author)).data.posts.some((p:any)=>p.id===privatePost.data.id));
  } finally {await close();}
});

test('post search cursors bind the normalized query and long JSON searches preserve privacy and stable ordering',async()=>{
  const {base,close}=await startServer();
  try {
    const author=await register(base,'post_long_search');const query='梧桐'.repeat(200);
    for(let index=0;index<4;index++)await call(base,'/api/v1/community/posts',author,'POST',{text:`${query}\n记录 ${index}`});
    await call(base,'/api/v1/community/posts',author,'POST',{text:query,visibility:'private'});
    const first=await call(base,'/api/v1/community/posts/search?limit=2',author,'POST',{query});
    assert.equal(first.status,200);assert.equal(first.data.length,2);assert.ok(first.meta.nextCursor);
    const stale=await call(base,'/api/v1/community/posts?stable=1&query=other&cursor='+encodeURIComponent(first.meta.nextCursor),author);
    assert.equal(stale.status,400);assert.match(stale.error.message,/搜索条件已变化/);
    assert.equal((await call(base,'/api/v1/community/posts/search',author,'POST',{query:42})).status,400);
    assert.equal((await call(base,'/api/v1/community/posts/search',author,'POST',{query,cursor:{bad:true}})).status,400);
    const next=await call(base,'/api/v1/community/posts/search?limit=2',author,'POST',{query:` ${query} `,cursor:first.meta.nextCursor});
    assert.equal(next.status,200);assert.equal(next.data.length,2);assert.equal(next.meta.nextCursor,null);
    assert.equal(new Set([...first.data,...next.data].map((p:any)=>p.id)).size,4);
  } finally {await close();}
});

test('stable post cursor survives deletion of the page boundary and legacy numeric cursors remain supported', async () => {
  const { base, close } = await startServer();
  try {
    const author = await register(base, 'post_pager');
    for (let index = 0; index < 7; index += 1) {
      assert.equal((await call(base, '/api/v1/community/posts', author, 'POST', { text: `帖子 ${index}` })).status, 200);
    }

    const baseline = await call(base, '/api/v1/community/posts?stable=1&limit=7', author);
    const first = await call(base, '/api/v1/community/posts?stable=1&limit=2', author);
    assert.deepEqual(first.data.map((post: any) => post.id), baseline.data.slice(0, 2).map((post: any) => post.id));
    assert.equal(typeof first.meta.nextCursor, 'string');

    const deletedBoundaryId = first.data[1].id;
    assert.equal((await call(base, `/api/v1/community/posts/${encodeURIComponent(deletedBoundaryId)}`, author, 'DELETE')).status, 200);
    const next = await call(base, `/api/v1/community/posts?stable=1&limit=2&cursor=${encodeURIComponent(first.meta.nextCursor)}`, author);
    const expected = baseline.data.slice(2).filter((post: any) => post.id !== deletedBoundaryId).map((post: any) => post.id);
    assert.deepEqual(next.data.map((post: any) => post.id), expected.slice(0, 2), 'boundary deletion must not shift and skip the next post');

    const legacyFirst = await call(base, '/api/v1/community/posts?limit=2', author);
    assert.equal(legacyFirst.meta.nextCursor, 2, 'requests without stable=1 retain the numeric cursor contract');
    const legacySecond = await call(base, '/api/v1/community/posts?limit=2&cursor=2', author);
    assert.equal(legacySecond.data.length, 2);
  } finally {
    await close();
  }
});

test('withdrawn posts remain as clearly marked snapshots for every collector, while the author feed removes them', async () => {
  const { base, close } = await startServer();
  try {
    const author = await register(base, 'post_withdrawer');
    const reader = await register(base, 'post_collector');
    const created = await call(base, '/api/v1/community/posts', author, 'POST', { text: '一段旅途记忆\n正文' });
    assert.equal(created.status, 200);
    const postId = created.data.id;

    for (const cookie of [author, reader]) {
      const saved = await call(base, `/api/v1/community/posts/${postId}/favorite`, cookie, 'POST', {});
      assert.equal(saved.data.postFavorites[0].post.source, 'active');
    }
    assert.equal((await call(base, `/api/v1/community/posts/${postId}`, author, 'DELETE')).status, 200);
    assert.ok(!(await call(base, '/api/v1/community/posts', author)).data.some((post: any) => post.id === postId));
    assert.ok(!(await call(base, '/api/v1/community/mine', author)).data.posts.some((post: any) => post.id === postId));

    for (const cookie of [author, reader]) {
      const favorites = await call(base, '/api/v1/community/post-favorites', cookie);
      const snapshot = favorites.data.find((entry: any) => entry.post.postId === postId);
      assert.ok(snapshot, 'the collector keeps a recognizable snapshot');
      assert.equal(snapshot.post.source, 'withdrawn');
      if (cookie === reader) {
        const savedPlaces = await call(base, '/api/v1/favorites', reader, 'POST', { placeId: '12143603120601' });
        assert.equal(savedPlaces.status, 200, 'the same account can keep a place favorite alongside a post favorite');
        const store = await import(pathToFileURL(join(process.cwd(), 'public', 'lib', 'store.js')).href) as Record<string, any>;
        const view = await import(pathToFileURL(join(process.cwd(), 'public', 'views', 'favorites.js')).href) as Record<string, any>;
        const previous = store.state.postFavorites;
        const previousPlaces = store.state.favorites;
        const previousLoadStatus = store.state.loadStatus;
        store.state.postFavorites = favorites.data;
        store.state.favorites = savedPlaces.data;
        store.state.loadStatus = { favorites: { status: 'loaded', message: '' } };
        try {
          const html = view.renderFavorites();
          assert.ok(html.includes('原帖已撤回，快照保留'), 'the favorites page labels the withdrawn source');
          assert.ok(html.includes('正文'), 'the favorites page keeps the post body readable after withdrawal');
          assert.ok(html.includes('data-action="favorite-post"'), 'a saved post can be removed from favorites');
          assert.ok(html.includes('id="favorite-posts-heading"') && html.includes('<span class="chip">1</span>'), 'the page shows its post collection section and count');
          assert.ok(html.includes(savedPlaces.data[0].place.name), 'the page also shows saved places');
          assert.ok(html.includes('data-action="shortlist"'), 'a saved place can be removed from favorites');
          assert.equal((html.match(/data-action="shortlist" data-place="12143603120601"/g) || []).length, 1, 'a favorite place card renders only its standard favorite button');
          assert.equal(html.includes('data-action="add-to-plan"'), false, 'favorite place cards match the discovery cards without an extra action row');
          assert.equal(html.includes('发现更多地点'), false, 'the favorites page should not send users away to discover places');
          assert.equal(html.includes('在地图上看'), false, 'the favorites page should not expose a map shortcut');
          assert.equal(html.includes('data-action="open-map"'), false, 'the favorites page should not contain a map action');
        } finally {
          store.state.postFavorites = previous;
          store.state.favorites = previousPlaces;
          store.state.loadStatus = previousLoadStatus;
        }
      }
    }
  } finally {
    await close();
  }
});

test('plan-share loader appends the next share page without changing the post cursor', async () => {
  const load = (relativePath: string) => import(pathToFileURL(join(process.cwd(), relativePath)).href) as Promise<Record<string, any>>;
  const store = await load('public/lib/store.js');
  const loaders = await load('public/lib/loaders.js');
  const state = store.state as Record<string, any>;
  const view = await load('public/views/plan-shares.js');
  const before = { fetch: globalThis.fetch, planShares: state.planShares, planShareCursor: state.planShareCursor, planShareLoadingMore: state.planShareLoadingMore, postCursor: state.postCursor, principal: state.principal };
  let requestedUrl = '';
  const share = (id: string) => ({ id, name: id, stopCount: 1, cityLabel: '杭州', cityCode: '330100', nickname: '旅人', createdAt: '2026-09-20T00:00:00.000Z' });
  state.planShares = [share('share_first')];
  state.planShareCursor = 20;
  state.planShareLoadingMore = false;
  state.principal = { kind: 'account', username: 'pager' };
  state.postCursor = 'p1.keep-post-cursor';
  globalThis.fetch = (async input => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ data: [share('share_second')], meta: { nextCursor: null } }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.ok(view.renderPlanShares().includes('data-action="more-plan-shares"'), 'the view exposes a control while a cursor remains');
    await loaders.loadMorePlanShares();
    const requested = new URL(requestedUrl, 'http://localhost');
    assert.equal(requested.pathname, '/api/v1/community/plan-shares');
    assert.equal(requested.searchParams.get('cursor'), '20');
    assert.deepEqual(state.planShares.map((item: any) => item.id), ['share_first', 'share_second']);
    assert.equal(state.planShareCursor, null);
    assert.ok(!view.renderPlanShares().includes('data-action="more-plan-shares"'), 'the control disappears after the final page');
    assert.equal(state.postCursor, 'p1.keep-post-cursor', 'plan-share pagination uses its own cursor');
  } finally {
    globalThis.fetch = before.fetch;
    state.planShares = before.planShares;
    state.planShareCursor = before.planShareCursor;
    state.planShareLoadingMore = before.planShareLoadingMore;
    state.postCursor = before.postCursor;
    state.principal = before.principal;
  }
});
