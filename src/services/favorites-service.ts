import type { DemoPlace } from '../demo/demo-data.js';

export interface PlaceEntry { kind: 'place'; place: DemoPlace; savedAt: string }
export interface PostEntry { kind: 'post'; post: { postId: string; nickname: string; title: string; body?: string; createdAt: string; source?: 'active' | 'withdrawn' }; savedAt: string }
type Entry = PlaceEntry | PostEntry;

/**
 * 用户收藏独立于旅行：收藏的地点/帖子都保存快照，来源下架或撤回后仍可辨认原收藏。
 * 旧落盘数据没有 kind 字段，恢复时统一按地点收藏补默认。
 */
export class FavoritesService {
  private entries: Record<string, Entry[]> = {};
  private canReadPost = (_id: string, _actorId: string) => true;
  setPostVisibilityResolver(resolver: (id: string, actorId: string) => boolean) { this.canReadPost = resolver; }
  // 不用参数属性语法：测试会以 strip-only 模式直接运行本 TS 源文件。
  private readonly now: () => string;
  constructor(now: () => string = () => new Date().toISOString()) { this.now = now; }
  list(actorId: string) { return structuredClone((this.entries[actorId] || []).filter(entry => entry.kind !== 'post' || this.canReadPost(entry.post.postId, actorId))); }
  add(actorId: string, place: DemoPlace) {
    const entries = this.entries[actorId] ??= [];
    if (!entries.some(item => item.kind === 'place' && item.place.placeId === place.placeId)) entries.unshift({ kind: 'place', place: structuredClone(place), savedAt: this.now() });
    return this.list(actorId);
  }
  remove(actorId: string, id: string) {
    this.entries[actorId] = (this.entries[actorId] || []).filter(item => !(item.kind === 'place' && item.place.placeId === id));
    return this.list(actorId);
  }
  hasPost(actorId: string, postId: string) { return (this.entries[actorId] || []).some(item => item.kind === 'post' && item.post && item.post.postId === postId); }
  addPost(actorId: string, post: PostEntry['post']) {
    const entries = this.entries[actorId] ??= [];
    if (this.hasPost(actorId, post.postId)) return this.listPosts(actorId);
    entries.unshift({ kind: 'post', post: structuredClone(post), savedAt: this.now() });
    return this.listPosts(actorId);
  }
  removePost(actorId: string, postId: string) {
    this.entries[actorId] = (this.entries[actorId] || []).filter(item => !(item.kind === 'post' && item.post.postId === postId));
    return this.listPosts(actorId);
  }
  markPostWithdrawn(postId: string) {
    for (const entries of Object.values(this.entries)) {
      for (const entry of entries) {
        if (entry.kind === 'post' && entry.post.postId === postId) entry.post.source = 'withdrawn';
      }
    }
  }
  removePostForOthers(postId: string, authorId: string) {
    for (const actorId of Object.keys(this.entries)) {
      if (actorId !== authorId) this.entries[actorId] = (this.entries[actorId] || [])
        .filter(entry => !(entry.kind === 'post' && entry.post.postId === postId));
    }
  }
  listPosts(actorId: string) {
    return structuredClone((this.entries[actorId] || []).filter((item): item is PostEntry => item.kind === 'post' && this.canReadPost(item.post.postId, actorId)));
  }
  serialize() { return JSON.stringify(this.entries); }
  loadSerialized(value: string) {
    const data = JSON.parse(value);
    // 旧格式：地点收藏条目没有 kind 字段；恢复时统一补 kind。
    for (const list of Object.values(data)) {
      for (const entry of list as Array<Record<string, unknown>>) {
        if (!entry.kind) entry.kind = entry.place ? 'place' : 'post';
      }
    }
    this.entries = data;
  }
}
