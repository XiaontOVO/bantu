/** 社区 · 方案分享：浏览旅人公开分享的行程方案。 */
import { state } from '../lib/store.js';
import { clockText, escapeHtml } from '../lib/format.js';
import { hasLoadError } from '../lib/load-state.js';
import { decodePlanCode } from '../lib/plan-code.js';
import { uiIcon } from '../lib/icons.js';

export function renderPlanShares() {
  const shares = state.planShares || [];
  // 「我的分享」与旅行帖子的「我的发布」同模式：数据来自 /api/v1/community/mine 的 planShares。
  const mineFilter = state.planShareMineFilter === 'mine' ? 'mine' : 'all';
  const mineShares = state.communityMine?.planShares || [];
  const sourceShares = mineFilter === 'mine' ? mineShares : shares;
  const shareCard = share => {
    let decoded = null;
    try { decoded = decodePlanCode(share.code); } catch { /* 老数据无法预览时仍允许撤回或重新尝试导入。 */ }
    const days = decoded?.days || (decoded?.stops ? [{ stops: decoded.stops }] : []);
    const dayCount = days.length || 1;
    const shareCode = share.shareCode || '';
    return `<article class="memory-card plan-share-card"><div class="plan-share-card-heading"><h4 title="${escapeHtml(share.name)}">${escapeHtml(share.name)}</h4><span class="chip">${dayCount} 天</span></div>
        <p class="stop-meta">${share.stopCount} 个地点 · ${escapeHtml(share.cityLabel || share.cityCode)}</p>
        <p class="stop-meta">${escapeHtml(share.nickname)} 分享 · ${escapeHtml(clockText(share.createdAt))}</p>
        ${shareCode ? `<div class="plan-share-code-row"><span>方案码</span><code>${escapeHtml(shareCode)}</code><button class="action-icon" type="button" data-action="copy-plan-share-code" data-code="${escapeHtml(shareCode)}" title="复制方案码" aria-label="复制方案码">${uiIcon('copy', { size: 20 })}</button></div>` : ''}
        <div class="stop-actions plan-share-card-actions"><button class="action-icon labeled-action" data-action="view-plan-share" data-share="${escapeHtml(share.id)}" aria-label="查看方案详情">${uiIcon('note', { size: 18 })}<span>详情</span></button><button class="action-icon action-icon-primary labeled-action" data-action="import-plan-share" data-share="${escapeHtml(share.id)}" aria-label="导入到方案候选">${uiIcon('load', { size: 18 })}<span>导入</span></button>${share.mine ? `<button class="action-icon labeled-action" data-action="ask-withdraw-plan-share" data-share="${escapeHtml(share.id)}" aria-label="撤回分享">${uiIcon('undo', { size: 18 })}<span>撤回</span></button>` : ''}</div>
      </article>`;
  };
  return `<div class="page-head"><div><h2>方案分享</h2></div>
      <button class="btn-soft" data-action="navigate" data-view="plan">去方案候选</button></div>
    <div class="card search-toolbar"><form class="search-row" data-search-form="search-plan-shares" role="search">
      <input id="planShareSearch" value="${escapeHtml(state.planShareQuery || '')}" maxlength="60000" placeholder="搜方案名、分享者或方案码" aria-label="搜索方案分享" />
      <button type="submit" class="action-icon action-icon-primary" data-action="search-plan-shares" title="搜索方案" aria-label="${state.planShareSearching ? '正在搜索方案' : '搜索方案'}" ${state.planShareSearching ? 'disabled aria-busy="true"' : ''}>${uiIcon('search', { size: 21 })}</button>
    </form></div>
    <section class="community-posts-panel plan-shares-panel">
      <div class="community-post-filters" role="group" aria-label="筛选方案分享"><button class="${mineFilter === 'all' ? 'active' : ''}" data-action="community-plan-share-filter" data-filter="all" aria-pressed="${mineFilter === 'all'}">全部分享</button><button class="${mineFilter === 'mine' ? 'active' : ''}" data-action="community-plan-share-filter" data-filter="mine" aria-pressed="${mineFilter === 'mine'}">我的分享<span>${mineShares.length}</span></button></div>
      ${mineFilter === 'all' ? `<div class="section-head"><h3>旅人公开分享</h3><span class="chip">${state.planShareSearching ? '查找中' : hasLoadError('community') ? '暂未加载' : `${shares.length} 套`}</span></div>
      ${state.planShareQuery ? '<p class="plan-share-search-hint">可输入短方案码（BT-…）、方案名或分享者；也支持粘贴完整方案码。</p>' : ''}` : ''}
      <div class="content-card-grid">${sourceShares.map(shareCard).join('') || (mineFilter === 'mine'
        ? (hasLoadError('community') ? '' : '<div class="empty-state"><h3>你还没有分享方案</h3><p>到「方案候选」选择一套方案，点击分享图标，就能在这里管理它。</p></div>')
        : (hasLoadError('community') ? '' : state.planShareQuery
          ? '<div class="empty-state"><h3>没有找到匹配方案</h3><p>检查方案码，或换个方案名、分享者再试试。</p></div>'
          : '<div class="empty-state"><h3>还没有公开方案</h3><p>到「方案候选」选择一套方案，点击分享图标即可。</p></div>'))}</div>
      ${mineFilter === 'all' && state.planShareCursor ? `<button class="feed-more" data-action="more-plan-shares" ${state.planShareLoadingMore ? 'disabled' : ''}>${state.planShareLoadingMore ? '正在加载…' : '加载更多方案'}</button>` : ''}
    </section>`;
}
