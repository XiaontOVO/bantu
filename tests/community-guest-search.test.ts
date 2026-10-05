import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function fixture() {
  const store = new MemoryStateStore();
  const server = createHttpServer({ seedDemo: false, stateStore: store });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const guest = async () => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  const api = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + '/api/v1/' + path, {
      method, headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, ...await response.json() as any };
  };
  const close = async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  };
  try {
    const registered = await fetch(base + '/api/v1/account/register', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await guest() },
      body: JSON.stringify({ username: 'guest_search_author', password: '12345678' }),
    });
    assert.equal(registered.status, 200);
    const account = registered.headers.get('set-cookie')!.split(';')[0];
    return { api, base, account, visitor: await guest(), store, close };
  } catch (error) { await close(); throw error; }
}

function schemeCode(name: string) {
  const stops = Array.from({ length: 16 }, (_, index) => ({ n: `武康大楼第${index + 1}次散步`, la: 31.1856, ln: 121.4351 }));
  const body = Buffer.from(JSON.stringify({ v: 1, n: name, c: '310100', cn: '上海', s: stops })).toString('base64').replace(/=+$/, '');
  const checksum = ([...body].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 1296).toString(36).toUpperCase().padStart(2, '0');
  return `BT1-${body}-${checksum}`;
}

test('guests can search public posts with the same POST and cursor protocol as the mobile feed without seeing private posts', async () => {
  const f = await fixture();
  try {
    const publicIds: string[] = [];
    for (const title of ['搜索散步甲', '搜索散步乙', '搜索散步丙']) {
      const saved = await f.api(f.account, 'community/posts', 'POST', { text: title + '\n公开正文' });
      assert.equal(saved.status, 200); publicIds.push(saved.data.id);
    }
    const secret = await f.api(f.account, 'community/posts', 'POST', { text: '搜索散步私密\n不公开内容', visibility: 'private' });
    assert.equal(secret.status, 200);
    const first = await f.api(f.visitor, 'community/posts/search?limit=2', 'POST', { query: '搜索散步' });
    assert.equal(first.status, 200, 'read-only POST search must remain available in guest mode');
    assert.equal(first.data.length, 2); assert.ok(first.meta.nextCursor);
    const second = await f.api(f.visitor, 'community/posts/search?limit=2', 'POST', { query: ' 搜索散步 ', cursor: first.meta.nextCursor });
    assert.equal(second.status, 200); assert.equal(second.data.length, 1); assert.equal(second.meta.nextCursor, null);
    assert.deepEqual(new Set([...first.data, ...second.data].map((item: any) => item.id)), new Set(publicIds));
    assert.equal((await f.api(f.visitor, `community/posts/${secret.data.id}`)).status, 404);
    assert.equal((await f.api(f.visitor, 'community/posts/search', 'POST', { query: 42 })).status, 400);
    assert.equal((await f.api(f.visitor, 'community/posts/search', 'POST', { query: '其他条件', cursor: first.meta.nextCursor })).status, 400);
    assert.equal((await f.api(f.visitor, 'community/posts/search', 'POST', { query: '没有匹配' })).data.length, 0);
  } finally { await f.close(); }
});

test('guests can search shared schemes by long code, title and cursor without publishing or deleting anything', async () => {
  const f = await fixture();
  try {
    const shares: any[] = [];
    for (const name of ['测试慢游方案甲', '测试慢游方案乙']) {
      const published = await f.api(f.account, 'community/plan-shares', 'POST', { code: schemeCode(name), name, cityCode: '310100', cityLabel: '上海', stopCount: 16 });
      assert.equal(published.status, 200); shares.push(published.data);
    }
    const first = await f.api(f.visitor, 'community/plan-shares/search?limit=1', 'POST', { query: '测试慢游方案' });
    assert.equal(first.status, 200, 'read-only scheme searches must remain available in guest mode');
    assert.equal(first.data.length, 1); assert.ok(first.meta.nextCursor);
    const next = await f.api(f.visitor, 'community/plan-shares/search?limit=1&cursor=' + first.meta.nextCursor, 'POST', { query: '测试慢游方案' });
    assert.equal(next.status, 200); assert.equal(next.data.length, 1);
    assert.notEqual(next.data[0].id, first.data[0].id);
    const byCode = await f.api(f.visitor, 'community/plan-shares/search', 'POST', { query: shares[0].code });
    assert.ok(encodeURIComponent(shares[0].code).length > 1000, 'long codes exercise the actual mobile POST fallback threshold');
    assert.equal(byCode.status, 200); assert.deepEqual(byCode.data.map((item: any) => item.id), [shares[0].id]);
    assert.equal((await f.api(f.visitor, 'community/plan-shares', 'POST', { code: shares[0].code })).status, 403);
    assert.equal((await f.api(f.visitor, 'community/plan-shares/' + shares[0].id, 'DELETE')).status, 403);
    assert.equal((await f.api(f.account, 'community/mine')).data.planShares.length, 2);
  } finally { await f.close(); }
});

test('actual mobile feed and scheme search loaders accept long guest searches through the real HTTP backend', async () => {
  const f = await fixture();
  const load = (relative: string) => import(pathToFileURL(join(process.cwd(), relative)).href) as Promise<Record<string, any>>;
  const { state } = await load('public/lib/store.js');
  const feed = await load('public/lib/post-feed.js');
  const loaders = await load('public/lib/loaders.js');
  const before = { ...state }, fetchBefore = globalThis.fetch;
  try {
    const query = '梧桐'.repeat(200);
    const post = await f.api(f.account, 'community/posts', 'POST', { text: '长搜索标题\n' + query });
    const secret = await f.api(f.account, 'community/posts', 'POST', { text: '私密长搜索\n' + query, visibility: 'private' });
    assert.equal(post.status, 200); assert.equal(secret.status, 200);
    const name = '移动搜索方案';
    const share = await f.api(f.account, 'community/plan-shares', 'POST', { code: schemeCode(name), name, cityCode: '310100', cityLabel: '上海', stopCount: 16 });
    assert.equal(share.status, 200);
    const visitor = await f.api(f.visitor, 'me'); assert.equal(visitor.data.kind, 'anonymous');
    const requests: string[] = [];
    globalThis.fetch = (async (input, options) => {
      requests.push(`${options?.method || 'GET'} ${String(input)}`);
      return fetchBefore(f.base + String(input), { ...options, headers: { ...(options?.headers as Record<string, string>), cookie: f.visitor } });
    }) as typeof fetch;
    Object.assign(state, { principal: visitor.data, accountContextChanged: false, postQuery: query, communityPosts: [], postCursor: null, postSearchError: '', planShareQuery: '', planShares: [], planShareCursor: null });
    await feed.loadPostFeed({ search: true });
    assert.deepEqual(state.communityPosts.map((item: any) => item.id), [post.data.id]);
    assert.equal(state.postSearchError, ''); assert.equal(state.postSearching, false);
    await loaders.searchPlanShares(share.data.code);
    assert.deepEqual(state.planShares.map((item: any) => item.id), [share.data.id]);
    assert.equal(state.planShareSearching, false);
    assert.deepEqual(requests, ['POST /api/v1/community/posts/search', 'POST /api/v1/community/plan-shares/search']);
  } finally { Object.assign(state, before); globalThis.fetch = fetchBefore; await f.close(); }
});

test('read-only POST search exceptions do not authorize guest community writes or moderation', async () => {
  const f = await fixture();
  try {
    const post = await f.api(f.account, 'community/posts', 'POST', { text: '公开边界标题\n正文' });
    assert.equal(post.status, 200);
    const path = 'community/posts/' + post.data.id;
    for (const [target, method, body] of [
      ['community/posts', 'POST', { text: '游客不应发布' }],
      [path, 'PATCH', { visibility: 'private' }],
      [path, 'DELETE', undefined],
      [path + '/like', 'POST', {}],
      [path + '/favorite', 'POST', {}],
      [path + '/comments', 'POST', { text: '游客不应评论' }],
      ['community/places', 'POST', { name: '游客不应分享' }],
    ] as const) assert.equal((await f.api(f.visitor, target, method, body)).status, 403, target);
    assert.equal((await f.api(f.visitor, 'community/moderation')).status, 403);
    assert.equal((await f.api(f.account, path)).data.commentCount, 0);
    assert.equal((await f.api(f.account, path)).data.likes, 0);
    assert.equal((await f.api(f.account, path)).data.visibility, 'public');
    assert.equal((await f.api(f.visitor, 'community/post-favorites')).data.length, 0);
  } finally { await f.close(); }
});
