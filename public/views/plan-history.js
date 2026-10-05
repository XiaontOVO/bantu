import { state } from '../lib/store.js';
import { cityName, clockText, escapeHtml, formatTimeRange, monthDay, STATUS_LABEL } from '../lib/format.js';
import { uiIcon } from '../lib/icons.js';
import { latestHistoryEvent } from '../lib/plan-history.js';
import { guestRetentionNotice } from '../lib/account-retention.js';

const eventLabel = event => event.correctsEventId ? `纠正为${({ planned: '未完成', completed: '已完成', skipped: '已跳过' })[event.statusOverride] || STATUS_LABEL[event.statusOverride] || '真实进度'}`
  : ({ depart: '出发', arrive: '到达', complete: '完成', skip: '跳过', abort: '中止出发' })[event.type] || '记录进度';

function historyDetail(plan) {
  const events = plan.executionEvents || [], replaced = new Set(events.map(event => event.correctsEventId).filter(Boolean));
  const completed = (plan.stops || []).filter(stop => stop.status === 'completed').length;
  return `<div class="page-head"><div><button class="btn-ghost history-back" data-action="open-plan-history">${uiIcon('arrow-left', { size: 17 })} 往日记录</button><h2>${escapeHtml(plan.name)}</h2><p>${escapeHtml(monthDay(plan.localDate))} · ${escapeHtml(cityName(plan.cityCode))}</p></div><button class="action-icon action-icon-danger" data-action="ask-delete-plan-history" title="删除这份记录" aria-label="删除这份往日记录">${uiIcon('trash', { size: 20 })}</button></div>
    <section class="card history-summary"><div><span class="history-kicker">这一天的原始记录</span><strong>${completed}<small> / ${(plan.stops || []).length} 个地点已完成</small></strong></div><p>${plan.canEditHistory ? `可在 ${escapeHtml(monthDay(plan.historyEditUntilDate))} 结束前补记或纠正。` : '已超过补记期限，完整记录仍可查看。'} 原安排、进度事件和日期快照长期保留，直到你主动删除。</p></section>
    <div class="history-stops">${(plan.stops || []).map(stop => {
      const entries = events.filter(event => event.stopId === stop.stopId), latest = latestHistoryEvent(plan, stop.stopId);
      const status = stop.status || 'planned', start = [stop.plannedStartMinutes, stop.plannedArrivalMinutes, stop.startMinutes].find(Number.isFinite);
      const end = [stop.plannedDepartureMinutes, stop.departureMinutes, stop.endMinutes].find(Number.isFinite);
      return `<article class="card history-stop"><div class="row-between"><h3>${escapeHtml(stop.place?.name || '地点')}</h3><span class="chip ${status === 'completed' ? 'green' : ''}">${status === 'planned' ? '未完成' : escapeHtml(STATUS_LABEL[status] || '待核对')}</span></div><p class="stop-meta">记录时段：${start === undefined || end === undefined ? '时间未记录' : escapeHtml(formatTimeRange(start, end))}</p>
        ${status === 'completed' && !entries.some(event => event.type === 'arrive' && !replaced.has(event.executionEventId)) ? '<p class="stop-meta">未记录实际到达时间，实际停留时长未知。</p>' : ''}
        ${entries.length ? `<details class="history-events"><summary>完整进度记录 · ${entries.length} 条</summary><ol>${entries.map(event => `<li${replaced.has(event.executionEventId) ? ' class="is-corrected"' : ''}><strong>${escapeHtml(eventLabel(event))}${replaced.has(event.executionEventId) ? ' · 已被纠正' : ''}</strong><span>发生于 ${escapeHtml(clockText(event.occurredAt, plan.timezone))}</span><small>记录于 ${escapeHtml(clockText(event.recordedAt, plan.timezone))}${event.correctionReason ? ` · ${escapeHtml(event.correctionReason)}` : ''}</small></li>`).join('')}</ol></details>` : '<p class="history-no-events">没有实际进度记录。</p>'}
        ${plan.canEditHistory ? `<div class="stop-actions">${status === 'planned' ? `<button class="btn-soft" data-action="backfill-plan-history" data-stop="${escapeHtml(stop.stopId)}">${uiIcon('edit', { size: 16 })} 补记到访</button>` : ''}${latest ? `<button class="btn-soft" data-action="correct-plan-history" data-stop="${escapeHtml(stop.stopId)}">纠正记录</button>` : ''}</div>` : ''}</article>`;
    }).join('') || '<section class="card empty-state"><p>这一天没有地点记录。</p></section>'}
    <details class="card history-versions"><summary>日期计划快照 · ${(plan.versions || []).length} 份</summary>${(plan.versions || []).map(version => `<article><strong>${escapeHtml(version.name)}</strong><p class="stop-meta">保存于 ${escapeHtml(clockText(version.createdAt, plan.timezone))}</p><p>${version.stops.map(stop => escapeHtml(stop.place?.name || '地点')).join(' → ') || '没有地点'}</p></article>`).join('') || '<p class="stop-meta">没有旧版内容快照。</p>'}</details></div>`;
}

export function renderPlanHistory() {
  const error = state.planHistoryError ? `<section class="card load-error"><p>${escapeHtml(state.planHistoryError)}</p><button class="btn-soft" data-action="retry-plan-history">重新加载</button></section>` : '';
  if (state.planHistoryId) return guestRetentionNotice(state.principal) + error + (state.planHistoryDetail ? historyDetail(state.planHistoryDetail) : `<div class="page-head"><h2>往日记录</h2><button class="btn-ghost" data-action="open-plan-history">返回列表</button></div>${!error ? '<section class="card" role="status">正在加载这一天的记录…</section>' : ''}`);
  return `<div class="page-head"><div><h2>往日记录</h2><p>回看原安排，补记真实到访。</p></div><button class="action-icon" data-action="retry-plan-history" title="刷新往日记录" aria-label="刷新往日记录">${uiIcon('refresh', { size: 20 })}</button></div>
    <section class="card history-intro"><span>${uiIcon('calendar', { size: 24 })}</span><p>过期日计划完整保存在这里，30 天内可补记或纠正。没有结束的跨日地点仍留在首页随行；未完成安排另存为可复用方案。</p></section>${error}
    ${guestRetentionNotice(state.principal)}
    <div class="history-grid">${(state.planHistory || []).map(plan => `<article class="card history-day"><span class="history-kicker">${escapeHtml(monthDay(plan.localDate))} · ${escapeHtml(cityName(plan.cityCode))}</span><h3>${escapeHtml(plan.name)}</h3><p>${(plan.placeNames || []).map(escapeHtml).join(' · ') || '没有地点'}</p><div class="history-day-meta"><span>${plan.completedCount} / ${plan.stopCount} 个地点已完成</span><small>${plan.canEditHistory ? '可补记与纠正' : '只读记录'}</small></div><button class="btn-soft" data-action="view-plan-history" data-plan="${escapeHtml(plan.id)}">查看这一天 ${uiIcon('arrow-right', { size: 16 })}</button></article>`).join('') || (!error ? `<section class="card empty-state" role="status"><h3>${state.planHistoryLoading ? '正在加载往日记录' : '还没有往日记录'}</h3><p>日期结束后，原计划和进度会自动保存到这里。</p></section>` : '')}</div>
    ${state.planHistoryCursor ? `<button class="btn-soft history-more" data-action="more-plan-history" ${state.planHistoryLoading ? 'disabled' : ''}>${state.planHistoryLoading ? '正在加载…' : '查看更多日期'}</button>` : ''}`;
}
