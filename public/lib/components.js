import { itineraryTiming, completedVisitLabel } from './itinerary-timing.js';
import { favoriteButton, isFavorite } from './favorite-state.js';
import { tagChips } from './place-tags.js';
import { placeImpression } from './place-impressions.js';
/**
 * 视图共用片段：多个页面都会用到的展示单元。
 *
 * 这些函数只**产出 HTML 字符串**，不绑定事件——按钮一律靠 data-action，
 * 由 app.js 的统一委托处理。这样片段可以在任何页面复用，也便于单独推理。
 */
import { STATUS_LABEL, categoryLabel, cityName, dateKeyInTimeZone, escapeHtml, facilityList, fmt, fmtWithDay, formatTimeRange } from './format.js';
import { state } from './store.js';
import { cachedPlaceDetail } from './place-detail.js';
import { uiIcon } from './icons.js';
import { buttonContent } from './button-content.js';
import { transportPickerHtml } from './transport-picker.js';
import { TRANSPORT_LABELS } from './transport-modes.js';
import { stopTransportMode } from './stop-transport.js';

/** 计划节点只保存 placeId；优先从地点目录取最新资料，兼容旧数据里的嵌入快照。 */
export function resolveStopPlace(stop) {
  const placeId = stop?.placeId || stop?.place?.placeId;
  if (!placeId) return stop?.place || null;
  const sources = [...(state.places || []), ...(state.mapPlaces || [])];
  const byId = cachedPlaceDetail(placeId) || sources.find(place => place?.placeId === placeId);
  if (byId) return byId;
  // 旧版方案码曾把自己的 stopId 当作地点 ID；只有目录中唯一同名时才采用名称映射，
  // 避免同名地点被错误合并。
  const name = String(stop?.place?.name || stop?.name || '').trim().replace(/\s+/g, '');
  if (name) {
    const matches = sources.filter(place => String(place?.name || '').trim().replace(/\s+/g, '') === name);
    if (matches.length === 1) return matches[0];
  }
  return stop?.place || null;
}

    export function proposalBanner() {
      if (!state.proposal) return '';
      return `<div class="card" style="border-color:#9fc0ff">
        <div class="row-between"><div><strong>有一份新安排，等你看看</strong><p class="stop-meta">先比较保留和改变的安排，确认后再更新行程。</p></div>
        ${state.currentView === 'today' ? '<span class="stop-meta">在“方案候选”中查看</span>' : '<button class="btn-primary btn-small" data-action="navigate" data-view="plan">查看候选</button>'}</div></div>`;
    }
    export function placeCard(place, { priority = false } = {}) {
      // 主内容使用原生链接，收藏按钮保留在链接外，避免 role=link 卡片里再嵌套按钮。
      const reviews = place.reviews?.length ? place.reviews : (place.demoReviews || []);
      const rating = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : null;
      const snippet = place.description || '';
      const facilities = Array.isArray(place.facilityCodes) && place.facilityCodes.length
        ? facilityList(place.facilityCodes) : '';
      const address = [String(place.address || '').trim(), place.cityCode ? cityName(place.cityCode) : ''].filter(Boolean).join(' · ');
      const sourceBadge = place.provider === 'community_reviewed' ? '<span class="chip green place-source-chip">旅人推荐 · 已审核</span>' : place.provider === 'amap' ? '<span class="chip place-source-chip">地图地点</span>' : '';
      const placeId = escapeHtml(place.placeId);
      const impression = placeImpression(place);
      const impressionClass = impression.placeholder ? ' has-impression is-placeholder' : ' has-impression';
      const impressionStyle = ` style="--place-accent:${impression.accent};--place-wash:${impression.wash}"`;
      const duration = Number.isFinite(place.suggestedDurationMinutes) && place.suggestedDurationMinutes > 0
        ? `约 ${place.suggestedDurationMinutes} 分钟` : '暂无资料';
      const cost = place.costEstimate;
      const lower = cost?.lowerMinor, upper = cost?.upperMinor;
      const currency = cost?.currency === 'CNY' ? '¥' : String(cost?.currency || '');
      const money = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value / 100);
      const fee = Number.isFinite(upper) && upper >= 0
        ? upper === 0 ? '免费' : Number.isFinite(lower) && lower >= 0 && lower < upper ? `${currency}${money(lower)}–${money(upper)}` : `约 ${currency}${money(upper)}`
        : Number.isFinite(lower) && lower >= 0 ? `${currency}${money(lower)} 起` : '暂无资料';
      return `<article class="place-card${impressionClass} ${isFavorite(place.placeId) ? 'favorite-place' : ''}"${impressionStyle}>
        <a class="place-card-main" href="#/place/${escapeHtml(encodeURIComponent(place.placeId))}" data-action="open-place" data-place="${placeId}" aria-label="查看 ${escapeHtml(place.name)} 详情">
        <div class="place-photo${impressionClass}" data-impression="${escapeHtml(impression.key)}"><img class="place-impression-image" src="${escapeHtml(impression.src)}" alt="" loading="${priority ? 'eager' : 'lazy'}" decoding="${priority ? 'sync' : 'async'}"></div>
        <div class="place-body">
          <div class="place-card-heading row-between row-center"><h4>${escapeHtml(place.name)}</h4><span class="place-card-rating">${rating ? `<span class="chip amber">★ ${rating}</span>` : ''}</span></div>
          <div class="place-card-tag-slot">${sourceBadge}${place.provider === 'amap' && !place.tags?.length ? '' : tagChips(place, undefined, { includeProviderTag: false })}</div>
          ${snippet ? `<p class="place-desc">${escapeHtml(snippet)}</p>` : ''}
          ${(duration !== '暂无资料' && place.provider !== 'amap') || fee !== '暂无资料' ? `<div class="place-card-facts">${duration !== '暂无资料' && place.provider !== 'amap' ? `<div class="place-card-fact"><span>${uiIcon('timer', { size: 14 })}建议停留</span><strong>${escapeHtml(duration)}</strong></div>` : ''}${fee !== '暂无资料' ? `<div class="place-card-fact"><span>${uiIcon('ticket', { size: 14 })}费用参考</span><strong>${escapeHtml(fee)}</strong></div>` : ''}</div>` : ''}
          <p class="place-facilities${facilities ? '' : ' is-empty'}"${facilities ? '' : ' aria-hidden="true"'}>${facilities ? `设施：${escapeHtml(facilities)}` : ''}</p>
        </div>
        </a>
        <div class="stop-actions place-card-footer">${address ? `<a class="place-card-address" href="#/place/${escapeHtml(encodeURIComponent(place.placeId))}" data-action="open-place" data-place="${placeId}" title="${escapeHtml(address)}" aria-label="查看 ${escapeHtml(place.name)}：${escapeHtml(address)}">${uiIcon('pin', { size: 14 })}<span>${escapeHtml(address)}</span></a>` : ''}${favoriteButton(place.placeId)}</div>
      </article>`;
    }
    export function timelineItem(stop, index, section, mode = 'execute', planId = '', executionEvents = null, timingSnapshot = null) {
      const place = resolveStopPlace(stop);
      const name = place?.name || stop.placeId || stop.stopId;
      const status = stop.status || 'planned';
      const snapshot = timingSnapshot || state.trip?.snapshot;
      const timing = itineraryTiming(stop, snapshot);
      const selectedTransportMode = stopTransportMode(stop, snapshot);
      const transportLabel = TRANSPORT_LABELS[selectedTransportMode] || '交通';
      const timezone = snapshot?.timezone || 'Asia/Shanghai';
      const plannedStart = [stop.startMinutes, stop.plannedStartMinutes, stop.plannedArrivalMinutes].find(value => Number.isFinite(value));
      const plannedDuration = [stop.plannedDurationMinutes, stop.minDurationMinutes,
        Number.isFinite(stop.durationSeconds) ? stop.durationSeconds / 60 : undefined]
        .find(value => Number.isFinite(value) && value > 0) || 0;
      const plannedEnd = Number.isFinite(stop.endMinutes) ? stop.endMinutes
        : Number.isFinite(plannedStart) ? plannedStart + plannedDuration : NaN;
      let currentMinute = NaN;
      if (mode === 'dated' && status === 'planned' && snapshot?.localDate === dateKeyInTimeZone(new Date(), timezone)) {
        try {
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
          currentMinute = Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
        } catch { /* Invalid legacy timezones should not break the plan view. */ }
      }
      const timeElapsed = Number.isFinite(plannedEnd) && Number.isFinite(currentMinute) && plannedEnd < currentMinute;
      const actions = [];
      let timeAction = '';
      const activePlan = (state.savedPlans || []).find(plan => plan.kind === 'plan' &&
        (plan.stops || []).some(item => (plan.id !== planId || item.stopId !== stop.stopId) && ['en_route', 'visiting'].includes(item.status)));
      const activeStop = activePlan?.stops.find(item => (activePlan.id !== planId || item.stopId !== stop.stopId) && ['en_route', 'visiting'].includes(item.status));
      const anotherActive = Boolean(activeStop);
      const placeId = stop.placeId || stop.place?.placeId;
      const visits = placeId ? (snapshot?.stops || []).filter(item => item.status !== 'skipped' && (item.placeId || item.place?.placeId) === placeId)
        .map((item, position) => ({ item, order: item.originalPlanOrder ?? position }))
        .sort((left, right) => left.order - right.order).map(entry => entry.item) : [];
      const visitIndex = visits.findIndex(item => item.stopId === stop.stopId);
      const visitLabel = visits.length > 1 && visitIndex >= 0 ? `<span class="stop-visit-label">第 ${visitIndex + 1} 次到访</span>` : '';
      const activePlace = activeStop ? resolveStopPlace(activeStop) : null;
      const departureBlocked = (mode === 'execute' || mode === 'dated') && status === 'planned' && anotherActive
        ? `<div class="stop-departure-blocked" role="note"><span>「${escapeHtml(activePlace?.name || activeStop.stopId)}」${escapeHtml(STATUS_LABEL[activeStop.status])}；请先${activeStop.status === 'visiting' ? '完成这次游览' : '到达并完成，或中止这次出发'}，再开始本次到访。</span><button class="btn-small btn-soft" data-action="view-active-plan-visit" data-plan="${escapeHtml(activePlan.id)}" data-stop="${escapeHtml(activeStop.stopId)}">${buttonContent('arrow-right', '查看进行中')}</button></div>`
        : '';
      const executionDisabled = state.executionPending || state.stopTransportPending ? ' disabled aria-disabled="true"' : '';
      // mode：'execute'=当天（记录进度并规划）；'plan'=未来（只编辑日计划）；'readonly'=只读查看。
      const canExecute = mode === 'execute' || mode === 'dated';
      const canPlan = mode === 'execute' || mode === 'plan' || mode === 'dated';
      const eventList = executionEvents || snapshot?.executionEvents || [];
      if (section === 'progress' && mode !== 'plan' && eventList.some(event => event.stopId === stop.stopId)) actions.push(`<button class="btn-small btn-soft" data-action="correct-progress" data-stop="${escapeHtml(stop.stopId)}"${mode === 'dated' ? ` data-plan="${escapeHtml(planId)}"` : ''}>${buttonContent('repair', '纠正进度')}</button>`);
      if (canPlan && status === 'planned') {
        if (mode === 'plan' || mode === 'dated') {
          if (planId) {
            timeAction = `<button class="btn-small btn-soft" data-action="edit-plan-stop-time" data-plan="${escapeHtml(planId)}" data-stop="${escapeHtml(stop.stopId)}">${buttonContent('clock', '调整时间')}</button>`;
            if (!canExecute) actions.push(`<button class="btn-small btn-ghost" data-action="ask-remove-plan-stop" data-plan="${escapeHtml(planId)}" data-stop="${escapeHtml(stop.stopId)}">移除</button>`);
          }
          if (mode === 'dated') actions.push(transportPickerHtml(selectedTransportMode, { action: 'pick-stop-mode', data: { stop: stop.stopId, plan: planId || '' }, compact: true, disabled: state.executionPending || state.stopTransportPending }));
        } else {
          actions.push(transportPickerHtml(selectedTransportMode, { action: 'pick-stop-mode', data: { stop: stop.stopId, plan: planId || '' }, compact: true, disabled: state.executionPending || state.stopTransportPending }));
          timeAction = `<button class="btn-small btn-soft" data-action="edit-stop-time" data-stop="${escapeHtml(stop.stopId)}">${buttonContent('clock', '调整时间')}</button>`;
        }
      }
      if (canExecute && status === 'planned') {
        actions.push(`<button class="btn-small btn-good" data-action="exec" data-stop="${escapeHtml(stop.stopId)}" data-type="depart" ${anotherActive ? 'disabled title="请先完成或中止正在进行的地点"' : ''}>${buttonContent('arrow-right', '出发')}</button>`);
      }
      if (canExecute && status === 'planned') {
        actions.push(`<button class="btn-small btn-ghost skip-stop" data-action="exec" data-stop="${escapeHtml(stop.stopId)}" data-type="skip">${buttonContent('skip', '跳过')}</button>`);
        if (mode === 'dated' && planId) actions.push(`<button class="btn-small btn-ghost" data-action="backfill-progress" data-plan="${escapeHtml(planId)}" data-stop="${escapeHtml(stop.stopId)}">${buttonContent('note', '补记进度')}</button>`);
      } else if (canExecute && status === 'en_route') {
        actions.push(`<button class="btn-small btn-good" data-action="exec" data-stop="${escapeHtml(stop.stopId)}" data-type="arrive">${buttonContent('pin', '到达')}</button>`);
        actions.push(`<button class="btn-small btn-ghost" data-action="exec" data-stop="${escapeHtml(stop.stopId)}" data-type="abort">${buttonContent('close', '中止')}</button>`);
      } else if (canExecute && status === 'visiting') {
        actions.push(`<button class="btn-small btn-good" data-action="exec" data-stop="${escapeHtml(stop.stopId)}" data-type="complete">${buttonContent('check', '完成')}</button>`);
      }
      // 日计划本身就是执行载体；今天的日计划与旧的 execute 视图都应提供导航入口。
      if (['execute', 'dated'].includes(mode) && ['en_route', 'visiting'].includes(status)) actions.push(`<button class="btn-small btn-ghost" data-action="route-detail" data-stop="${escapeHtml(stop.stopId)}">${buttonContent('compass', '路线与导航')}</button>`);
      const chipClass = status === 'completed' ? 'green' : status === 'en_route' || status === 'visiting' ? 'amber' : status === 'skipped' ? 'gray' : '';
      const forecastMinutes = [stop.forecastStartMinutes, stop.startMinutes, stop.plannedStartMinutes].find(Number.isFinite);
      const earlyMorning = status !== 'completed' && Number.isFinite(forecastMinutes) && forecastMinutes % 1440 < 360;
      if (earlyMorning && status === 'planned' && ['dated', 'plan'].includes(mode) && planId && state.savedPlans.some(plan => plan.id === planId && plan.kind === 'plan') && !stop.timeLocked && !stop.lockTime && !stop.visitWindow && !eventList.some(event => event.stopId === stop.stopId)) {
        actions.push(`<button class="btn-small btn-soft" data-action="open-daytime-plan" data-plan="${escapeHtml(planId)}" data-stop="${escapeHtml(stop.stopId)}">${buttonContent('calendar', '移到白天')}</button>`);
      }
      const plannedTravel = status === 'planned'
        ? `<div class="itinerary-phase"><div class="itinerary-phase-heading"><strong>前往景点</strong></div><span>${timing.minutes === null ? '路线时间待估' : `${transportLabel}约 ${timing.minutes} 分钟`}</span><small>${timing.minutes === null ? '出发时会按当前位置规划路线并更新预计时间' : '出发时会按当前位置重新规划，更新预计时间'}</small></div>`
        : '';
      return `<article class="stop-card ${status} ${index == null ? 'without-number' : ''}" data-plan-stop="${escapeHtml(stop.stopId || '')}">
        ${index == null ? '' : `<div class="stop-dot">${index + 1}</div>`}
        <div class="stop-body">
          <div class="row-between stop-heading"><div><h4>${escapeHtml(name)}</h4>${visitLabel}</div>
          <span class="stop-status-flags"><span class="chip ${timeElapsed ? 'amber' : chipClass}">${timeElapsed ? '已过时' : mode === 'plan' && status === 'planned' ? '计划中' : STATUS_LABEL[status] || status}</span>${earlyMorning ? '<span class="chip amber" title="预计在次日凌晨 00:00–06:00，建议核对安排">凌晨时段</span>' : ''}</span></div>
          <div class="itinerary-phases">
            ${plannedTravel}
            ${status === 'en_route' ? `<div class="itinerary-phase phase-active"><div class="itinerary-phase-heading"><strong>前往景点</strong></div><span>${timing.departure === null ? '出发 待定 → 到达 待定' : `${fmtWithDay(timing.departure)} 出发 → ${timing.arrival === null || timing.arrivalEstimated ? '到达 待定' : `${timing.arrivalIsForecast ? '预计 ' : ''}${fmtWithDay(timing.arrival)} 到达`}`}</span><small>${timing.minutes === null ? '未取得实际路线时间；可在地图与路线查看' : `${({walking:'步行',transit:'公共交通',driving:'驾车'})[timing.mode] || '交通'}约 ${timing.minutes} 分钟${timing.estimated ? '（自动估算）' : '（含缓冲）'}`}</small></div>` : ''}
          <div class="itinerary-phase ${status === 'visiting' ? 'phase-active' : ''}"><div class="itinerary-phase-heading"><strong>游览景点</strong>${timeAction || ''}</div><span>${(() => {
          if (status === 'completed') return completedVisitLabel(stop, { ...snapshot, executionEvents: eventList });
            const plannedStart = [stop.forecastStartMinutes, stop.startMinutes, stop.plannedStartMinutes, stop.plannedArrivalMinutes]
            .find(value => Number.isFinite(value));
          const duration = [stop.plannedDurationMinutes, stop.minDurationMinutes,
            Number.isFinite(stop.durationSeconds) ? stop.durationSeconds / 60 : undefined,
            Number.isFinite(stop.endMinutes) && Number.isFinite(stop.startMinutes)
              ? stop.endMinutes - stop.startMinutes : undefined]
            .find(value => Number.isFinite(value) && value > 0) || 0;
          // 游览窗口：已到达/完成用实际开始时间；未到达按预计到达时间；提前到达则按计划开始。
          let arriveAt;
          if (status === 'en_route') {
            // 早于计划到达时游览从计划时间开始（与「到达后等待 X 分钟」口径一致），窗口不能同时从到达时刻算起。
            arriveAt = timing.arrival !== null ? Math.max(timing.arrival, plannedStart ?? timing.arrival) : (plannedStart ?? 0);
          } else if (status === 'visiting' && timing.arrival !== null) {
            arriveAt = timing.arrival;
          } else {
            arriveAt = plannedStart ?? 0;
          }
          if (status === 'visiting' && stop.executionOverdue) return `${fmtWithDay(arriveAt)} 开始 · 仍在游览中`;
          const projected = Number.isFinite(stop.forecastStartMinutes) && stop.forecastStartMinutes !== stop.startMinutes;
          return `${projected && status === 'planned' ? '预计 ' : ''}${formatTimeRange(arriveAt, arriveAt + Math.min(duration, 1440))} · ${Math.min(duration, 1440)} 分钟`;
        })()}${status === 'en_route' && timing.waiting ? ` · 到达后等待 ${timing.waiting} 分钟` : ''}</span></div>
          </div>${status === 'en_route' && timing.departureConflict ? '<p class="stop-meta">出发时间早于上一站离开时间，请纠正相关实际进度。</p>' : ''}${status === 'en_route' && timing.overlap ? '<p class="stop-meta">路线预计到达晚于原计划，后续预计时段已更新。</p>' : ''}
            ${stop.executionOverdue ? '<p class="stop-meta stop-overdue-note">已超过预计时段，实际进度仍保留；请记录到达、完成或纠正进度。</p>' : ''}
            ${stop.forecastConflict ? '<p class="stop-meta stop-overdue-note">路线预计无法赶上固定时段，请核对预约或调整后续安排。</p>' : ''}
            ${timeElapsed ? '<p class="stop-meta stop-overdue-note">计划时段已过；可调整时间或补记真实进度。</p>' : ''}
            ${departureBlocked}
            ${state.executionPending?.stopId === stop.stopId ? '<p class="stop-meta" role="status">正在保存进度……</p>' : ''}
            ${actions.length ? `<div class="stop-actions stop-itinerary-actions">${actions.join('').replace(/data-action="(exec|correct-progress)"/g, `$&${executionDisabled}`)}</div>` : ''}
        </div>
      </article>`;
    }

    export function emptyState(title, text, action, label) {
      return `<div class="card empty-state"><div><div class="empty-state-icon" aria-hidden="true">${uiIcon('compass', { size: 28 })}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p><div class="actions">${action ? `<button class="btn-primary" data-action="${action}">${escapeHtml(label)}</button>` : ''}</div></div></div>`;
    }

    export function candidateMetrics(candidate) {
      const snapshot = candidate.snapshot || {};
      const stops = (snapshot.stops || []).filter(stop => stop.status !== 'skipped');
      const legs = snapshot.routeLegs || [];
      let walking = 0;
      let walkingKnown = true;
      for (const leg of legs) {
        if (leg.walkingMeters === undefined || leg.walkingMeters === null) { walkingKnown = false; break; }
        walking += leg.walkingMeters;
      }
      const last = stops[stops.length - 1];
      const arrival = last ? (last.plannedArrivalMinutes ?? last.startMinutes ?? null) : null;
      const charges = snapshot.plannedCharges || [];
      let costLower = 0;
      let costUpper = 0;
      let costKnown = true;
      for (const charge of charges) {
        const estimate = charge.costEstimate || {};
        const quantity = charge.quantity || 1;
        const lower = Number(estimate.lowerMinor ?? 0) * quantity;
        const upper = estimate.upperMinor === null || estimate.upperMinor === undefined ? null : Number(estimate.upperMinor) * quantity;
        costLower += lower;
        if (upper === null) costKnown = false; else costUpper += upper;
      }
      return {
        arrival,
        departure: stops.length ? itineraryTiming(stops[0], snapshot).departure : null,
        leave: last ? (last.departureMinutes ?? last.endMinutes ?? null) : null,
        walking: walkingKnown ? walking : null,
        costLower,
        costUpper: costKnown ? costUpper : null,
      };
    }
