import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server/http-server.js';
import { MemoryStateStore } from '../src/persistence/state-store.js';
import { CommunityService } from '../src/services/community-service.js';
import { FavoritesService } from '../src/services/favorites-service.js';

const photo = { dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=', alt:'私人旅行照片' };

test('私密帖子仅作者可读，公共分页、照片、互动与收藏快照均检查权限', () => {
  const service = new CommunityService();
  const post = service.publishPost('author', { text:'私人标题\n私人正文', visibility:'private', images:[photo] }, '伴途·小艾');
  assert.equal(post.visibility, 'private');
  assert.equal(service.mine('author').posts[0].id, post.id);
  for (const actor of ['reader','guest','']) {
    assert.equal(service.postDetail(post.id, actor), null);
    assert.equal(service.postImage(post.id, post.images[0].id, actor), null);
    assert.equal(service.postSnapshot(post.id, actor), null);
    assert.throws(() => service.likePost(actor, post.id), /找不到/);
    assert.throws(() => service.addComment(actor, post.id, {text:'评论'}, '旅人'), /找不到/);
    assert.throws(() => service.removeComment(actor, post.id, 'missing'), /找不到/);
    assert.throws(() => service.updatePostVisibility(actor, post.id, 'public'), /找不到/);
  }
  assert.ok(service.postImage(post.id, post.images[0].id, 'author'));
  assert.equal(service.postSnapshot(post.id, 'author')?.body, '私人正文');
  const publicPost = service.publishPost('author', {text:'公开标题'}, '伴途·小艾');
  assert.equal(publicPost.visibility, 'public');
  for (const actor of ['author','reader']) {
    assert.deepEqual(service.listPosts(actor).map(item => item.id), [publicPost.id]);
    assert.deepEqual(service.listPostPage(actor,null,1).items.map(item => item.id), [publicPost.id]);
    assert.equal(service.listPostPage(actor,null,1).nextCursor, null, '隐藏帖子不产生空的下一页');
  }
  assert.throws(() => service.updatePostVisibility('reader',publicPost.id,'private'), /只能修改自己/);
  assert.throws(() => service.publishPost('author',{text:'无效状态',visibility:'friends'},'小艾'), /请选择/);
  assert.throws(() => service.updatePostVisibility('author',post.id,null), /请选择/);
  assert.equal(service.postDetail(post.id,'author')?.visibility, 'private');
});

test('私密状态可持久化；历史帖子保持公开，未知可见范围按私密恢复', () => {
  const service = new CommunityService();
  const post = service.publishPost('author',{text:'私密日记',visibility:'private'},'小艾');
  const restored = new CommunityService(); restored.loadSerialized(service.serialize());
  assert.equal(restored.postDetail(post.id,'reader'),null);
  assert.equal(restored.postDetail(post.id,'author')?.visibility,'private');
  const legacy = JSON.parse(service.serialize()); delete legacy.posts[0].visibility;
  restored.loadSerialized(JSON.stringify(legacy));
  assert.equal(restored.postDetail(post.id,'reader')?.visibility,'public');
  legacy.posts[0].visibility = 'invalid'; restored.loadSerialized(JSON.stringify(legacy));
  assert.equal(restored.postDetail(post.id,'reader'),null);
  assert.equal(restored.postDetail(post.id,'author')?.visibility,'private');
});

test('收藏读取实时过滤转私密的快照，仍保留已撤回的公开帖子快照', () => {
  const service = new CommunityService();
  const favorites = new FavoritesService();
  favorites.setPostVisibilityResolver((id,actor) => service.canReadPostSnapshot(id,actor));
  const post = service.publishPost('author',{text:'公开标题\n私密后应隐藏的正文'},'小艾');
  favorites.addPost('reader',service.postSnapshot(post.id,'reader')!);
  favorites.addPost('author',service.postSnapshot(post.id,'author')!);
  service.updatePostVisibility('author',post.id,'private');
  assert.equal(favorites.list('reader').length,0);
  assert.equal(favorites.listPosts('reader').length,0);
  assert.equal(favorites.listPosts('author').length,1);
  favorites.removePostForOthers(post.id,'author');
  service.updatePostVisibility('author',post.id,'public');
  assert.equal(favorites.listPosts('reader').length,0,'隐私变更移除的收藏不自动恢复');
  favorites.addPost('reader',service.postSnapshot(post.id,'reader')!);
  service.removePost('author',post.id); favorites.markPostWithdrawn(post.id);
  assert.equal(favorites.listPosts('reader')[0].post.source,'withdrawn');
});

test('HTTP 发布、修改、访问及重启都保持帖子私密，转私密清理他人收藏快照', async () => {
  const store = new MemoryStateStore();
  let server = createHttpServer({seedDemo:false,stateStore:store});
  const start = async () => {
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await start();
  const guest = async () => (await fetch(base+'/api/v1/session/guest',{method:'POST'})).headers.get('set-cookie')!.split(';')[0];
  const register = async (username:string) => {
    const response = await fetch(base+'/api/v1/account/register',{method:'POST',headers:{cookie:await guest(),'content-type':'application/json'},body:JSON.stringify({username,password:'12345678'})});
    assert.equal(response.status,200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const call = async (path:string,cookie:string,method='GET',body?:unknown) => {
    const response = await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,...await response.json() as any};
  };
  try {
    const owner = await register('bantu_privacy_author'), reader = await register('bantu_privacy_reader'), visitor = await guest();
    const created = await call('/api/v1/community/posts',owner,'POST',{text:'旅行秘密\n不可公开的正文',visibility:'private',images:[photo]});
    assert.equal(created.status,200); assert.equal(created.data.visibility,'private');
    const path = '/api/v1/community/posts/'+created.data.id;
    const imagePath = path+'/images/'+created.data.images[0].id;
    assert.equal((await call('/api/v1/community/posts',owner)).data.length,0);
    assert.equal((await call('/api/v1/community/mine',owner)).data.posts.length,1);
    for (const cookie of [reader,visitor]) {
      assert.equal((await call(path,cookie)).status,404);
      assert.equal((await fetch(base+imagePath,{headers:{cookie}})).status,404);
      assert.equal((await call(path,cookie,'PATCH',{visibility:'public'})).status,cookie===visitor?403:404);
    }
    assert.equal((await fetch(base+imagePath,{headers:{cookie:owner}})).status,200);
    assert.equal((await call(path,owner,'PATCH',{visibility:'invalid'})).status,400);
    assert.equal((await call(path,owner,'PATCH',{visibility:'public'})).data.visibility,'public');
    assert.equal((await call(path,reader,'PATCH',{visibility:'private'})).status,403);
    assert.equal((await call(path+'/favorite',reader,'POST')).status,200);
    assert.equal((await call(path+'/like',reader,'POST')).status,200);
    const comment = await call(path+'/comments',reader,'POST',{text:'先前公开时的评论'});
    assert.equal(comment.status,200);
    assert.equal((await call(path,owner,'PATCH',{visibility:'private'})).data.visibility,'private');
    for (const suffix of ['/like','/comments','/favorite']) {
      assert.equal((await call(path+suffix,reader,'POST',{text:'不能评论'})).status,404);
    }
    assert.equal((await call(path+'/comments/'+comment.data.comments[0].id,reader,'DELETE')).status,404);
    assert.equal((await call('/api/v1/community/post-favorites',reader)).data.length,0);
    const serializedFavorites = store.get('bantu-trip-service:favorites');
    assert.ok(serializedFavorites);
    assert.ok(!serializedFavorites.includes('不可公开的正文'), '转私密应从持久化的他人收藏中移除正文');
    assert.equal((await call('/api/v1/community/posts?stable=1&limit=1',reader)).data.length,0);
    assert.equal((await call(path,owner)).data.commentCount,1,'转私密不删除作者的原评论');
    await new Promise<void>(resolve => server.close(()=>resolve()));
    server = createHttpServer({seedDemo:false,stateStore:store}); base = await start();
    assert.equal((await call(path,reader)).status,404);
    assert.equal((await call(path,owner)).data.visibility,'private');
    assert.equal((await call('/api/v1/community/post-favorites',reader)).data.length,0);
    assert.equal((await call(path,owner,'PATCH',{visibility:'public'})).status,200);
    assert.equal((await call('/api/v1/community/post-favorites',reader)).data.length,0);
  } finally { await new Promise<void>(resolve => server.close(()=>resolve())); }
});
