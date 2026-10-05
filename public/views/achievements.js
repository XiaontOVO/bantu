import { state } from '../lib/store.js';
import { ownedAchievements } from '../lib/achievements.js';
import { ACHIEVEMENT_TIERS } from '../lib/achievement-rules.js';
import { escapeHtml, cityName } from '../lib/format.js';
import { placeImpression } from '../lib/place-impressions.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';

const e = escapeHtml;
const tierGlyph = level => `<svg class="achievement-seal" viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="17" stroke="currentColor" stroke-width=".7" opacity=".4"/><circle cx="20" cy="20" r="13.5" stroke="currentColor" stroke-width=".6" opacity=".25"/>${level > 2 ? '<path d="m20 8 2.4 8 7.6 4-7.6 3-2.4 9-2.4-9-7.6-3 7.6-4L20 8Z" fill="currentColor" opacity=".12"/>' : ''}<path d="m20 11 2.6 6.4L29 20l-6.4 2.6L20 29l-2.6-6.4L11 20l6.4-2.6L20 11Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>${level === 4 ? '<path d="m10 10 2 2m16 16 2 2m0-20-2 2M12 28l-2 2" stroke="currentColor" stroke-width="1"/>' : ''}</svg>`;
function visitDate(visit, includeTime = false) {
  if (!visit.completedAt) return visit.localDate ? `${visit.localDate.replaceAll('-', '.')} · 旧到访记录` : '旧到访记录 · 日期未记录';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: visit.timezone, year: 'numeric', month: 'short', day: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}) }).format(new Date(visit.completedAt));
}

function collectible(card) {
  const art = placeImpression(card), selected = state.achievementSelected === card.placeId;
  return `<button class="achievement-card tier-${card.tier.level}${selected ? ' is-selected' : ''}" type="button" data-compact-keep-text data-action="select-achievement" data-place="${e(card.placeId)}" aria-pressed="${selected}" aria-label="${e(card.name)}，已游览 ${card.count} 次，${e(card.tier.name)}卡，查看到访记录">
    <span class="achievement-art"><img src="${e(art.src)}" alt="" loading="lazy"><span class="achievement-finish"><span class="achievement-finish-index">${['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'][card.tier.level]}</span>${e(card.tier.name)}</span></span>
    <span class="achievement-card-body"><span class="achievement-place-name">${e(card.name)}</span>
      <span class="achievement-count"><span class="achievement-count-copy"><span>已游览</span><strong>${card.count}<small>次</small></strong></span>${tierGlyph(card.tier.level)}</span>
      <span class="achievement-card-bottom"><span class="achievement-next">${card.nextTier ? `距${e(card.nextTier.name)} · 还需 ${card.nextTier.threshold - card.count} 次` : '珍藏此地 · 期待再次相遇'}</span>
        <span class="achievement-meter" aria-hidden="true"><span style="width:${Math.round(card.progress * 100)}%"></span></span></span>
    </span></button>`;
}

function cardDetails(card) {
  return `<section class="achievement-detail" aria-label="${e(card.name)}的到访记录">
    <div class="achievement-detail-head"><div><span>${e(cityName(card.cityCode))} · ${e(card.tier.name)}卡</span><h3>${e(card.name)}</h3></div><button class="btn-small btn-ghost" data-action="select-achievement" data-place="${e(card.placeId)}" aria-label="收起到访记录">${uiIcon('close')}</button></div>
    <p>${e(card.tier.description)}<span>首次点亮 · ${e(visitDate(card.firstVisit))}</span></p>
    <div class="achievement-detail-actions"><button class="btn-soft" data-action="open-place" data-place="${e(card.placeId)}">${buttonContent('pin', '再去看看')}</button><button class="btn-soft" data-action="navigate" data-view="memories">${buttonContent('compose', '写下记忆')}</button></div>
    <details class="achievement-visits" open><summary>相遇记录 <span>${card.count} 次</span></summary><ol>${card.visits.map(visit => `<li><span class="achievement-visit-dot" aria-hidden="true"></span><div><strong>${e(visitDate(visit, true))}</strong><span>${e(visit.planName)}</span></div><button class="btn-small btn-ghost" ${visit.archived ? 'data-action="view-plan-history"' : 'data-action="achievement-view-plan"'} data-plan="${e(visit.planId)}" data-date="${e(visit.localDate)}" aria-label="查看${e(visit.planName)}的进度记录">${uiIcon('arrow-right')}</button></li>`).join('')}</ol></details>
  </section>`;
}

export function achievementEntry() {
  const data = ownedAchievements();
  return `<section class="achievement-entry"><span class="achievement-entry-mark" aria-hidden="true">${uiIcon('sparkle', { size: 30 })}</span><div><h3>旅行成就</h3><p>${data ? data.summary.placeCount ? `已点亮 ${data.summary.placeCount} 个地点 · ${data.summary.visitCount} 次相遇` : '把每次相遇，收藏成一束光' : '把每次相遇，收藏成一束光'}</p></div><button class="btn-soft" data-action="navigate" data-view="achievements" aria-label="打开旅行成就">${buttonContent('arrow-right', '收藏册')}</button></section>`;
}

export function renderAchievements() {
  const data = ownedAchievements();
  if (!data) return `<div class="page-head"><h2>旅行成就</h2></div><div class="card achievement-empty" role="status">${uiIcon('sparkle', { size: 38 })}<h3>${state.loadStatus?.achievements?.status === 'error' ? '收藏册暂时未加载' : '正在整理你的旅行收藏'}</h3><p>你的到访记录，只有你可见。</p></div>`;
  const { summary, milestones } = data;
  const cards = data.cards.filter(card => state.achievementFilter !== 'shining' || card.tier.level > 1);
  const selected = cards.find(card => card.placeId === state.achievementSelected);
  return `<div class="achievement-page">
    <header class="achievement-hero"><div><span class="achievement-eyebrow">我的旅行收藏册</span><h2>让相遇，慢慢发光</h2><p>新地方值得出发，老地方值得重逢。</p></div><span class="achievement-hero-mark" aria-hidden="true">${uiIcon('sparkle', { size: 54 })}</span><div class="achievement-stats"><div><strong>${summary.placeCount}</strong><span>点亮地点</span></div><div><strong>${summary.visitCount}</strong><span>完成游览</span></div><div><strong>${summary.shiningCount}</strong><span>闪耀收藏</span></div></div></header>
    <section class="achievement-milestones" aria-label="旅行小成就">${milestones.map(item => `<div class="achievement-milestone${item.unlocked ? ' is-unlocked' : ''}"><span class="achievement-badge" aria-hidden="true">${uiIcon(item.icon, { size: 22 })}</span><div><strong>${e(item.name)}</strong><span>${e(item.detail)}</span></div><span class="achievement-badge-status" aria-label="${item.unlocked ? '已点亮' : `${item.current} / ${item.target}`}">${item.unlocked ? uiIcon('check', { size: 18 }) : `${Math.min(item.current, item.target)} / ${item.target}`}</span></div>`).join('')}</section>
    <div class="achievement-collection-head"><h3>地点渐变卡 <span>${cards.length}</span></h3><div class="achievement-filters" role="group" aria-label="筛选收藏卡">${[['all', '全部'], ['shining', '闪耀']].map(([filter, label]) => `<button data-action="filter-achievements" data-filter="${filter}" aria-pressed="${state.achievementFilter === filter}">${label}</button>`).join('')}</div></div>
    ${cards.length ? `<p class="achievement-tap-hint">点击卡片，翻看每一次相遇</p>${selected ? cardDetails(selected) : ''}<div class="achievement-grid">${cards.map(collectible).join('')}</div>` : `<section class="achievement-empty">${uiIcon('sparkle', { size: 38 })}<h3>${summary.placeCount ? '好久不见，期待下一次重逢' : '你的第一张卡，等一次出发'}</h3><p>${summary.placeCount ? '同一地点完成 3 次游览，即可获得珠光卡。' : '在「计划与进度」完成游览，地点卡就会点亮。'}</p><button class="btn-primary" data-action="navigate" data-view="${summary.placeCount ? 'today' : 'places'}">${buttonContent(summary.placeCount ? 'map' : 'pin', summary.placeCount ? '查看行程' : '发现地点')}</button></section>`}
    <details class="achievement-rules"><summary>${uiIcon('info', { size: 16 })}卡片如何发光</summary><div class="achievement-tier-guide">${ACHIEVEMENT_TIERS.map(tier => `<span class="tier-${tier.level}">${uiIcon('sparkle', { size: 18 })}<strong>${tier.name} · ${tier.finish}</strong><small>${tier.threshold} 次游览</small></span>`).join('')}</div><p>只统计你在计划与进度中完成的到访，同一地点可反复游览，每个站次计一次。纠正、删除进度记录后会同步更新；收藏、浏览或进入场景不会增加次数。旧记录保留原事实，不补造具体时刻。收藏册仅自己可见。</p></details>
  </div>`;
}
