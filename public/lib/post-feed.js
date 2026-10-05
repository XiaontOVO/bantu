/** Public post queries and stable pagination; refresh the whole reading window. */
import { api } from './api.js';
import { state } from './store.js';

let postFeedGeneration = 0;
let postFeedContext = null;
let postFeedMoreRequest = null;
let postFeedController = null;
const postFeedQuery = () => String(state.postQuery || '').trim().toLowerCase();
const postFeedOwner = () => state.principal?.principalId;

function fetchPostFeedPage(query, cursor = '', signal) {
  const encodedQuery = encodeURIComponent(query);
  const encodedCursor = encodeURIComponent(cursor || '');
  if (encodedQuery.length + encodedCursor.length > 1000) {
    return api('/api/v1/community/posts/search', {
      method: 'POST', body: JSON.stringify({ query, cursor: cursor || null }), signal,
    }, true);
  }
  return api(`/api/v1/community/posts?stable=1${query ? `&query=${encodedQuery}` : ''}${cursor ? `&cursor=${encodedCursor}` : ''}`, { signal }, true);
}

function isCurrentPostFeed(generation, owner, query) {
  return generation === postFeedGeneration && owner === postFeedOwner() && query === postFeedQuery();
}

function reachesPostFeedBoundary(post, boundary) {
  return post.createdAt < boundary.createdAt || post.createdAt === boundary.createdAt && post.id <= boundary.id;
}

export async function loadPostFeed({ search = false } = {}) {
  postFeedController?.abort();
  const controller = new AbortController(); postFeedController = controller;
  const generation = ++postFeedGeneration;
  const owner = postFeedOwner(), query = postFeedQuery();
  const previous = postFeedContext?.owner === owner && postFeedContext?.query === query &&
    postFeedContext?.list === state.communityPosts ? state.communityPosts : [];
  const boundary = search ? null : previous.at(-1);
  state.postLoadingMore = false;
  state.postSearching = search;
  state.postMoreError = '';
  if (search) { state.postSearching = true; state.postSearchError = ''; }
  try {
    const posts = [], ids = new Set();
    let cursor = '', pageCount = 0;
    do {
      const page = await fetchPostFeedPage(query, cursor, controller.signal);
      if (!isCurrentPostFeed(generation, owner, query)) return;
      for (const post of page.data || []) if (!ids.has(post.id)) { posts.push(post); ids.add(post.id); }
      cursor = page.meta?.nextCursor || null;
      pageCount += 1;
      if (!boundary || !boundary.createdAt || !posts.length || reachesPostFeedBoundary(posts.at(-1), boundary)) break;
      if (pageCount >= 100 && cursor) throw new Error('帖子较多，未能完整恢复阅读范围，请重新加载。');
    } while (cursor);
    if (!isCurrentPostFeed(generation, owner, query)) return;
    state.communityPosts = posts;
    state.postCursor = cursor;
    state.postSearching = false;
    state.postSearchError = '';
    postFeedContext = { owner, query, list: posts };
  } catch (error) {
    if (!isCurrentPostFeed(generation, owner, query)) return;
    if (search) state.postSearchError = error?.message || '帖子搜索失败，请稍后重试。';
    throw error;
  } finally {
    if (isCurrentPostFeed(generation, owner, query)) state.postSearching = false;
  }
}

export function loadMorePostFeed() {
  const generation = postFeedGeneration, owner = postFeedOwner(), query = postFeedQuery();
  if (postFeedMoreRequest?.generation === generation && postFeedMoreRequest?.owner === owner && postFeedMoreRequest?.query === query) return postFeedMoreRequest.promise;
  const cursor = state.postCursor, list = state.communityPosts;
  if (!cursor || state.postSearching || state.postSearchError) return Promise.resolve();
  state.postLoadingMore = true;
  state.postMoreError = '';
  const promise = (async () => {
    try {
      const page = await fetchPostFeedPage(query, cursor, postFeedController?.signal);
      if (!isCurrentPostFeed(generation, owner, query) || state.postCursor !== cursor || state.communityPosts !== list) return;
      const ids = new Set(list.map(post => post.id));
      const next = [...list];
      for (const post of page.data || []) if (!ids.has(post.id)) { next.push(post); ids.add(post.id); }
      state.communityPosts = next;
      state.postCursor = page.meta?.nextCursor || null;
      postFeedContext = { owner, query, list: next };
    } catch (error) {
      if (!isCurrentPostFeed(generation, owner, query)) return;
      state.postMoreError = error?.message || '更多帖子加载失败，请重试。';
      throw error;
    } finally {
      if (isCurrentPostFeed(generation, owner, query)) state.postLoadingMore = false;
      if (postFeedMoreRequest?.promise === promise) postFeedMoreRequest = null;
    }
  })();
  postFeedMoreRequest = { generation, owner, query, promise };
  return promise;
}

export function capturePostFeedAnchor(id) {
  if (typeof document === 'undefined' || typeof window === 'undefined' || state.currentView !== 'community') return null;
  const link = [...document.querySelectorAll('.post-open-button')].find(node => node.dataset.post === id);
  const card = link?.closest('.post-feed-card');
  return card ? { id, top: card.getBoundingClientRect().top, owner: postFeedOwner(), query: postFeedQuery(), filter: state.communityPostFilter } : null;
}

export function restorePostFeedPosition() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const restore = state.postFeedRestore;
  if (!restore) return;
  if (state.currentView !== 'community' || restore.navigationRevision !== state.navigationRevision ||
    restore.owner !== postFeedOwner() || restore.query !== postFeedQuery() || restore.filter !== state.communityPostFilter ||
    Date.now() - restore.createdAt > 30000 || Number.isFinite(restore.expectedY) && Math.abs(window.scrollY - restore.expectedY) > 2) {
    state.postFeedRestore = null; return;
  }
  const card = [...document.querySelectorAll('.post-open-button')].find(node => node.dataset.post === restore.id)?.closest('.post-feed-card');
  if (!card) return;
  const top = window.scrollY + card.getBoundingClientRect().top - restore.top;
  window.scrollTo({ top, behavior: 'instant' });
  restore.expectedY = window.scrollY;
}
