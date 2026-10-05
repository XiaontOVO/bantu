/** 发现地点：审核通过的旅人地点与平台地点共用同一目录、详情和操作。 */
import { placeCard } from '../lib/components.js';
import { CITIES } from '../lib/cities.js';
import { categoryLabel, cityName, escapeHtml, facilityLabel } from '../lib/format.js';
import { state } from '../lib/store.js';
import { COMMUNITY_STATUS } from './community.js';
import { hasLoadError } from '../lib/load-state.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';

const SORTS = [['newest', '最新'], ['rating', '评分最高'], ['reviews', '评价最多']];
const CITY_OPTIONS = [['', '全部城市'], ...CITIES.map(city => [city.code, city.name])];
const FACILITY_FILTERS = ['indoor', 'outdoor', 'rest_area', 'seat', 'drink', 'food', 'accessible'];
const COST_OPTIONS = [['', '全部'], ['free', '免费'], ['paid', '付费']];
const DURATION_OPTIONS = [['', '全部'], ['short', '≤ 60 分钟'], ['half', '≤ 120 分钟']];
const RATING_OPTIONS = [['', '全部'], ['4', '4 分以上']];

    export function renderPlaces() {
      const query = state.placeQuery.trim().toLowerCase();
      const adv = state.placeAdvanced || {};
      const advFacilities = adv.facilities || [];
      const sort = state.communitySort || 'newest';
      const filtered = state.places.filter((place) => {
        const categoryOk = state.placeCategory === '全部' || (place.tags || []).some(tag => tag.source === 'official' && tag.id === state.placeCategory);
        const queryOk = !query || `${place.name} ${categoryLabel(place.category)} ${(place.tags || []).map(tag => tag.label).join(' ')} ${(place.facilityCodes || []).join(' ')}`.toLowerCase().includes(query);
        const facilityCodes = place.facilityCodes || [];
        const facilityOk = !advFacilities.length || advFacilities.every(code => facilityCodes.includes(code));
        const cost = place.costEstimate;
        const costOk = !adv.cost || (cost ? (adv.cost === 'free' ? cost.upperMinor === 0 : cost.upperMinor > 0) : false);
        const durationOk = !adv.duration || (place.suggestedDurationMinutes ? (adv.duration === 'short' ? place.suggestedDurationMinutes <= 60 : place.suggestedDurationMinutes <= 120) : false);
        const reviews = place.reviews?.length ? place.reviews : (place.demoReviews || []);
        const rating = reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : null;
        const ratingOk = !adv.rating || (rating !== null && rating >= Number(adv.rating));
        return categoryOk && queryOk && facilityOk && costOk && durationOk && ratingOk;
      });
      const visiblePlaces = [...filtered];
      if (sort === 'rating' || sort === 'reviews') {
        const metrics = new Map(visiblePlaces.map(place => {
          const reviews = place.reviews?.length ? place.reviews : (place.demoReviews || []);
          return [place.placeId, { rating: reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : -1, count: reviews.length }];
        }));
        visiblePlaces.sort((a, b) => {
          const left = metrics.get(a.placeId), right = metrics.get(b.placeId);
          return sort === 'rating' ? right.rating - left.rating || right.count - left.count : right.count - left.count || right.rating - left.rating;
        });
      } else if (sort === 'newest') {
        const originalOrder = new Map(visiblePlaces.map((place, index) => [place.placeId, index]));
        visiblePlaces.sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0)
          || originalOrder.get(a.placeId) - originalOrder.get(b.placeId));
      }
      const posts = state.communityPosts || [];
      const mine = state.communityMine || { posts: [], places: [] };
      // 城市筛选以地点目录为准（默认上海，与产品默认目录一致）；点击时同步过滤社区内容。
      const city = state.placeCity || '';
      const activeCount = (state.placeCategory !== '全部' ? 1 : 0) + (sort !== 'newest' ? 1 : 0)
        + (advFacilities.length ? 1 : 0) + (adv.cost ? 1 : 0) + (adv.duration ? 1 : 0) + (adv.rating ? 1 : 0);
      const advancedActive = (advFacilities.length ? 1 : 0) + (adv.cost ? 1 : 0) + (adv.duration ? 1 : 0) + (adv.rating ? 1 : 0);
      const restrictiveFilters = state.placeCategory !== '全部' || advancedActive > 0;
      const loading = state.loadStatus?.places?.status === 'loading';
      const failed = hasLoadError('places');
      const hasMore = state.placesCursor != null;
      const empty = `<div class="card empty-state place-search-empty"><div><h3>没有符合当前条件的地点</h3><p>${query ? '试试其他关键词，或调整筛选。' : '换个城市或调整条件再找找。'}</p></div><div class="stop-actions">${query ? '<button class="btn-soft" data-action="clear-place-search">清除搜索</button>' : ''}${restrictiveFilters ? '<button class="btn-soft" data-action="relax-place-filters" title="取消分类和高级筛选，保留当前城市、关键词与排序">放宽筛选</button>' : ''}${!query || !restrictiveFilters ? '<button class="btn-soft" data-action="open-place-filters">调整筛选</button>' : ''}</div></div>`;
      const chip = (active, attrs, label) => `<button ${attrs} class="${active ? 'active' : ''}" aria-pressed="${active ? 'true' : 'false'}">${label}</button>`;
      return `
        <div class="page-head places-page-head"><div><h2>发现地点</h2></div><button type="button" class="btn-soft" data-action="publish-discovery">${buttonContent('pin-add', '推荐地点')}</button></div>
        <div class="card search-toolbar">
          <form class="search-row" data-search-form="search-places" role="search"><input id="placeSearch" type="search" enterkeyhint="search" value="${escapeHtml(state.placeQuery)}" placeholder="搜索地点或标签" aria-label="搜索地点" /><button type="submit" class="action-icon action-icon-primary" data-action="search-places" title="搜索地点" aria-label="搜索地点" aria-busy="${loading}">${uiIcon('search', { size: 21 })}</button></form>
          <details class="filter-panel" id="placeFilterPanel">
            <summary>筛选与排序<span class="filter-city-label">${escapeHtml(city ? cityName(city) : '全部城市')}</span>${activeCount ? `<span class="chip amber">${activeCount} 项生效</span>` : ''}</summary>
            <div class="chip-row">${[{ id: '全部', label: '全部' }, ...(state.officialTags || [])].map((tag) => chip(state.placeCategory === tag.id, `data-action="filter-places" data-category="${escapeHtml(tag.id)}"`, tag.label)).join('')}</div>
            <div class="chip-row">${SORTS.map(([value, label]) => chip(sort === value, `data-action="community-sort" data-sort="${value}"`, label)).join('')}</div>
            <div class="chip-row">${CITY_OPTIONS.map(([value, label]) => chip(city === value, `data-action="filter-city" data-city="${value}"`, label)).join('')}</div>
            <details class="filter-panel advanced-filter" id="placeAdvancedPanel">
              <summary>高级筛选${advancedActive ? `<span class="chip green">${advancedActive} 项生效</span>` : ''}</summary>
              <div class="filter-group"><span class="filter-label">设施要求</span><div class="chip-row">${FACILITY_FILTERS.map(code => chip(advFacilities.includes(code), `data-action="filter-facility" data-facility="${code}"`, facilityLabel(code))).join('')}</div></div>
              <div class="filter-group"><span class="filter-label">费用</span><div class="chip-row">${COST_OPTIONS.map(([value, label]) => chip(adv.cost === value, `data-action="filter-cost" data-cost="${value}"`, label)).join('')}</div></div>
              <div class="filter-group"><span class="filter-label">建议时长</span><div class="chip-row">${DURATION_OPTIONS.map(([value, label]) => chip(adv.duration === value, `data-action="filter-duration" data-duration="${value}"`, label)).join('')}</div></div>
              <div class="filter-group"><span class="filter-label">旅人评分</span><div class="chip-row">${RATING_OPTIONS.map(([value, label]) => chip(adv.rating === value, `data-action="filter-rating" data-rating="${value}"`, label)).join('')}</div></div>
              <p class="stop-meta">多选设施需同时满足；旅人评分筛选作用于整个地点目录。</p>
              <button class="btn-small btn-ghost" data-action="reset-advanced" ${advancedActive ? '' : 'disabled'}>重置高级筛选</button>
            </details>
          </details>
        </div>
        <section class="places-catalog-head" aria-label="地点目录">
          <div class="section-head"><h3>地点目录</h3><span class="chip" role="status">${loading ? '查询中' : failed ? '暂未加载' : `${hasMore ? '已显示 ' : ''}${visiblePlaces.length} 个地点`}</span></div>
          <p class="stop-meta">这里收录平台地点和审核通过的旅人推荐。未审核或被退回的分享仅自己可见。</p>
        </section>
        <div class="place-grid" style="margin-top:14px">${loading ? '<div class="card place-search-empty" role="status">正在查询地点…</div>' : failed ? '' : visiblePlaces.map((place, index) => placeCard(place, { priority: index < 3 })).join('') || empty}</div>
        ${!loading && !failed && hasMore ? `<div class="place-search-pagination"><p class="stop-meta">还有更多结果，排序和高级筛选作用于已加载地点。</p>${state.placeMoreError ? `<p class="stop-meta" role="alert">${escapeHtml(state.placeMoreError)}</p>` : ''}<button class="btn-soft" data-action="more-places" aria-busy="${state.placesLoadingMore}" ${state.placesLoadingMore ? 'disabled' : ''}>${state.placesLoadingMore ? '正在加载…' : state.placeMoreError ? '重试加载更多' : '加载更多地点'}</button></div>` : ''}
        ${myPlacesSection(mine)}
        <div class="card places-recommend-card">
          <div class="section-head places-recommend-head"><div><h3>旅人推荐</h3><p class="stop-meta">审核通过后，地点会出现在上方目录。审核只确认地点真实且可公开到访；开放时间、费用和设施请出发前确认。</p></div><button class="action-icon action-icon-create" data-action="publish-discovery" title="推荐一个地点" aria-label="推荐一个地点">${uiIcon('pin-add', { size: 22 })}</button></div>
        </div>
      `;
    }

function myPlacesSection(mine) {
  if (!mine.places.length) return '';
  return `<details class="card" style="margin-top:16px"><summary>我分享的地点（${mine.places.length}）</summary>
    ${mine.places.map((item) => `<div class="profile-row"><div><strong>${escapeHtml(item.name)}</strong><span>${COMMUNITY_STATUS[item.status]} · ${item.reviewCount} 条评价</span></div>${item.status === 'approved' && item.placeId
      ? `<div class="stop-actions"><button class="btn-small btn-soft" data-action="open-approved-community-place" data-place="${escapeHtml(item.placeId)}">查看完整地点</button><button class="btn-small btn-ghost" data-action="community-detail" data-id="${escapeHtml(item.id)}">分享管理</button></div>`
      : `<button class="btn-small" data-action="community-detail" data-id="${escapeHtml(item.id)}">查看状态</button>`}</div>`).join('')}
    ${mine.places.some((item) => item.status === 'rejected' && item.decisionNote) ? '<p class="stop-meta">被退回的地点显示审核说明，补充坐标与依据后可以再次提交。</p>' : ''}</details>`;
}
