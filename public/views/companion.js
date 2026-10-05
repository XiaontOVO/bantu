/** 随行只展示派生阶段；执行事实仍由用户确认。 */
import { state } from '../lib/store.js';
import { escapeHtml, fmtWithDay, monthDay } from '../lib/format.js';
import { companionTarget } from '../lib/day-plan-selection.js';
import { resolveStopPlace } from '../lib/components.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';
import { placeImpression } from '../lib/place-impressions.js';
import { tourSectionHtml } from '../lib/place-tour.js';
import { TRANSPORT_LABELS as modes } from '../lib/transport-modes.js';
import { transportPickerHtml } from '../lib/transport-picker.js';
import { stopTransportMode } from '../lib/stop-transport.js';
import {hasPlaceScene} from '../lib/place-scene-catalog.js';
import {sceneEntryPendingFor,sceneEntryErrorFor} from '../lib/place-scene.js';


export function companionMode(plan, stop) {
  return stopTransportMode(stop, plan);
}

export function renderCompanion({ showHeading = true } = {}) {
  let target = companionTarget(state.savedPlans || [], state.companionPlanId);
  const finished = state.companionFinishedPlan;
  // 跨日最后一站完成后原计划可能已清理。本次真实回执仍可用于展示结束页。
  if (finished && finished.id === state.companionPlanId && !target.plan?.stops?.some(stop => ['en_route', 'visiting'].includes(stop.status))) {
    target = { plan: finished, phase: 'finished', next: null, canExecute: false };
  }
  const { plan, next, phase, canExecute } = target;
  const head = `${showHeading ? `<div class="page-head companion-head"><div><h2>伴途随行</h2><p>下一步，陪你轻松走。</p></div><button class="btn-soft companion-plan-link" data-action="view-companion-plan">完整安排</button></div>` : ''}${state.companionNotice ? `<p class="companion-notice">${escapeHtml(state.companionNotice)}</p>` : ''}`;
  if (phase === 'conflict') return `${head}<section class="card companion-empty"><span class="companion-section-icon">${uiIcon('repair', { size: 26 })}</span><div class="companion-empty-copy"><h3>先核对一下安排</h3><p>${escapeHtml(target.reason)}</p></div><div class="stop-actions"><button class="btn-primary" data-action="navigate" data-view="today">查看计划与进度</button></div></section>`;
  if (!plan) return `${head}<section class="card companion-empty"><span class="companion-section-icon">${uiIcon('compass', { size: 26 })}</span><div class="companion-empty-copy"><h3>从一份小计划开始</h3><p>排好想去的地方，伴途会陪你一步步走。</p></div><div class="stop-actions"><button class="btn-primary" data-action="navigate" data-view="agent">和伴途一起安排</button><button class="btn-soft" data-action="navigate" data-view="today">自己规划</button></div></section>`;
  if (phase === 'finished') {
    const completed = (plan.stops || []).filter(stop => stop.status === 'completed').length;
    const pending=state.journeyReviewPending?.planId===plan.id;
    return `${head}<section class="card companion-finished">${uiIcon('sparkle', { size: 40 })}<p class="companion-kicker">${escapeHtml(monthDay(plan.localDate))} · ${escapeHtml(plan.name)}</p><h3>${completed ? '留住今天的足迹' : '这份安排已结束。'}</h3><p>${completed ? `已完成 ${completed} 个地点，实际到访已整理为私人旅行记录。` : '可以重新安排接下来的旅程。'}</p><div class="stop-actions">${completed?`<button class="btn-primary" data-action="open-journey-review" data-plan="${escapeHtml(plan.id)}" ${pending?'disabled aria-busy="true"':''}>${buttonContent('archive',pending?'正在打开记录…':'查看这次旅行记录')}</button>`:''}<button class="btn-soft" data-action="navigate" data-view="today">${buttonContent('calendar','安排下一天')}</button></div></section>`;
  }
  const place = resolveStopPlace(next) || { name: '未命名地点', placeId: next.placeId || '' };
  const impression = placeImpression(place);
  const sceneAvailable=phase==='visit'&&hasPlaceScene(place);
  const sceneWaiting=sceneAvailable&&sceneEntryPendingFor(place.placeId);
  const sceneFailure=sceneAvailable&&sceneEntryErrorFor(place.placeId);
  const mode = companionMode(plan, next);
  const ctx = state.companionContext?.planId === plan.id && state.companionContext?.stopId === next.stopId && state.companionContext?.revision === (plan.revision || 0) && state.companionContext?.mode === mode ? state.companionContext : null;
  const remaining = (plan.stops || []).filter(stop => (stop.status || 'planned') === 'planned' && stop.stopId !== next.stopId);
  const completed = (plan.stops || []).filter(stop => stop.status === 'completed').length;
  const journeyStops = (plan.stops || []).filter(stop => stop.status !== 'skipped');
  const total = journeyStops.length;
  const station = journeyStops.findIndex(stop => stop.stopId === next.stopId) + 1;
  const dayNumber = Number.isInteger(plan.sourceDayIndex) && plan.sourceDayIndex >= 0 ? plan.sourceDayIndex + 1 : null;
  // 只拆分与来源天数一致的自动名称后缀；自定义名称和旧数据保持原文。
  const journeyName = dayNumber ? String(plan.name || '').replace(new RegExp(`\\s*·\\s*第\\s*${dayNumber}\\s*天$`), '') : plan.name;
  const phaseLabel = { ready: canExecute ? '准备出发' : '行前预览', travel: '正在前往', visit: '就在这一站' }[phase];
  const phaseCopy = { ready: '选好交通方式，再按自己的节奏出发。', travel: '沿路慢慢走。真正到达后，记得告诉伴途。', visit: sceneAvailable?'点进场景，和伴途一起看看这一站。':'先看地点全貌，再点建筑查看已收录资料。' }[phase];
  const type = { ready: 'depart', travel: 'arrive', visit: 'complete' }[phase];
  const actionLabel = { ready: '出发', travel: '我已到达', visit: sceneAvailable?'结束游览':remaining.length ? '结束这一站，看看下一步' : '结束这一站' }[phase];
  const actionIcon = { ready: 'arrow-right', travel: 'pin', visit: 'check' }[phase];
  const opening = place.openingIntervals?.length ? place.openingIntervals.map(slot => `${fmtWithDay(slot.startMinutes)}–${fmtWithDay(slot.endMinutes)}`).join('、') : '待核实';
  const appointment = next.visitWindow ? `${fmtWithDay(next.visitWindow.startMinutes)}–${fmtWithDay(next.visitWindow.endMinutes)}` : null;
  const stageTime = stopStageTime(plan, next, phase);
  const weather = weatherSummary(ctx, plan);
  const changes = canExecute ? `<section class="card companion-changes"><div class="companion-section-heading"><span class="companion-section-icon">${uiIcon('agent', { size: 22 })}</span><div><h3>旅途，随心一点</h3><p class="stop-meta">交给伴途 Agent，一起调整接下来的安排。</p></div></div><div class="companion-change-buttons">${[['rest','想休息','让伴途留出休息时间','tea'],['rain','下雨了','让伴途寻找避雨安排','water'],['time','时间不够','让伴途核对时间取舍','timer'],['replace','换个地方','让伴途寻找下一站','compass']].map(([change, label, note, icon]) => `<button data-action="companion-change" data-change="${change}" ${state.chatPending || state.executionPending ? 'disabled' : ''}>${uiIcon(icon, { size: 20 })}<span><strong>${label}</strong><small>${note}</small></span></button>`).join('')}</div></section>` : '';
  return `${head}<header class="companion-journey" aria-label="旅程概览"><div class="companion-journey-name"><strong>${escapeHtml(journeyName)}</strong><div class="companion-journey-meta"><time datetime="${escapeHtml(plan.localDate)}">${escapeHtml(monthDay(plan.localDate))}</time>${dayNumber ? `<span class="companion-journey-day">第 ${dayNumber} 天</span>` : ''}</div><p class="companion-phase-copy">${phaseCopy}</p></div><div class="companion-progress"><span>已完成 <strong>${completed}</strong> / ${total} 站</span><progress value="${completed}" max="${Math.max(1, total)}" aria-label="已完成地点"></progress></div></header><div class="companion-layout">
    <section class="card companion-now" aria-label="当前旅程步骤">
      <div class="companion-impression" style="--place-wash:${escapeHtml(impression.wash)}"><img src="${escapeHtml(impression.src)}" alt="" /><span class="companion-phase">${uiIcon(phase === 'visit' ? 'building' : 'compass')} ${phaseLabel}</span></div>
      <div class="companion-now-body"><div class="companion-place-info" tabindex="0" aria-label="本次到访信息"><div class="companion-place-heading"><h3>${escapeHtml(place.name)}</h3><p class="companion-kicker">这一站 <span>${String(station).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span></p></div>
      ${target.isEarlier ? '<p class="companion-notice">这是跨日仍在进行的安排。先结束这一站，再继续新一天。</p>' : ''}
      ${!canExecute ? '<p class="companion-notice">这是未来计划，到了出行当天才能记录进度。</p>' : ''}
      ${next.forecastConflict ? '<p class="companion-notice">预计可能赶不上预约，请先核对固定时段。</p>' : ''}
      ${place.reservationHint ? `<p class="companion-notice">${uiIcon('ticket')} ${escapeHtml(place.reservationHint)}</p>` : ''}
      <div class="companion-place-context"><div>${place.address ? `<a class="companion-place-address" href="#/place/${escapeHtml(encodeURIComponent(place.placeId))}" data-action="open-place" data-place="${escapeHtml(place.placeId)}" title="${escapeHtml(place.address)}" aria-label="查看地点：${escapeHtml(place.name)}">${uiIcon('pin', { size: 15 })}<span>${escapeHtml(place.address)}</span></a>` : ''}${place.description ? `<p class="companion-place-summary">${escapeHtml(place.description)}</p>` : ''}</div></div>
      <div class="companion-facts"><span class="companion-stage-time">${uiIcon('calendar')}<span><small>${stageTime.label}</small><strong>${escapeHtml(stageTime.value)}</strong></span></span><span>${uiIcon('timer')}<span><small>计划游览</small><strong>${Math.max(0, Number(next.plannedDurationMinutes || next.minDurationMinutes || (next.endMinutes - next.startMinutes)) || 0)} 分钟</strong></span></span><span class="companion-opening">${uiIcon('clock')}<span><small>开放时间${place.openingIntervals?.length ? ' · 行前核实' : ''}</small><strong>${escapeHtml(opening)}</strong></span></span>${appointment ? `<span class="companion-appointment">${uiIcon('ticket')}<span><small>预约时段</small><strong>${escapeHtml(appointment)}</strong></span></span>` : ''}</div>
      </div><div class="companion-step-actions${sceneAvailable?' has-scene':''}">${phase !== 'visit' ? `<div class="companion-modes">${transportPickerHtml(mode, { action: 'companion-mode', data: { plan: plan.id, stop: next.stopId }, compact: true, disabled: state.executionPending || state.stopTransportPending })}</div>` : ''}
      ${sceneAvailable?`<button type="button" class="btn-primary companion-primary place-scene-entry" data-action="${sceneWaiting?'cancel-scene-entry':'open-place-scene'}" data-place="${escapeHtml(place.placeId)}" ${state.executionPending?'disabled':''}>${buttonContent(sceneWaiting?'close':'scene-enter',sceneWaiting?'取消等待':sceneFailure?'重试进入':'进入场景')}</button>`:''}
      <button class="${sceneAvailable?'btn-soft':'btn-primary'} companion-primary" data-action="companion-exec" data-plan="${escapeHtml(plan.id)}" data-stop="${escapeHtml(next.stopId)}" data-revision="${plan.revision || 0}" data-type="${type}" data-mode="${escapeHtml(mode)}" ${!canExecute || state.executionPending || state.stopTransportPending ? 'disabled' : ''}>${buttonContent(state.executionPending ? 'refresh' : actionIcon, state.executionPending ? '正在记录…' : actionLabel)}</button>
      ${sceneWaiting?`<p class="companion-scene-status" role="status">${uiIcon('refresh',{size:16,className:'scene-entry-spinner'})}<span>正在准备场景…</span></p>`:sceneFailure?`<p class="companion-scene-status" role="alert">${escapeHtml(sceneFailure.message)}</p>`:''}
      </div>${phase === 'travel' ? `<button class="btn-ghost companion-abort" data-action="companion-exec" data-plan="${escapeHtml(plan.id)}" data-stop="${escapeHtml(next.stopId)}" data-revision="${plan.revision || 0}" data-type="abort" ${state.executionPending ? 'disabled' : ''}>中止本次出发</button>` : ''}
      </div>
    </section>
    <div class="companion-support">
    ${phase === 'visit' ? `<div class="companion-guide">${tourSectionHtml(place)}${weather}</div>` : `<section class="card companion-route"><div class="companion-section-heading"><span class="companion-section-icon">${uiIcon('compass', { size: 22 })}</span><div><h3>沿路怎么走</h3><p class="stop-meta">${escapeHtml(modes[mode])} · 道路路线</p></div><button type="button" class="btn-soft companion-route-refresh" ${state.companionLoading ? 'data-action="cancel-companion-route"' : 'data-action="refresh-companion-route"'} title="${state.companionLoading ? '取消本次定位或路线查询' : '更新路线与预计时间'}" aria-label="${state.companionLoading ? '取消本次定位或路线查询' : '更新路线与预计时间'}">${buttonContent(state.companionLoading ? 'close' : 'refresh', state.companionLoading ? '取消更新' : '更新路线')}</button></div><div class="companion-route-info" aria-live="polite" aria-busy="${Boolean(state.companionLoading)}">${routeSummary(ctx)}</div><div id="companionRouteMap" class="companion-route-map" aria-label="当前站点的目的地与道路路线"></div><p id="companionMapStatus" class="companion-route-note" role="status"></p><p class="companion-route-note">到达后请手动确认，预计时间仅供参考。</p>${weather}</section>`}
    ${changes}
    </div>
    <section class="card companion-remaining"><div class="companion-section-heading"><span class="companion-section-icon">${uiIcon('pin', { size: 22 })}</span><div><h3>接下来，按你的节奏</h3><p class="stop-meta">${remaining.length ? `还有 ${remaining.length} 站等着你` : '给今天留一个美好的收尾'}</p></div></div>${remaining.length ? `<ol>${remaining.map(stop => `<li><span>${String(journeyStops.findIndex(item => item.stopId === stop.stopId) + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(resolveStopPlace(stop)?.name || '未命名地点')}</strong><small>计划 ${fmtWithDay(stop.startMinutes)}–${fmtWithDay(stop.endMinutes)}</small></div></li>`).join('')}</ol>` : '<p class="stop-meta">这是这份安排的最后一站，结束后就能回顾旅程。</p>'}<button class="btn-soft companion-plan-link" data-action="view-companion-plan">查看完整安排</button></section>
  </div>`;
}

function stopStageTime(plan, stop, phase) {
  if (phase === 'ready') return { label: '计划时间', value: fmtWithDay(stop.startMinutes) };
  const events = plan.executionEvents || [];
  const corrected = new Set(events.map(event => event.correctsEventId).filter(Boolean));
  const type = phase === 'travel' ? 'depart' : 'arrive';
  const status = phase === 'travel' ? 'en_route' : 'visiting';
  const event = events.filter(item => item.stopId === stop.stopId && !corrected.has(item.executionEventId) &&
    (item.type === type || item.statusOverride === status) && Number.isFinite(Date.parse(item.occurredAt)))
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || String(left.recordedAt || '').localeCompare(String(right.recordedAt || ''))).at(-1);
  let value = '时间未记录';
  if (event) {
    try {
      value = new Intl.DateTimeFormat('zh-CN', { timeZone: plan.timezone || 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(event.occurredAt));
    } catch { /* 不合法的旧时区保持未知，不用计划时间补成实际时间。 */ }
  }
  return { label: phase === 'travel' ? '出发时间' : '到达时间', value };
}

function weatherSummary(ctx, plan) {
  if (!ctx) return '';
  const forecast = ctx.weather?.available && ctx.weather.forecast;
  return `<aside class="companion-weather"><span>${uiIcon('water', { size: 19 })}</span><div><h4>行前天气</h4>${forecast ? `<p>${escapeHtml(forecast.temperatureMinC)}–${escapeHtml(forecast.temperatureMaxC)}°C · ${forecast.precipitationProbabilityMax == null ? '降雨概率未知' : `最高降雨概率 ${escapeHtml(forecast.precipitationProbabilityMax)}%`}</p><p class="stop-meta">${escapeHtml(ctx.weather.source || '天气预报')} · ${escapeHtml(ctx.weather.date || plan.localDate)} · 预报供行前参考</p>` : '<p>暂不可用，出行前请核对现场天气。</p>'}</div></aside>`;
}

function routeSummary(ctx) {
  if (state.companionLoading) return `<p class="companion-route-status" role="status">${uiIcon('refresh', { size:18, className:'scene-entry-spinner' })}<span>${state.companionQueryStage === 'locating' ? '正在取得设备定位…' : '正在核对道路路线…'}</span></p>`;
  if (state.companionError) return `<p class="companion-notice">${escapeHtml(state.companionError)}</p>`;
  if (!ctx?.route?.leg || ctx.routeUnknown || ctx.validUntil && Date.now() >= Date.parse(ctx.validUntil)) return `<p>预计到达时间待估</p><p class="stop-meta">${escapeHtml(ctx?.routeReason || '点击更新，按新鲜设备定位查询实际道路。')}</p>`;
  const route = ctx.route;
  const minutes = Number.isFinite(route.leg.durationMinutes) ? route.leg.durationMinutes : route.leg.durationSeconds / 60;
  const eta = ctx.previewOnly ? '按当前道路测算，未来到达时间待估' : `预计 ${new Intl.DateTimeFormat('zh-CN', { timeZone: ctx.timezone || 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ctx.eta))} 到达`;
  return `<p class="companion-eta"><strong>约 ${Math.ceil(minutes)} 分钟</strong><span>${escapeHtml(eta)}</span></p><p class="stop-meta">${escapeHtml(ctx.originLabel)} → ${escapeHtml(ctx.destinationLabel)} · ${route.leg.distanceMeters == null ? '距离未知' : `${(route.leg.distanceMeters / 1000).toFixed(1)} 公里`}</p><p class="stop-meta">${escapeHtml(ctx.routeSource)} · ${route.departureSupport === 'current_only' ? '按当前出发测算，不含实时路况' : '道路估计，可能随途中情况变化'} · ${escapeHtml(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: ctx.timezone || 'Asia/Shanghai' }).format(new Date(ctx.retrievedAt)))} 更新</p>`;
}
