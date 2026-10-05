import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

test('post favorites: add with snapshot, idempotent, removable, and survives both restart and post withdrawal', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({ seedDemo: false, stateStore: store });
  const start = async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await start();
  const guest = async () => (await fetch(base + '/api/v1/session/guest', { method: 'POST' })).headers.get('set-cookie')!.split(';')[0];
  // 帖子收藏是社区写操作：需要账号身份（游客会话注册后换发新 cookie）。
  const accountCookie = async (name: string) => {
    const cookie = await guest();
    const response = await fetch(base + '/api/v1/account/register', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'password123' }) });
    assert.equal(response.status, 200, `注册账号 ${name} 应成功`);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const call = async (path: string, cookie: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json() as any) };
  };
  try {
    const author = await accountCookie('fav_author'); const reader = await accountCookie('fav_reader');
    const post = (await call('/api/v1/community/posts', author, 'POST', { nickname: '作者', text: '收藏测试帖\n正文' })).data;
    // 收藏：保存足以在原帖撤回后继续阅读的快照
    const added = await call(`/api/v1/community/posts/${post.id}/favorite`, reader, 'POST', {});
    assert.equal(added.status, 200); assert.equal(added.data.favorited, true);
    assert.equal(added.data.postFavorites[0].post.title, '收藏测试帖');
    assert.equal(added.data.postFavorites[0].post.body, '正文', '收藏快照应保留帖子正文');
    assert.equal(added.data.postFavorites[0].post.nickname, '作者');
    // 幂等：重复收藏不产生第二条
    const again = await call(`/api/v1/community/posts/${post.id}/favorite`, reader, 'POST', {});
    assert.equal(again.data.postFavorites.length, 1);
    const unsupported = await call(`/api/v1/community/posts/${post.id}/favorite`, reader, 'GET');
    assert.equal(unsupported.status, 405, 'a read request must never mutate a favorite');
    assert.equal((await call('/api/v1/community/post-favorites', reader)).data.length, 1);
    // 取消收藏
    const removed = await call(`/api/v1/community/posts/${post.id}/favorite`, reader, 'DELETE');
    assert.equal(removed.data.favorited, false);
    assert.equal(removed.data.postFavorites.length, 0);
    // 再收藏一次，然后帖子被作者撤回：快照保留，可辨认原收藏
    await call(`/api/v1/community/posts/${post.id}/favorite`, reader, 'POST', {});
    await call(`/api/v1/community/posts/${post.id}`, author, 'DELETE');
    const list = (await call('/api/v1/community/post-favorites', reader)).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].post.title, '收藏测试帖', '撤回后快照仍可辨认');
    assert.equal(list[0].post.body, '正文', '原帖撤回后仍能阅读已收藏的正文');
    // 不存在的帖子收藏返回 404
    assert.equal((await call('/api/v1/community/posts/post_missing/favorite', reader, 'POST', {})).status, 404);
    const longText = '长'.repeat(80);
    const longPost = (await call('/api/v1/community/posts', author, 'POST', { text: longText })).data;
    const longSnapshot = (await call(`/api/v1/community/posts/${longPost.id}/favorite`, reader, 'POST', {})).data.postFavorites[0].post;
    assert.equal(longSnapshot.title + longSnapshot.body, longText, 'a long single-line post stays readable beyond the title limit');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('post favorites survive a serialize/loadSerialized round-trip (restart persistence path)', async () => {
  const { FavoritesService } = await import(pathToFileURL(join(process.cwd(), 'src', 'services', 'favorites-service.ts')).href) as any;
  const svc = new FavoritesService();
  svc.addPost('reader', { postId: 'p1', nickname: '作者', title: '快照帖', createdAt: '2026-01-01T00:00:00.000Z' });
  const restored = new FavoritesService();
  restored.loadSerialized(svc.serialize());
  assert.equal(restored.listPosts('reader').length, 1);
  assert.equal(restored.listPosts('reader')[0].post.title, '快照帖');

  svc.addPost('reader', { postId: 'p2', nickname: '作者', title: '正文快照帖', body: '正文内容', createdAt: '2026-01-02T00:00:00.000Z' });
  const restoredWithBody = new FavoritesService();
  restoredWithBody.loadSerialized(svc.serialize());
  assert.equal(restoredWithBody.listPosts('reader').find((item: any) => item.post.postId === 'p2')?.post.body, '正文内容');
});
