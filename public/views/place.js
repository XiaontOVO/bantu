/** 地点详情：让每个地点有完整资料、照片位、旅友评论与直接操作。 */
import { cityName, categoryLabel, escapeHtml, facilityList } from '../lib/format.js';
import { state } from '../lib/store.js';
import { favoriteButton, isFavorite } from '../lib/favorite-state.js';
import { findPlace } from '../lib/favorites.js';
import { placeDetailResourceFor, savedPlaceSnapshot } from '../lib/place-detail.js';
import { tagChips } from '../lib/place-tags.js';
import { placeImpression } from '../lib/place-impressions.js';
import { tourSectionHtml } from '../lib/place-tour.js';
import { maybeLoadPlaceNote } from '../lib/place-notes.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';
import { safeLocalPhotoPath } from '../lib/image-viewer.js';
import { placeOpeningInfo } from '../lib/place-opening.js';
import { hasPlaceScene } from '../lib/place-scene-catalog.js';
import { sceneEntryPendingFor, sceneEntryErrorFor } from '../lib/place-scene.js';
import { placeAddTargetDate, dayPlanDraftForDate } from '../lib/plan-draft-target.js';

const CAT_STYLE = {
  landmark: { icon: 'landmark' },
  culture: { icon: 'art' },
  rest: { icon: 'tree' },
  food: { icon: 'food' },
};

const stars = (rating) => '★'.repeat(Math.round(rating)) + '☆'.repeat(Math.max(0, 5 - Math.round(rating)));

function reviewTimeLabel(review, now = Date.now()) {
  if (Number.isFinite(review.daysAgo) && review.daysAgo >= 0) {
    const days = Math.floor(review.daysAgo);
    return days ? `${days} 天前` : '刚刚';
  }
  const createdAt = Date.parse(String(review.createdAt || ''));
  if (!Number.isFinite(createdAt)) return '时间未记录';
  const elapsed = Math.max(0, now - createdAt);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
  return `${Math.floor(elapsed / (24 * 60 * 60_000))} 天前`;
}

function photosFor(place) {
  return (Array.isArray(place.photos) ? place.photos : []).map((photo) => {
    const src = safeLocalPhotoPath(photo?.src);
    if (!src) return null;
    return {
      src,
      alt: typeof photo.alt === 'string' ? photo.alt : `${place.name}实拍照片`,
      caption: typeof photo.caption === 'string' ? photo.caption : place.name,
      credit: typeof photo.credit === 'string' ? photo.credit : '',
      license: typeof photo.license === 'string' ? photo.license : '',
    };
  }).filter(Boolean).slice(0, 12);
}

function photoLicense(photo) {
  if (!photo.license) return '';
  return `<span>${escapeHtml(photo.license)}</span>`;
}

    export function renderPlace() {
      const id = state.placeDetailId;
      if (!id) {
        return '<section class="card empty-state"><h3>选择一个地点</h3><p>查看地点资料，再按自己的节奏安排。</p><button class="btn-primary" data-action="navigate" data-view="places">发现地点</button></section>';
      }
      const resource = placeDetailResourceFor(id);
      const historical = resource?.status === 'missing';
      const place = historical ? savedPlaceSnapshot(id) : findPlace(id);
      if (!place) {
        if (historical) return `<section class="card empty-state" data-place-detail-missing><h3>地点暂不可查看</h3><p>${escapeHtml(resource.message)}</p><div class="place-detail-state-actions"><button class="btn-primary" data-action="retry-place-detail" aria-label="重新核对地点">${buttonContent('refresh','重试')}</button><button class="btn-soft" data-action="back-from-place" aria-label="返回上一页">${buttonContent('arrow-left','返回')}</button></div></section>`;
        if (resource?.status === 'error') return `<section class="card empty-state place-detail-failure" data-place-detail-error role="alert"><span class="place-detail-state-icon">${uiIcon('info',{size:28})}</span><h3>地点资料暂未加载</h3><p>${escapeHtml(resource.message)}</p><div class="place-detail-state-actions"><button class="btn-primary" data-action="retry-place-detail" aria-label="重试加载地点资料">${buttonContent('refresh','重试')}</button><button class="btn-soft" data-action="back-from-place" aria-label="返回上一页">${buttonContent('arrow-left','返回')}</button></div></section>`;
        return `<section class="card empty-state place-detail-loading" data-place-detail-loading role="status" aria-live="polite"><span class="place-detail-state-icon">${uiIcon('refresh',{size:28,className:'scene-entry-spinner'})}</span><h3>正在打开地点…</h3><p>读取地点介绍、照片与游览资料。</p><button class="btn-soft place-detail-loading-return" data-action="back-from-place" aria-label="返回上一页">${buttonContent('arrow-left','返回')}</button></section>`;
      }
      const detailNotice = historical
        ? '<section class="place-detail-notice" data-place-detail-snapshot role="status"><strong>已保存的地点资料</strong><p>这个地点已不在公开目录中。保留原收藏或计划资料供回顾，暂不能加入新计划或进入场景。</p><button class="btn-soft" data-action="retry-place-detail">重新核对</button></section>'
        : resource?.status === 'loading' ? `<p class="place-detail-notice" data-place-detail-loading role="status">${uiIcon('refresh',{size:16,className:'scene-entry-spinner'})}<span>正在核对最新资料…</span></p>`
        : resource?.status === 'error' ? `<section class="place-detail-notice" data-place-detail-error role="alert"><strong>正在显示已加载的资料</strong><p>${escapeHtml(resource.message)}</p><button class="btn-soft" data-action="retry-place-detail">重试加载</button></section>` : '';
      const meta = CAT_STYLE[place.category] || CAT_STYLE.landmark;
      const photos = photosFor(place);
      const impression = placeImpression(place);
      const sceneEntryWaiting = sceneEntryPendingFor(place.placeId);
      const sceneEntryFailure = sceneEntryErrorFor(place.placeId);
      const reviews = (place.reviews?.length ? place.reviews : place.demoReviews) || [];
      const ratingAvg = reviews.length ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1) : null;
      if (!historical) maybeLoadPlaceNote(place.placeId);
      const myNote = state.myPlaceNotes[place.placeId] || '';
      const opening = placeOpeningInfo(place.openingIntervals);
      const statusChip = `<span id="placeOpeningStatus" class="chip ${opening.within === true ? 'green' : opening.within === null ? 'gray' : ''}" data-opening-intervals="${escapeHtml(JSON.stringify(place.openingIntervals || []))}" title="按收录时段与上海时间推算，不代表实时开放状态">${opening.label}</span>`;
      const cityChip = place.cityCode ? `<span class="chip place-city-chip" title="所在城市">${escapeHtml(cityName(place.cityCode))}</span>` : '';
      // 交通指引：高德公交/地铁路线直达该地点（坐标跨坐标系自动换算）。
      const transitLink = (() => {
        const coords = place.coordinates;
        if (!coords) return '';
        const to = coords.source === 'amap' ? [coords.lng, coords.lat] : (typeof window !== 'undefined' && window.gcoord ? window.gcoord.transform([coords.lng, coords.lat], window.gcoord.WGS84, window.gcoord.GCJ02) : null);
        if (!to) return '';
        return `https://uri.amap.com/navigation?to=${to[0]},${to[1]},${encodeURIComponent(place.name)}&mode=bus&coordinate=gaode&callnative=1`;
      })();
      // wide = 真正的长内容（预约提示/链接/备注）才横跨整行；
      // 短条目左右交替铺满两列，避免左列拥挤、右列空。
      const facts = [
        ['clock', '参考开放时段', opening.hours],
        ['timer', '建议停留', place.suggestedDurationMinutes ? `约 ${place.suggestedDurationMinutes} 分钟` : '暂无资料'],
        ['ticket', '费用参考', place.costEstimate ? (place.costEstimate.upperMinor === 0 ? '免费' : `约 ${(place.costEstimate.upperMinor / 100).toFixed(0)} 元`) : '暂无资料'],
        ...(place.phone ? [['phone', '电话', place.phone]] : []),
        ['pin', '位置', place.address ? `${place.address}${place.cityCode ? `（${cityName(place.cityCode)}）` : ''}` : '暂无地址'],
        ['amenities', '设施', facilityList(place.facilityCodes)],
        ...(place.reservationHint ? [['calendar', '预约与购票', place.reservationHint, true]] : []),
      ];
      // 有印象插画的地点可放大查看；占位印象图只作视觉填充，不做放大入口。
      const impressionImage = impression.placeholder
        ? `<img class="place-hero-image" src="${escapeHtml(impression.src)}" alt="${escapeHtml(place.name)}的印象占位图" fetchpriority="high">`
        : `<button type="button" class="place-hero-image-trigger" data-action="zoom-place-image" data-image-src="${escapeHtml(impression.src)}" data-image-alt="${escapeHtml(place.name)}的地点印象插画" data-image-title="${escapeHtml(place.name)}" aria-label="查看${escapeHtml(place.name)}印象图大图" aria-haspopup="dialog"><img class="place-hero-image" src="${escapeHtml(impression.src)}" alt="${escapeHtml(place.name)}的地点印象插画" fetchpriority="high"></button>`;
      const noPhotoBadge = impression.placeholder ? '<span class="place-no-photo">暂无地点印象</span>' : '';
      return `
      ${detailNotice}
      <div class="place-hero has-impression" style="--place-hero-bg:${impression.wash};--place-accent:${impression.accent}">
        ${impressionImage}
        <div class="ph-top"><button class="place-back-btn" data-action="back-from-place" aria-label="返回上一页"><svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M11.8 4.5 6.3 10l5.5 5.5M6.7 10h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>返回</span></button>${!historical || isFavorite(place.placeId) ? favoriteButton(place.placeId) : ''}</div>
        <div class="place-hero-footer"><span class="ph-badge">${uiIcon(meta.icon, { size: 15 })}<span>${escapeHtml(categoryLabel(place.category))}</span></span>${noPhotoBadge}</div>
      </div>
      <section class="place-intro">
        ${place.provider === 'community_reviewed' ? '<span class="chip green place-source-chip">旅人推荐 · 已审核收录</span>' : ''}
        <div class="row-between row-center place-title">
          <h2>${escapeHtml(place.name)}</h2>
          ${ratingAvg ? `<span class="place-rating"><strong>${ratingAvg}</strong><span class="rate-stars" aria-hidden="true">${stars(Math.round(ratingAvg))}</span><span class="stop-meta">${reviews.length} 条评价</span></span>` : ''}
        </div>
        <div class="place-status-chips">${cityChip}${statusChip}</div>
        <p class="stop-meta place-opening-notice">时段仅供参考，休馆日与临时调整请行前核实。</p>
        ${tagChips(place, historical ? '' : 'edit-place-tags')}
        <p class="place-desc">${place.description ? escapeHtml(place.description) : '暂无地点介绍。'}</p>
      </section>
      ${tourSectionHtml(place)}
      <div class="place-support-grid">
      <section class="place-photo-section" aria-labelledby="place-photo-heading">
        <div class="place-detail-actions" role="group" aria-label="地点主要操作">
          <button type="button" class="btn-primary place-main-action" data-action="add-to-plan" data-place="${escapeHtml(place.placeId)}" ${historical ? 'disabled title="这个地点暂不能加入新计划"' : ''} aria-label="${dayPlanDraftForDate(placeAddTargetDate()) ? '加入当前编辑草稿' : '加入计划'}">${buttonContent('pin-add', dayPlanDraftForDate(placeAddTargetDate()) ? '加入草稿' : '加入计划')}</button>
          ${!historical && hasPlaceScene(place) ? `<button type="button" class="btn-soft place-main-action place-scene-entry" ${sceneEntryWaiting ? 'data-action="cancel-scene-entry"' : 'data-action="open-place-scene"'} data-place="${escapeHtml(place.placeId)}" aria-label="${sceneEntryWaiting ? '取消准备' : sceneEntryFailure ? '重试进入' : '进入'}${escapeHtml(place.name)}地点场景">${buttonContent(sceneEntryWaiting ? 'close' : 'scene-enter', sceneEntryWaiting ? '取消等待' : sceneEntryFailure ? '重试进入' : '进入场景')}</button>` : ''}
          ${sceneEntryWaiting ? `<p class="place-scene-entry-status" data-scene-entry-status role="status">${uiIcon('refresh',{size:16,className:'scene-entry-spinner'})}<span>正在准备场景…</span></p>` : sceneEntryFailure ? `<p class="place-scene-entry-status is-error" data-scene-entry-error role="alert">${uiIcon('info',{size:16})}<span>${escapeHtml(sceneEntryFailure.message)}</span></p>` : ''}
        </div>
        <div class="section-head"><div><h3 id="place-photo-heading">实拍照片</h3><p class="stop-meta">${photos.length ? `共 ${photos.length} 张${photos.length > 1 ? ' · 左右滑动' : ''}，点击查看大图` : `暂无${place.name}的实拍照片`}</p></div><span class="chip">${photos.length} 张</span></div>
        ${photos.length ? `<div class="place-photo-gallery">${photos.map(photo => `<figure class="place-photo-item"><button type="button" class="place-photo-link" data-action="zoom-place-photo" data-image-src="${escapeHtml(photo.src)}" data-image-alt="${escapeHtml(photo.alt)}" data-image-title="${escapeHtml(photo.caption)}" aria-label="查看${escapeHtml(photo.caption)}大图" aria-haspopup="dialog"><img src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.alt)}" loading="lazy" decoding="async"><span>查看大图</span></button><figcaption><strong>${escapeHtml(photo.caption)}</strong><span>摄影：${escapeHtml(photo.credit || '摄影者')}</span><span>${photoLicense(photo)}</span></figcaption></figure>`).join('')}</div>` : `<div class="place-photo-empty">${place.name}还没有实拍照片。</div>`}
      </section>
      <section class="card place-facts" aria-label="地点信息">
        ${facts.map(([icon, label, value, wide]) => `<div class="fact${wide ? ' fact-wide' : ''}"><span class="f-ico">${uiIcon(icon, { size: 18 })}</span><div><strong>${label}</strong><span>${escapeHtml(value)}</span></div></div>`).join('')}
        ${transitLink ? `<div class="fact"><span class="f-ico">${uiIcon('train', { size: 18 })}</span><div><strong>交通指引</strong><span><a href="${escapeHtml(transitLink)}" target="_blank" rel="noreferrer">高德公交/地铁路线 →</a></span></div></div>` : ''}
        <div class="fact fact-wide place-note-row" ${historical ? '' : 'data-action="edit-place-note" role="button" tabindex="0"'} data-place="${escapeHtml(place.placeId)}"><span class="f-ico">${uiIcon('note', { size: 18 })}</span><div><strong>我的备注</strong><span>${myNote ? escapeHtml(myNote) : historical ? '暂无已保存备注' : '还没有备注，点击本行即可添加或修改'}</span></div>${historical ? '' : `<span class="place-note-edit">${uiIcon('edit', { size: 15 })}</span>`}</div>
      </section>
      </div>
      <section class="place-reviews">
        <div class="section-head"><h3>旅友评价（${reviews.length}）</h3>${historical ? '' : `<button class="btn-small btn-soft" data-action="write-place-review" data-place="${escapeHtml(place.placeId)}">写评价</button>`}</div>
        <div class="place-review-grid">${reviews.length ? reviews.map((review) => `<article class="review-item"><div class="row-between"><strong>${escapeHtml(review.nickname)}</strong><span class="chip amber">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</span></div><p>${escapeHtml(review.text)}</p><p class="stop-meta review-time">${escapeHtml(reviewTimeLabel(review))}</p></article>`).join('') : '<p class="stop-meta">还没有评价。点击右上角“写评价”添加。</p>'}</div>
      </section>
`;
    }
