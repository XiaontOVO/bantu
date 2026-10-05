import { state } from '../lib/store.js';
import { postInteractionPending } from '../lib/post-interaction.js';
import { clockText, escapeHtml } from '../lib/format.js';
import { placeCard } from '../lib/components.js';
import { hasLoadError } from '../lib/load-state.js';

function favoritePlaceCard(place) {
  // 收藏页复用发现地点的完整卡片，避免同一地点在不同入口出现不同按钮。
  // 需要加入计划时，进入地点详情即可操作。
  return placeCard(place);
}

export function renderFavorites() {
  const items = state.favorites || [];
  const posts = (state.postFavorites || []).filter(entry => entry?.post?.postId);
  const postCards = posts.map(({ post }) => {
    const id = post.postId;
    const meta = [post.nickname, clockText(post.createdAt), post.source === 'withdrawn' ? '原帖已撤回，快照保留' : '']
      .filter(Boolean).map(escapeHtml).join(' · ');
    const title = post.source === 'withdrawn'
      ? `<div class="post-open-button"><span class="post-open-heading"><strong>${escapeHtml(post.title || '旅行帖子')}</strong></span>${post.body ? `<span class="post-open-excerpt">${escapeHtml(post.body)}</span>` : ''}</div>`
      : `<a class="post-open-button" href="#/post/${escapeHtml(encodeURIComponent(id))}" data-action="open-post-detail" data-post="${escapeHtml(id)}" aria-label="打开帖子：${escapeHtml(post.title || '旅行帖子')}"><span class="post-open-heading"><strong>${escapeHtml(post.title || '旅行帖子')}</strong></span>${post.body ? `<span class="post-open-excerpt">${escapeHtml(post.body)}</span>` : ''}</a>`;
    const clickable = post.source === 'withdrawn' ? '' : ' post-card-clickable';
    return `<article class="memory-card post-feed-card${clickable}">${title}<span class="post-open-meta">${meta}</span><div class="stop-actions post-feed-actions"><button class="btn-small btn-soft" data-action="favorite-post" data-post="${escapeHtml(id)}" ${postInteractionPending(id,'favorite') ? 'disabled aria-busy="true"' : 'aria-busy="false"'} aria-label="取消收藏帖子：${escapeHtml(post.title || '旅行帖子')}">${postInteractionPending(id,'favorite') ? '正在保存…' : '已收藏'}</button></div></article>`;
  }).join('');
  const placeCards = items.map(item => favoritePlaceCard(item.place)).join('');
  const loadFailed = hasLoadError('favorites');
  const emptyPosts = state.principal?.kind === 'account'
    ? '<div class="card"><p>还没有收藏的帖子。</p></div>'
    : '<div class="card"><p>登录账号后可以收藏帖子；地点收藏可直接使用。</p><button class="btn-primary" data-action="account-panel">登录 / 注册</button></div>';

  return `<div class="page-head"><h2>我的收藏</h2><span class="chip">${loadFailed ? '暂未加载' : `${items.length + posts.length} 个收藏`}</span></div>
    <section aria-labelledby="favorite-posts-heading"><div class="section-head"><h3 id="favorite-posts-heading">帖子 <span class="chip">${loadFailed ? '—' : posts.length}</span></h3></div>
      <div class="content-card-grid" style="margin-top:10px">${postCards || (loadFailed ? '<div class="card"><p>收藏暂未加载，请稍后重试。</p></div>' : emptyPosts)}</div>
    </section>
    <section aria-labelledby="favorite-places-heading"><div class="section-head" style="margin-top:18px"><h3 id="favorite-places-heading">地点 <span class="chip">${loadFailed ? '—' : items.length}</span></h3></div>
      <div class="place-grid" style="margin-top:10px">${placeCards || (loadFailed ? '<div class="card"><p>收藏暂未加载，请稍后重试。</p></div>' : '<div class="card"><p>还没有收藏的地点。</p></div>')}</div>
    </section>`;
}
