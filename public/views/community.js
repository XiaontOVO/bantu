/** 社区 · 旅行帖子：帖子可关联地点；地点发现、评价与审核在「发现地点」和「我的」。 */
import { state } from '../lib/store.js';
import { clockText, escapeHtml } from '../lib/format.js';
import { hasLoadError } from '../lib/load-state.js';
import { renderJourneyPost } from '../lib/journey-post.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';
import { postInteractionPending } from '../lib/post-interaction.js';

const waitingAttributes = (id, kind) => postInteractionPending(id, kind) ? 'disabled aria-busy="true"' : 'aria-busy="false"';
const commentSend = (id, parent = '') => `<button type="submit" class="action-icon action-icon-primary" data-action="submit-comment" data-post="${escapeHtml(id)}" ${parent ? `data-parent-comment="${escapeHtml(parent)}"` : ''} ${waitingAttributes(id)} title="${postInteractionPending(id)?.kind === 'comment' ? '正在发表评论' : parent ? '发表回复' : '发表评论'}" aria-label="${postInteractionPending(id)?.kind === 'comment' ? '正在发表评论' : parent ? '发表回复' : '发表评论'}">${uiIcon(postInteractionPending(id)?.kind === 'comment' ? 'refresh' : 'send', { size:20,className:postInteractionPending(id)?.kind === 'comment' ? 'scene-entry-spinner' : '' })}</button>`;
const postEngagementButtons = (post, favorited, count = false) => `<button class="btn-small ${post.liked ? 'btn-good' : 'btn-soft'}" data-action="like-post" data-post="${escapeHtml(post.id)}" aria-label="${post.liked ? '取消点赞' : '点赞'}${count ? `，${post.likes} 个赞` : ''}" aria-pressed="${Boolean(post.liked)}" ${waitingAttributes(post.id)}>${postInteractionPending(post.id)?.kind === 'like' ? '正在更新…' : post.liked ? '已点赞' : count ? `点赞 · ${post.likes}` : '点赞'}</button><button class="btn-small btn-soft" data-action="favorite-post" data-post="${escapeHtml(post.id)}" ${waitingAttributes(post.id,'favorite')} aria-label="${favorited ? '取消收藏帖子' : '收藏帖子'}" aria-pressed="${Boolean(favorited)}">${postInteractionPending(post.id,'favorite') ? '正在保存…' : favorited ? '已收藏' : '收藏'}</button>`;

export const COMMUNITY_STATUS = { shared: '未提交审核 · 仅自己可见', pending: '审核中 · 仅自己可见', approved: '已审核收录', rejected: '已退回 · 仅自己可见' };
const postTitleText = (post) => String(post?.text ?? '').split(/\r?\n/)[0] || '';
const postTitle = (post) => escapeHtml(postTitleText(post).slice(0, 60));
const postBodyText = (post) => String(post?.text ?? '').split(/\r?\n/).slice(1).join('\n');
const POST_PREVIEW_LIMIT = 240;
const postBodyPreview = (post) => {
  const body = postBodyText(post);
  return { text: escapeHtml(body.slice(0, POST_PREVIEW_LIMIT)), truncated: body.length > POST_PREVIEW_LIMIT };
};
const isPostFavorited = (postId) => (state.postFavorites || []).some(item => item?.post?.postId === postId);
const postPlaces = post => Array.isArray(post.placeRefs) ? post.placeRefs : (post.placeRef ? [post.placeRef] : []);
function renderPostImages(post, compact = false) {
  const images = Array.isArray(post.images) ? post.images : [];
  if (!images.length) return '';
  const visible = compact ? images.slice(0, 2) : images;
  return `<div class="post-image-gallery${compact ? ' is-compact' : ''}" aria-label="${images.length} 张旅行照片">${visible.map(image => {
    const picture=`<img src="/api/v1/community/posts/${encodeURIComponent(post.id || post.postId)}/images/${encodeURIComponent(image.id)}" alt="${escapeHtml(image.alt || '旅行照片')}" loading="lazy">`;
    return compact ? picture : `<button type="button" class="post-photo-open" data-action="view-post-image" data-post="${escapeHtml(post.id || post.postId)}" data-image="${escapeHtml(image.id)}" aria-label="查看大图：${escapeHtml(image.alt || '旅行照片')}">${picture}</button>`;
  }).join('')}${compact && images.length > visible.length ? `<span class="post-image-overflow">+${images.length - visible.length}</span>` : ''}</div>`;
}
function renderPostPlaces(post, detail = false) {
  const places = postPlaces(post);
  if (!places.length) return '';
  if (!detail) {
    const visibleCount = places.length > 2 ? 1 : 2;
    const visible = places.slice(0, visibleCount).map(place => `<span class="post-open-place">${uiIcon('pin', { size: 14 })} ${escapeHtml(place.name)}</span>`).join('');
    const remaining = places.length - visibleCount;
    return `<span class="post-open-places" aria-label="关联地点：${places.map(place => escapeHtml(place.name)).join('、')}">${visible}${remaining > 0 ? `<span class="post-open-place post-open-place-more">+${remaining}</span>` : ''}</span>`;
  }
  return `<div class="post-detail-places" role="group" aria-label="文中地点">${places.map(place => `<button type="button" class="post-detail-place" data-action="open-place" data-place="${escapeHtml(place.placeId)}" aria-label="查看地点：${escapeHtml(place.name)}" title="查看地点：${escapeHtml(place.name)}">${buttonContent('pin', place.name)}</button>`).join('')}</div>`;
}

const isAccount = () => state.principal?.kind === 'account';
const displayNick = () => state.principal?.nickname || state.principal?.username || '';

export function postComments(post, source = 'feed') {
  const postId = post.id || post.postId;
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const commentIds = new Set(comments.map(comment => comment.id));
  const repliesByParent = new Map();
  const floors = [];
  comments.forEach(comment => {
    const parentId = comment.parentCommentId;
    if (parentId && commentIds.has(parentId) && parentId !== comment.id) {
      const replies = repliesByParent.get(parentId) || [];
      replies.push(comment);
      repliesByParent.set(parentId, replies);
    } else floors.push(comment);
  });
  const safePostId = escapeHtml(postId);
  const renderCommentRow = (comment, floorNumber = 0, parent = null) => {
    const commentTime = clockText(comment.createdAt);
    const nickname = comment.deleted ? '已删除' : (comment.nickname || '旅人');
    const replyForm = comment.deleted ? '' : `<details class="post-comment-reply"><summary>回复</summary>
      <form class="post-comment-form post-comment-reply-form" data-comment-form>
        <div class="post-comment-entry"><input data-comment-draft data-comment-key="${safePostId}:${escapeHtml(comment.id)}" data-post="${safePostId}" placeholder="回复 ${escapeHtml(nickname)}…" maxlength="1000" aria-label="回复 ${escapeHtml(nickname)}">
          ${commentSend(postId,comment.id)}</div>
        <p class="post-comment-draft-status" data-comment-status aria-live="polite" hidden></p>
      </form></details>`;
    return `<article class="post-comment-row${parent ? ' post-comment-reply-row' : ' post-comment-floor-row'}"><span class="post-comment-avatar" aria-hidden="true">${escapeHtml(Array.from(nickname)[0] || '旅')}</span>
      <div class="post-comment-content"><div class="post-comment-meta"><strong>${escapeHtml(nickname)}</strong>${commentTime ? `<small>${escapeHtml(commentTime)}</small>` : ''}${floorNumber ? `<small class="post-comment-floor-label">${floorNumber} 楼</small>` : ''}${parent ? `<small class="post-comment-reply-target">回复 ${escapeHtml(parent.deleted ? '已删除' : (parent.nickname || '旅人'))}</small>` : ''}</div>
      ${comment.deleted ? '<p class="post-comment-deleted">这条评论已删除</p>' : `<p>${escapeHtml(comment.text)}</p>`}${replyForm}</div>${comment.mine && !comment.deleted ? `<button class="btn-small post-comment-delete" data-action="delete-comment" data-post="${safePostId}" data-comment="${escapeHtml(comment.id)}" ${waitingAttributes(postId)} aria-label="删除这条评论">${postInteractionPending(postId)?.kind === 'delete' ? '正在删除…' : '删除'}</button>` : ''}</article>`;
  };
  const items = floors.map((floor, index) => {
    const replies = [];
    const collectReplies = parent => (repliesByParent.get(parent.id) || []).forEach(reply => {
      replies.push(renderCommentRow(reply, 0, parent));
      collectReplies(reply);
    });
    collectReplies(floor);
    return `<section class="post-comment-floor">${renderCommentRow(floor, index + 1)}${replies.length ? `<div class="post-comment-replies">${replies.join('')}</div>` : ''}</section>`;
  }).join('') || '<p class="post-comments-empty">还没有评论，来写第一条。</p>';
  const identity = isAccount() ? `<p class="post-comment-identity">以「${escapeHtml(displayNick())}」的身份评论</p>` : '<p class="post-comment-identity">登录后即可发表评论，自动使用账号昵称。</p>';
  return `<div class="comment-block" id="post-comments-${source}-${safePostId}">${postInteractionPending(postId)?.kind === 'comment' ? '<p class="post-comment-draft-status post-comment-pending" role="status">正在发表评论，输入的新内容会继续保留。</p>' : ''}${items}
    <form class="post-comment-form" data-comment-form>
      <div class="post-comment-entry"><input id="commentText_${safePostId}" data-comment-draft data-comment-key="${safePostId}" data-post="${safePostId}" placeholder="写一条评论，成为第 ${floors.length + 1} 楼…" maxlength="1000" aria-label="评论内容">${commentSend(postId)}</div>${identity}
      <p class="post-comment-draft-status" data-comment-status aria-live="polite" hidden></p>
    </form></div>`;
}

function postCard(post) {
  const favorited = isPostFavorited(post.id);
  const preview = postBodyPreview(post);
  return `<article class="memory-card post-feed-card post-card-clickable"><a class="post-open-button" href="#/post/${escapeHtml(encodeURIComponent(post.id))}" data-action="open-post-detail" data-post="${escapeHtml(post.id)}" aria-label="打开帖子：${postTitle(post)}">
      <span class="post-open-heading"><strong>${postTitle(post)}</strong></span>
      ${preview.text ? `<span class="post-open-excerpt">${preview.text}${preview.truncated ? '…' : ''}</span>` : ''}
      ${post.journeyMemory ? renderJourneyPost(post.journeyMemory, { compact: true, fallbackLocationLabel: post.mine ? state.geoLabel : '' }) : ''}
      ${renderPostImages(post, true)}
      <span class="post-open-meta">${escapeHtml(post.nickname)} · ${escapeHtml(clockText(post.createdAt))}${post.sample ? ' · 样例' : ''}${post.visibility === 'private' ? ' · 仅自己可见' : ''} · 评论 ${post.commentCount}</span>
      ${renderPostPlaces(post)}
    </a>
    <div class="stop-actions post-feed-actions">${postEngagementButtons(post,favorited,true)}</div></article>`;
}

export function renderCommunity() {
  // 社区内容公开可读；点赞、评论、收藏和发布等写操作仍由各自入口要求登录。
  const posts = state.communityPosts || [];
  const minePosts = state.communityMine?.posts || [];
  const postFilter = state.communityPostFilter === 'mine' ? 'mine' : 'all';
  const sourcePosts = postFilter === 'mine' ? minePosts : posts;
  const query = (state.postQuery || '').trim().toLowerCase();
  const waiting = postFilter === 'all' && state.postSearching;
  const searchFailed = postFilter === 'all' && state.postSearchError;
  const visible = waiting || searchFailed ? [] : query ? sourcePosts.filter((post) => `${post.text} ${post.nickname || ''}`.toLowerCase().includes(query)) : sourcePosts;
  const emptyMessage = waiting ? '<p role="status">正在搜索全部公开帖子…</p>' : searchFailed
    ? `<div class="post-search-error" role="alert"><p>${escapeHtml(state.postSearchError)}</p><button class="btn-soft" data-action="retry-post-search">重新搜索</button></div>`
    : hasLoadError('community') ? '' : query
    ? '<p>没有匹配的帖子，换个关键词试试。</p>'
    : postFilter === 'mine' ? '<p>你还没有发布帖子。</p>' : '<p>还没有帖子。</p>';
  return `<div class="page-head community-page-head"><h2>旅行帖子</h2><button class="action-icon action-icon-create" data-action="write-post" title="写帖子" aria-label="写帖子">${uiIcon('compose', { size: 22 })}</button></div>
    <div class="card search-toolbar"><form class="search-row${query ? ' post-search-with-query' : ''}" data-search-form="search-posts" role="search"><input id="postSearch" maxlength="10000" placeholder="搜索帖子内容或昵称" aria-label="搜索帖子" value="${escapeHtml(state.postQuery || '')}">${query ? `<button type="button" class="action-icon" data-action="clear-post-search" title="清除搜索" aria-label="清除搜索">${uiIcon('close', { size:20 })}</button>` : ''}<button type="submit" data-action="search-posts" class="action-icon action-icon-primary" title="搜索帖子" aria-label="搜索帖子" aria-busy="${waiting}">${uiIcon('search', { size: 21 })}</button></form></div>
    <section class="community-posts-panel" aria-label="帖子列表">
      <div class="community-post-filters" role="group" aria-label="筛选帖子"><button class="${postFilter === 'all' ? 'active' : ''}" data-action="community-post-filter" data-filter="all" aria-pressed="${postFilter === 'all'}">全部帖子</button><button class="${postFilter === 'mine' ? 'active' : ''}" data-action="community-post-filter" data-filter="mine" aria-pressed="${postFilter === 'mine'}">我的发布<span>${minePosts.length}</span></button></div>
      <div class="content-card-grid" aria-busy="${waiting}">${visible.map(postCard).join('') || emptyMessage}</div>${postFilter === 'all' && state.postMoreError ? `<p class="post-more-error" role="alert">${escapeHtml(state.postMoreError)}</p>` : ''}${postFilter === 'all' && !waiting && !searchFailed && state.postCursor ? `<button class="feed-more" data-action="more-posts" ${state.postLoadingMore ? 'disabled aria-busy="true"' : ''}>${state.postLoadingMore ? '正在加载…' : state.postMoreError ? '重试加载更多' : '更多帖子'}</button>` : ''}</section>`;
}

function postBackNavigation(label) {
  return `<nav class="post-detail-toolbar" aria-label="帖子导航"><button class="post-back-link" data-action="back-from-post">${label}</button></nav>`;
}

function postReturnLabel() {
  return state.postReturnView === 'agent' ? '返回伴途' : state.postReturnView === 'favorites' ? '返回我的收藏' : '返回帖子列表';
}

export function renderPostDetail() {
  const post = state.postDetail?.id === state.postDetailId ? state.postDetail : null;
  if (!post) {
    const loading = state.loadStatus?.['post-detail']?.status === 'loading';
    const loadError = state.loadStatus?.['post-detail']?.message || '';
    return `<div class="post-detail-shell">${postBackNavigation(postReturnLabel())}
      <section class="card post-detail-state" role="status"><span class="post-detail-state-icon" aria-hidden="true">${loading ? '…' : '帖'}</span><h2>${loading ? '正在打开帖子' : '帖子暂时无法显示'}</h2>
        <p>${loading ? '正在读取正文和评论。' : escapeHtml(loadError || '帖子可能已撤回，或暂时加载失败。你可以稍后再试。')}</p>${loading ? '' : '<button class="btn-primary btn-small" data-action="retry-current-view">重新加载</button>'}</section></div>`;
  }
  const title = postTitleText(post);
  const body = postBodyText(post);
  const createdAt = clockText(post.createdAt);
  const nickname = post.nickname || '旅人';
  const favorited = isPostFavorited(post.id);
  const likes = Number.isSafeInteger(post.likes) ? post.likes : 0;
  const commentCount = Number.isSafeInteger(post.commentCount) ? post.commentCount : (post.comments || []).length;
  return `<div class="post-detail-shell">${postBackNavigation(postReturnLabel())}
    <article class="card post-detail-card">
      <header class="post-detail-author"><span class="post-avatar" aria-hidden="true">${escapeHtml(Array.from(nickname)[0] || '旅')}</span><div><strong>${escapeHtml(nickname)}</strong><span>${escapeHtml(createdAt)}${post.sample ? ' · 样例' : ''}${post.visibility === 'private' ? ' · 仅自己可见' : ''}</span></div>${post.mine ? '<span class="post-author-badge">作者</span>' : ''}</header>
      <h1>${escapeHtml(title)}</h1>
      ${body ? `<div class="post-detail-body">${escapeHtml(body)}</div>` : '<p class="post-detail-empty-body">作者还没写正文。</p>'}
      ${post.journeyMemory ? renderJourneyPost(post.journeyMemory, { fallbackLocationLabel: post.mine ? state.geoLabel : '' }) : ''}
      ${renderPostImages(post)}
      ${renderPostPlaces(post, true)}
      <footer class="post-detail-engagement"><div class="post-detail-stats"><span><strong>${likes}</strong> 赞</span><span><strong>${commentCount}</strong> 评论</span></div>
        <div class="stop-actions post-detail-actions">${postEngagementButtons(post,favorited)}${post.mine ? `<button class="btn-small btn-soft" data-action="post-visibility" data-post="${escapeHtml(post.id)}">可见范围</button><button class="btn-small post-withdraw-action" data-action="withdraw-post" data-post="${escapeHtml(post.id)}">撤回帖子</button>` : ''}</div>
      </footer>
    </article>
    <section class="card post-detail-comments" aria-labelledby="postCommentsTitle"><header class="post-comments-heading"><div><p>聊一聊</p><h2 id="postCommentsTitle">评论</h2></div><span class="post-comments-count">${commentCount}</span></header>${postComments(post, 'post-detail')}</section></div>`;
}
