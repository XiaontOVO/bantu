import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { CommunityService } from '../src/services/community-service.js';

const start = async (server: ReturnType<typeof createHttpServer>) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
};
const guest = async (base: string) => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
// 社区写操作只对账号开放：先建游客会话再注册，返回注册后换发的会话 cookie。
const account = async (base: string, name: string) => {
  const cookie = await guest(base);
  const response = await fetch(base + '/api/v1/account/register', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'password123' }) });
  assert.equal(response.status, 200, `注册账号 ${name} 应成功`);
  return response.headers.get('set-cookie')!.split(';')[0];
};
const login = async (base: string, name: string) => {
  const cookie = await guest(base);
  const response = await fetch(base + '/api/v1/account/login', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'password123' }) });
  assert.equal(response.status, 200, `账号 ${name} 应能重新登录`);
  return response.headers.get('set-cookie')!.split(';')[0];
};
const call = async (base: string, path: string, cookie: string, method = 'GET', body?: unknown, token?: string) => {
  const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json', ...(token ? { 'x-community-admin-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, ...(await response.json() as any) };
};

test('community samples seed posts only, never sample places, and can be cleared for good', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: true, stateStore: store, communityAdminToken: 'review-secret' });
  let base = await start(server);
  try {
    const cookie = await account(base, 'keeper');
    const posts = (await call(base, '/api/v1/community/posts', cookie)).data;
    assert.ok(posts.length >= 6, '样例帖子已注入');
    assert.ok(posts.every((post: any) => post.sample === true), '样例帖子携带样例标记');
    assert.ok(posts.some((post: any) => post.likes > 0 && post.commentCount > 0), '样例帖子带点赞与评论');
    // 样例地点不再注入：目录必须保持每个地点独一无二
    const places = (await call(base, '/api/v1/community/places?limit=50', cookie)).data;
    assert.equal(places.length, 0, '不再注入样例地点');
    const catalog = await call(base, '/api/v1/places?query=' + encodeURIComponent('（样例）'), cookie);
    assert.equal(catalog.data.length, 0, '样例地点不进入官方目录');
    // 新账号的"我的发布"为空
    const mine = (await call(base, '/api/v1/community/mine', cookie)).data;
    assert.equal(mine.posts.length, 0); assert.equal(mine.places.length, 0);

    // 全局清除会影响所有用户，只允许持平台审核员凭证的管理端操作。
    assert.equal((await call(base, '/api/v1/community/samples', cookie, 'DELETE')).status, 403);
    assert.equal((await call(base, '/api/v1/community/samples', cookie, 'DELETE', undefined, 'review-secret')).status, 200);
    assert.equal((await call(base, '/api/v1/community/posts', cookie)).data.length, 0);
    assert.equal((await call(base, '/api/v1/community/places?limit=50', cookie)).data.length, 0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: true, stateStore: store, communityAdminToken: 'review-secret' }); base = await start(server);
    assert.equal((await call(base, '/api/v1/community/posts', await guest(base))).data.length, 0, '清除状态持久化，重启不重新注入');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('place names stay unique across community shares and the official catalog', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'mod-secret' });
  let base = await start(server);
  try {
    const sharer = await account(base, 'dup_sharer');
    const mk = (name: string) => call(base, '/api/v1/community/places', sharer, 'POST',
      { name, nickname: '小鹿', cityCode: '330100', address: '沿河步道入口', description: '安静的小院。' });
    assert.equal((await mk('桥边小院')).status, 200);
    const again = await mk('桥边小院');
    assert.equal(again.status, 400, '社区同名分享被拒绝');
    assert.ok(String(again.error?.message).includes('同名'), '提示已有同名分享');
    // 收录进官方目录后，同名分享同样被拒（每个地点独一无二）
    const id = (await call(base, '/api/v1/community/mine', sharer)).data.places.find((item: any) => item.name === '桥边小院').id;
    await call(base, `/api/v1/community/places/${id}/submit`, sharer, 'POST', { lat: 30.25, lng: 120.15, evidence: '公开资料' });
    await call(base, `/api/v1/community/places/${id}/decision`, sharer, 'POST', { decision: 'approved', note: '核对通过' }, 'mod-secret');
    const catalogDup = await mk('桥边小院');
    assert.equal(catalogDup.status, 400, '与官方目录同名被拒绝');
    assert.equal(catalogDup.error?.code, 'PLACE_DUPLICATE');
    // 已退回的同名分享允许修正后重新提交
    await mk('江畔观景台');
    const rejected = (await call(base, '/api/v1/community/mine', sharer)).data.places.find((item: any) => item.name === '江畔观景台').id;
    await call(base, `/api/v1/community/places/${rejected}/submit`, sharer, 'POST', { lat: 30.25, lng: 120.15, evidence: '公开资料' });
    await call(base, `/api/v1/community/places/${rejected}/decision`, sharer, 'POST', { decision: 'rejected', note: '坐标偏差' }, 'mod-secret');
    assert.equal((await mk('江畔观景台')).status, 200, '已退回的同名分享可重新提交');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('community place sharing fails closed when the catalog search returns an error', async () => {
  let rejectSearch = false;
  const provider = {
    providerName: 'unavailable_catalog',
    search: async () => {
      if (rejectSearch) throw new Error('provider network failed');
      return {
        places: [], empty: false,
        error: { code: 'CATALOG_UNAVAILABLE', message: '地点目录暂时不可用。' },
      };
    },
    detail: async () => null,
  };
  let server = createHttpServer({ seedDemo: false, placeProvider: provider });
  const base = await start(server);
  try {
    const sharer = await account(base, 'dup_search_outage');
    const rejected = await call(base, '/api/v1/community/places', sharer, 'POST', {
      name: '可能已收录的地点', nickname: '旅人', cityCode: '330100', address: '地址', description: '描述',
    });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.error?.code, 'CATALOG_UNAVAILABLE');
    assert.equal(rejected.error?.retryable, true);
    rejectSearch = true;
    const rejectedAfterThrow = await call(base, '/api/v1/community/places', sharer, 'POST', {
      name: '可能已收录的另一个地点', nickname: '旅人', cityCode: '330100', address: '地址', description: '描述',
    });
    assert.equal(rejectedAfterThrow.status, 503);
    assert.equal(rejectedAfterThrow.error?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(rejectedAfterThrow.error?.retryable, true);
    const mine = (await call(base, '/api/v1/community/mine', sharer)).data;
    assert.equal(mine.places.length, 0, '目录查重失败时不应创建分享记录');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('community place sharing fails closed when fuzzy catalog results accompany an error', async () => {
  let catalogDegraded = false;
  const provider = {
    providerName: 'partial_catalog',
    search: async (input: { cityCode: string }) => catalogDegraded
      ? {
        places: [{ placeId: 'catalog-cloud-hill-hotel', name: 'Cloud Hill Hotel', provider: 'partial_catalog', cityCode: input.cityCode } as any],
        empty: false,
        error: { code: 'CATALOG_PARTIAL', message: 'Catalog lookup was incomplete.' },
      }
      : { places: [], empty: true },
    detail: async () => null,
  };
  const server = createHttpServer({ seedDemo: false, placeProvider: provider, communityAdminToken: 'mod-secret' });
  const base = await start(server);
  try {
    const sharer = await account(base, 'partial_catalog_sharer');
    const existing = await call(base, '/api/v1/community/places', sharer, 'POST', {
      name: 'Riverside Cafe', nickname: 'Traveler', cityCode: '330100', address: 'Riverside Road',
      description: 'A stop near Cloud Hill.',
    });
    assert.equal(existing.status, 200);
    const existingId = (await call(base, '/api/v1/community/mine', sharer)).data.places[0].id;
    await call(base, `/api/v1/community/places/${existingId}/submit`, sharer, 'POST', {
      lat: 30.25, lng: 120.15, evidence: 'Public reference',
    });
    await call(base, `/api/v1/community/places/${existingId}/decision`, sharer, 'POST', {
      decision: 'approved', note: 'Verified',
    }, 'mod-secret');

    // The approved community description matches the new name, while the catalog
    // returns only a fuzzy candidate together with an error.
    catalogDegraded = true;
    const unchecked = await call(base, '/api/v1/community/places', sharer, 'POST', {
      name: 'Cloud Hill', nickname: 'Traveler', cityCode: '330100', address: 'Hill Road',
      description: 'A quiet lookout.',
    });
    assert.equal(unchecked.status, 503);
    assert.equal(unchecked.error?.code, 'CATALOG_PARTIAL');
    assert.equal(unchecked.error?.retryable, true);
    const mine = (await call(base, '/api/v1/community/mine', sharer)).data;
    assert.equal(mine.places.length, 1, 'incomplete catalog lookup must not create a second share');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('malformed percent encoding in a community resource path returns INVALID_INPUT', async () => {
  const server = createHttpServer({ seedDemo: false });
  const base = await start(server);
  try {
    const response = await fetch(`${base}/api/v1/community/posts/%E0%A4%A`);
    assert.equal(response.status, 400);
    const body = await response.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'INVALID_INPUT');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('sample seeding is idempotent across restarts while user content is preserved', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: true, stateStore: store });
  let base = await start(server);
  try {
    const cookie = await account(base, 'preserver');
    await call(base, '/api/v1/community/posts', cookie, 'POST', { nickname: '真实旅人', text: '我自己的帖子\n不应被清除或重复。' });
    const firstCount = (await call(base, '/api/v1/community/posts', cookie)).data.length;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: true, stateStore: store }); base = await start(server);
    const cookie2 = await guest(base);
    const posts = (await call(base, '/api/v1/community/posts', cookie2)).data;
    assert.equal(posts.length, firstCount, '重启不重复注入样例');
    assert.ok(posts.some((post: any) => post.nickname === '真实旅人' && post.sample === false), '用户内容保留');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('post likes toggle idempotently and survive restart', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store });
  let base = await start(server);
  try {
    const author = await account(base, 'liker_author'); const reader = await account(base, 'liker_reader');
    const post = (await call(base, '/api/v1/community/posts', author, 'POST', { nickname: '作者', text: '点赞测试\n正文' })).data;
    const first = await call(base, `/api/v1/community/posts/${post.id}/like`, reader, 'POST', {});
    assert.deepEqual(first.data, { liked: true, likes: 1 });
    // 幂等：同一人重复点赞等价于取消点赞
    const again = await call(base, `/api/v1/community/posts/${post.id}/like`, reader, 'POST', {});
    assert.deepEqual(again.data, { liked: false, likes: 0 });
    const third = await call(base, `/api/v1/community/posts/${post.id}/like`, reader, 'POST', {});
    assert.deepEqual(third.data, { liked: true, likes: 1 });
    const listing = (await call(base, '/api/v1/community/posts', author)).data;
    assert.equal(listing[0].likes, 1); assert.equal(listing[0].liked, false); assert.equal(listing[0].commentCount, 0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: false, stateStore: store }); base = await start(server);
    const restored = (await call(base, '/api/v1/community/posts', await guest(base))).data;
    assert.equal(restored[0].likes, 1, '点赞跨重启保留');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('GET /api/v1/community/posts/:postId serves details and returns a post-specific 404', async () => {
  const server = createHttpServer({ seedDemo: false, stateStore: new MemoryStateStore() });
  const base = await start(server);
  try {
    const author = await account(base, 'post_detail_author');
    const post = (await call(base, '/api/v1/community/posts', author, 'POST', {
      text: '详情接口回归测试\n正文内容',
    })).data;

    const detail = await call(base, `/api/v1/community/posts/${post.id}`, author);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.id, post.id);
    assert.equal(detail.data.text, '详情接口回归测试\n正文内容');
    assert.deepEqual(detail.data.comments, []);

    const missing = await call(base, '/api/v1/community/posts/post_missing-detail-regression', author);
    assert.equal(missing.status, 404);
    assert.equal(missing.error.code, 'RESOURCE_NOT_FOUND');
    assert.doesNotMatch(missing.error.message, /没有匹配的接口/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('post comments add, delete with ownership checks, update counts, and persist', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store });
  let base = await start(server);
  try {
    const author = await account(base, 'comment_author'); const reader = await account(base, 'comment_reader');
    const post = (await call(base, '/api/v1/community/posts', author, 'POST', { nickname: '作者', text: '评论测试' })).data;
    assert.equal((await call(base, `/api/v1/community/posts/${post.id}/comments`, reader, 'POST', { nickname: '路人', text: '  ' })).status, 400, '空评论被拒绝');
    const added = await call(base, `/api/v1/community/posts/${post.id}/comments`, reader, 'POST', { nickname: '路人', text: '写得好。' });
    assert.equal(added.data.commentCount, 1);
    assert.equal(added.data.comments[0].mine, true);
    const detail = await call(base, `/api/v1/community/posts/${post.id}`, reader);
    assert.equal(detail.status, 200, '收藏页可按帖子 ID 读取评论详情');
    assert.equal(detail.data.comments[0].text, '写得好。');
    assert.equal((await call(base, `/api/v1/community/posts/${post.id}/comments`, author, 'POST', { nickname: '作者', text: '谢谢！' })).data.commentCount, 2);
    // 只能删除自己的评论
    const asReader = (await call(base, '/api/v1/community/posts', reader)).data[0];
    const readerComment = asReader.comments.find((c: any) => c.mine);
    assert.equal((await call(base, `/api/v1/community/posts/${post.id}/comments/${readerComment.id}`, author, 'DELETE')).status, 400, '不能删别人的评论');
    const afterDelete = await call(base, `/api/v1/community/posts/${post.id}/comments/${readerComment.id}`, reader, 'DELETE');
    assert.equal(afterDelete.data.commentCount, 1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: false, stateStore: store }); base = await start(server);
    const restored = (await call(base, '/api/v1/community/posts', await guest(base))).data;
    assert.equal(restored[0].commentCount, 1, '评论跨重启保留');
    assert.equal(restored[0].comments[0].nickname, '作者');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('only approved discoveries are public; directory sorting and city filtering include reviewed traveler places', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'mod-secret' });
  let base = await start(server);
  try {
    const owner = await account(base, 'discovery_owner'); const visitor = await account(base, 'discovery_visitor');
    const mk = async (name: string, cityCode: string) => (await call(base, '/api/v1/community/places', owner, 'POST',
      { name, nickname: '店主', cityCode, address: `地址${name}`, description: '测试地点' })).data.id;
    const low = await mk('低分地点', '330100');
    const high = await mk('高分地点', '330100');
    const foreign = await mk('外地地点', '310100');
    assert.equal((await call(base, '/api/v1/community/places', visitor)).data.length, 0, '未审核地点不能出现在公共列表');
    assert.equal((await call(base, `/api/v1/community/places/${low}`, visitor)).status, 404, '未审核地点的详情也不能公开访问');
    for (const id of [low, high, foreign]) {
      await call(base, `/api/v1/community/places/${id}/submit`, owner, 'POST', { lat: 30.25, lng: 120.15, evidence: '公开地址已核对' });
      await call(base, `/api/v1/community/places/${id}/decision`, owner, 'POST', { decision: 'approved', note: '已核对' }, 'mod-secret');
    }
    await call(base, `/api/v1/community/places/${high}/reviews`, visitor, 'POST', { nickname: '路人', rating: 5, text: '很好。' });
    await call(base, `/api/v1/community/places/${low}/reviews`, visitor, 'POST', { nickname: '路人', rating: 3, text: '一般。' });
    const byRating = (await call(base, '/api/v1/community/places?sort=rating', owner)).data;
    assert.equal(byRating[0].name, '高分地点');
    const byReviews = (await call(base, '/api/v1/community/places?sort=reviews', owner)).data;
    assert.equal(byReviews[0].reviewCount, 1);
    assert.ok(byReviews.every((item: any, index: number) => index === 0 || byReviews[index - 1].reviewCount >= item.reviewCount));
    const cityList = (await call(base, '/api/v1/community/places?city=310100', owner)).data;
    assert.equal(cityList.length, 1); assert.equal(cityList[0].name, '外地地点');
    const lowPlaceId = (await call(base, `/api/v1/community/places/${low}`, owner)).data.placeId;
    // mine：作者视角返回自己的地点，游客视角只返回自己的
    const mineOwner = (await call(base, '/api/v1/community/mine', owner)).data;
    assert.equal(mineOwner.places.length, 3);
    const mineVisitor = (await call(base, '/api/v1/community/mine', visitor)).data;
    assert.equal(mineVisitor.places.length, 0);
    // 发布带地点引用的帖子
    const linked = (await call(base, '/api/v1/community/posts', owner, 'POST',
      { nickname: '作者', text: '关联地点\n正文', placeRef: { placeId: lowPlaceId, name: '伪造地点名' } })).data;
    assert.equal(linked.placeRef.name, '低分地点');
    assert.equal((await call(base, '/api/v1/community/posts', owner, 'POST', {
      nickname: '作者', text: '坏地点引用', placeRef: { placeId: 'missing-place-id', name: '不存在的地点' },
    })).status, 404, '不存在的地点不能作为公开帖子关联项');
    const pendingRef = await call(base, '/api/v1/community/places', owner, 'POST', {
      name: '仅作者可见的待审核地点', nickname: '作者', cityCode: '330100', address: '测试地址', description: '测试内容',
    });
    assert.equal((await call(base, '/api/v1/community/posts', owner, 'POST', {
      nickname: '作者', text: '待审核地点', placeRef: { placeId: pendingRef.data.id, name: '仅作者可见的待审核地点' },
    })).status, 404, '私有的待审核地点不能透过公开帖子泄露');
    assert.equal((await call(base, '/api/v1/community/posts', owner, 'POST', { nickname: '作者', text: '坏的', placeRef: { name: '缺id' } })).data.placeRef, null, 'placeRef 缺 placeId 时置空');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('reports, moderation queue with admin token, and decision log persist across restart', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'mod-secret' });
  let base = await start(server);
  try {
    const owner = await account(base, 'report_owner'); const visitor = await account(base, 'report_visitor');
    const place = (await call(base, '/api/v1/community/places', owner, 'POST',
      { name: '被举报的地点', nickname: '作者', cityCode: '330100', address: '地址', description: '描述' })).data.id;
    // 不能举报自己的内容；空理由被拒绝
    assert.equal((await call(base, `/api/v1/community/places/${place}/reports`, owner, 'POST', { reason: '自首' })).status, 400);
    assert.equal((await call(base, `/api/v1/community/places/${place}/reports`, visitor, 'POST', { reason: '位置不实' })).status, 400, '未公开地点不能举报');
    await call(base, `/api/v1/community/places/${place}/submit`, owner, 'POST', { lat: 30.25, lng: 120.15, evidence: '公开地点已核实' });
    await call(base, `/api/v1/community/places/${place}/decision`, visitor, 'POST', { decision: 'approved', note: '核对通过' }, 'mod-secret');
    assert.equal((await call(base, `/api/v1/community/places/${place}/reports`, visitor, 'POST', { reason: '' })).status, 400);
    assert.equal((await call(base, `/api/v1/community/places/${place}/reports`, visitor, 'POST', { reason: '位置不实' })).status, 200);
    // 详情页对举报人显示已举报状态
    assert.equal((await call(base, `/api/v1/community/places/${place}`, visitor)).data.reported, true);
    assert.equal((await call(base, `/api/v1/community/places/${place}`, owner)).data.reported, false);
    const pendingPlace = (await call(base, '/api/v1/community/places', owner, 'POST',
      { name: '待审核地点', nickname: '作者', cityCode: '330100', address: '地址2', description: '描述2' })).data.id;
    await call(base, `/api/v1/community/places/${pendingPlace}/submit`, owner, 'POST', { lat: 30.26, lng: 120.16, evidence: '等待核实' });
    assert.equal((await call(base, '/api/v1/community/places', visitor)).data.some((item: any) => item.id === pendingPlace), false);
    // 审核台需要凭证
    assert.equal((await call(base, '/api/v1/community/moderation', owner)).status, 403);
    const modResponse = await fetch(base + '/api/v1/community/moderation', { headers: { cookie: owner, 'x-community-admin-token': 'mod-secret' } });
    const queue = (await modResponse.json() as any).data;
    assert.equal(queue.reported.length, 1);
    assert.equal(queue.reported[0].reports[0].reason, '位置不实');
    assert.equal(queue.log.length, 1, '此前已通过的地点应记录在审核日志中');
    assert.equal(queue.log[0].targetName, '被举报的地点');
    assert.equal(queue.log[0].decision, 'approved');
    // 提交收录后审核：进入待审队列，决定后写入日志
    const queue2 = (await (await fetch(base + '/api/v1/community/moderation', { headers: { cookie: owner, 'x-community-admin-token': 'mod-secret' } })).json() as any).data;
    assert.equal(queue2.pending.length, 1);
    const decision = await call(base, `/api/v1/community/places/${pendingPlace}/decision`, visitor, 'POST', { decision: 'rejected', note: '证据不足' }, 'mod-secret');
    assert.equal(decision.status, 200, '凭审核员凭证应能处理待审核地点');
    assert.equal(decision.data.status, 'rejected', `审核决定应更新地点状态：${JSON.stringify(decision)}`);
    const queue3 = (await (await fetch(base + '/api/v1/community/moderation', { headers: { cookie: owner, 'x-community-admin-token': 'mod-secret' } })).json() as any).data;
    assert.equal(queue3.pending.length, 0, `审核后的待审队列应清空：${JSON.stringify(queue3.pending)}`);
    assert.equal(queue3.log.length, 2);
    assert.equal(queue3.log[0].targetName, '待审核地点');
    assert.equal(queue3.log[0].decision, 'rejected');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'mod-secret' }); base = await start(server);
    const cookie = await guest(base);
    const restoredOwner = await login(base, 'report_owner');
    const modFetch = await fetch(base + '/api/v1/community/moderation', { headers: { cookie, 'x-community-admin-token': 'mod-secret' } });
    const restored = (await modFetch.json() as any).data;
    assert.equal(restored.reported.length, 1, '举报跨重启保留');
    assert.equal(restored.log.length, 2, '审核日志跨重启保留');
    assert.equal((await call(base, `/api/v1/community/places/${pendingPlace}`, cookie)).status, 404, '重启后其他身份也不能查看未审核地点');
    assert.equal((await call(base, `/api/v1/community/places/${pendingPlace}`, restoredOwner)).data.status, 'rejected', '发布者重新登录后仍能查看退回记录');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('guests can read community but every write requires an account', async () => {
  const store = new MemoryStateStore();
  const server = createHttpServer({ seedDemo: true, stateStore: store });
  const base = await start(server);
  try {
    const cookie = await guest(base);
    const posts = (await call(base, '/api/v1/community/posts', cookie)).data;
    assert.ok(posts.length > 0, '游客可以浏览社区帖子');
    const denied = await call(base, '/api/v1/community/posts', cookie, 'POST', { text: '游客想发帖' });
    assert.equal(denied.status, 403, '游客发帖被拒绝');
    assert.equal(denied.error?.code, 'LOGIN_REQUIRED');
    assert.ok(String(denied.error?.message).includes('登录'), '错误信息引导去登录');
    assert.equal((await call(base, `/api/v1/community/posts/${posts[0].id}/like`, cookie, 'POST', {})).status, 403, '游客不能点赞');
    assert.equal((await call(base, '/api/v1/community/samples', cookie, 'DELETE')).status, 403, '游客不能清除样例');
    // 审核台依旧只看凭证，不看账号身份
    assert.equal((await call(base, '/api/v1/community/moderation', cookie)).status, 403);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('official catalog places accept star reviews keyed by place id', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'mod-secret' });
  let base = await start(server);
  try {
    const sharer = await account(base, 'review_sharer');
    const visitor = await account(base, 'review_visitor');
    const created = (await call(base, '/api/v1/community/places', sharer, 'POST',
      { name: '湖畔茶室', nickname: '小鹿', cityCode: '330100', address: '湖边', description: '安静。' })).data.id;
    await call(base, `/api/v1/community/places/${created}/submit`, sharer, 'POST', { lat: 30.25, lng: 120.15, evidence: '公开资料' });
    await call(base, `/api/v1/community/places/${created}/decision`, sharer, 'POST', { decision: 'approved', note: '核对通过' }, 'mod-secret');
    const placeId = (await call(base, '/api/v1/places?query=' + encodeURIComponent('湖畔茶室'), visitor)).data[0].placeId;
    assert.match(placeId, /^\d{14}$/, '已收录地点使用 14 位坐标 ID');

    assert.equal((await call(base, `/api/v1/community/places/${placeId}/reviews`, visitor, 'POST', { rating: 0, text: 'x' })).status, 400, '评分需 1-5 星');
    assert.equal((await call(base, `/api/v1/community/places/${placeId}/reviews`, sharer, 'POST', { rating: 5, text: '自己评价自己' })).status, 400, '来源作者不能绕过自评限制');
    assert.equal((await call(base, `/api/v1/community/places/${placeId}/reviews`, visitor, 'POST', { rating: 5, text: '很舒服。' })).status, 200, '官方目录地点可评价');
    // 同一身份再次提交 = 更新自己的评价
    await call(base, `/api/v1/community/places/${placeId}/reviews`, visitor, 'POST', { rating: 4, text: '改评：周末人多。' });
    const list = (await call(base, '/api/v1/places?query=' + encodeURIComponent('湖畔茶室'), visitor)).data;
    assert.equal(list[0].reviews.length, 1, '每个身份保留一份评价');
    assert.equal(list[0].reviews[0].rating, 4);
    assert.equal(list[0].reviews[0].text, '改评：周末人多。');
    const detail = (await call(base, `/api/v1/places/${placeId}`, visitor)).data;
    assert.equal(detail.reviews.length, 1, '地点详情也应展示持久化的用户评价');
    assert.equal(detail.reviews[0].text, '改评：周末人多。');
    // 不存在的地点 404；游客不能评价
    assert.equal((await call(base, '/api/v1/community/places/place_missing/reviews', visitor, 'POST', { rating: 5, text: 'x' })).status, 404);
    assert.equal((await call(base, `/api/v1/community/places/${placeId}/reviews`, await guest(base), 'POST', { rating: 5, text: 'x' })).status, 403, '评价需要账号');

    // 撤回收录条目后，其坐标 ID 退役；重启再分享相同地点时不能继承旧评价。
    assert.equal((await call(base, `/api/v1/community/places/${created}`, sharer, 'DELETE')).status, 200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createHttpServer({ seedDemo: false, stateStore: store, communityAdminToken: 'mod-secret' });
    base = await start(server);
    const retiredDetail = await call(base, `/api/v1/places/${placeId}`, visitor);
    assert.equal(retiredDetail.status, 404, `撤回后旧目录条目不可见：${JSON.stringify(retiredDetail)}`);
    const replacement = await call(base, '/api/v1/community/places', sharer, 'POST',
      { name: '湖畔茶室', nickname: '小鹿', cityCode: '330100', address: '湖边', description: '重新核实后分享。' });
    assert.equal(replacement.status, 200);
    await call(base, `/api/v1/community/places/${replacement.data.id}/submit`, sharer, 'POST', { lat: 30.25, lng: 120.15, evidence: '公开资料' });
    await call(base, `/api/v1/community/places/${replacement.data.id}/decision`, sharer, 'POST', { decision: 'approved', note: '重新核对通过' }, 'mod-secret');
    const replacementCatalog = (await call(base, '/api/v1/places?query=' + encodeURIComponent('湖畔茶室'), visitor)).data;
    assert.notEqual(replacementCatalog[0].placeId, placeId, '退役坐标 ID 不再分配给新条目');
    assert.deepEqual(replacementCatalog[0].reviews, [], '新目录条目不继承已撤回条目的评价');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('clean catalog contains no phantom reviews and shows only reviews submitted by registered accounts', async () => {
  const server = createHttpServer({ seedDemo: false });
  const base = await start(server);
  try {
    const cookie = await account(base, 'bantu_review_check');
    const catalog = (await call(base, '/api/v1/places?limit=50', cookie)).data;
    assert.ok(catalog.length > 0);
    assert.ok(catalog.every((place: any) => !place.reviews.length && !place.demoReviews.length), 'reset must not resurrect hardcoded visitor names');
    const placeId = catalog.find((place: any) => place.name === '武康大楼').placeId;
    await call(base, '/api/v1/me', cookie, 'PATCH', { nickname: '伴途·小艾' });
    assert.equal((await call(base, `/api/v1/community/places/${placeId}/reviews`, cookie, 'POST', { rating: 5, text: '喜欢慢慢散步看建筑。' })).status, 200);
    const detail = (await call(base, `/api/v1/places/${placeId}`, cookie)).data;
    assert.equal(detail.reviews.length, 1);
    assert.equal(detail.reviews[0].nickname, '伴途·小艾');
    const updated = (await call(base, '/api/v1/places?limit=50', cookie)).data.find((place: any) => place.placeId === placeId);
    assert.deepEqual(updated.reviews, detail.reviews, 'list and detail use the same account-backed reviews');
    assert.deepEqual(updated.demoReviews, []);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('legacy serialized community state loads without likes/comments/sample fields', () => {
  const service = new CommunityService();
  const legacy = JSON.stringify({
    discoveries: [{ id: 'community_old', authorId: 'a', nickname: '旧', name: '旧地点', cityCode: '330100', address: 'x', description: 'y', lat: null, lng: null, createdAt: '2026-01-01T00:00:00.000Z', status: 'shared', evidence: '', decisionNote: '', reviews: [] }],
    posts: [{ id: 'post_old', authorId: 'a', nickname: '旧', text: '旧帖子', createdAt: '2026-01-01T00:00:00.000Z' }],
    contributions: {},
  });
  service.loadSerialized(legacy);
  assert.equal(service.hasSamples(), false);
  const view = service.listPosts('reader')[0];
  assert.equal(view.likes, 0); assert.equal(view.liked, false); assert.equal(view.commentCount, 0); assert.deepEqual(view.comments, []);
  assert.equal(service.list('reader').length, 0, '未审核旧地点不再出现在公共列表');
  assert.equal(service.mine('a').places[0].sample, false, '发布者仍能查看旧地点记录');
  // 旧数组格式（更早期版本）也保持兼容
  const old = new CommunityService();
  old.loadSerialized('[]');
  assert.equal(old.listPosts('r').length, 0);
});
