/** 计划与进度：显示今天与未来日期；过期日期由服务端自动清理。 */
import { resolveStopPlace, timelineItem } from '../lib/components.js';
import { dateKeyInTimeZone, escapeHtml, monthDay, clockText } from '../lib/format.js';
import { state } from '../lib/store.js';
import { renderPlanDraft } from './plan.js';
import { hasLoadError } from '../lib/load-state.js';
import { uiIcon } from '../lib/icons.js';
import { buttonContent } from '../lib/button-content.js';
import { hasOvernightActiveStop } from '../lib/plan-execution-window.js';

function planDateChip(date, { selected, today, action }) {
  const hasSavedPlan = (state.savedPlans || []).some(plan => plan.kind !== 'scheme' && plan.localDate === date);
  const canDelete = hasSavedPlan;
  const [year, month, day] = date.split('-');
  const fullDateLabel = `${year}年${Number(month)}月${Number(day)}日`;
  return `<span class="plan-date-chip${canDelete ? ' has-delete' : ''}${date === selected ? ' selected' : ''}"><button class="plan-date-select${date === selected ? ' active' : ''}" data-action="${action}" data-date="${escapeHtml(date)}" aria-pressed="${date === selected ? 'true' : 'false'}">${escapeHtml(fullDateLabel)}</button>${canDelete ? `<button class="plan-date-delete" data-action="delete-date-plan" data-date="${escapeHtml(date)}" aria-label="删除 ${escapeHtml(fullDateLabel)} 的计划" title="删除这天的计划">×</button>` : ''}${date === today ? '<span class="plan-date-today">今天</span>' : ''}</span>`;
}

function renderPlanDateNavigation(dates, { selected, today, action }) {
  if (!dates.length) return '';
  const selectedIndex = Math.max(0, dates.indexOf(selected));
  const firstIndex = Math.max(0, Math.min(selectedIndex - 1, dates.length - 3));
  const visibleDates = dates.slice(firstIndex, firstIndex + 3);
  const hiddenDates = dates.filter(date => !visibleDates.includes(date));
  const moreButton = hiddenDates.length
    ? `<button class="plan-date-more" data-action="open-plan-date-picker" data-dates="${escapeHtml(hiddenDates.join(','))}" aria-label="选择其他日期" title="选择其他日期">…</button>`
    : '';
  return `<div class="chip-row plan-date-navigation">${visibleDates.map(date => planDateChip(date, { selected, today, action })).join('')}${moreButton}</div>`;
}

function addPlaceButton(date) {
  return `<button class="action-icon action-icon-create" data-action="add-place-on-date" data-date="${escapeHtml(date)}" title="添加地点" aria-label="添加地点">${uiIcon('pin-add', { size: 22 })}</button>`;
}

/** 文档 §5：显示按三态分组；只排序展示副本，不改写排期队列或执行事实。 */
function renderStateTimelines(stops, plan, mode) {
  const displayMinute = stop => {
    const values = [
      ...(stop.status === 'en_route' ? [stop.travelStartMinutes] : []),
      stop.actualArrivalMinutes, stop.forecastStartMinutes, stop.startMinutes, stop.plannedStartMinutes, stop.plannedArrivalMinutes,
    ];
    return values.find(Number.isFinite) ?? Number.MAX_SAFE_INTEGER;
  };
  const ordered = stops.map((stop, index) => ({ stop, index }))
    .sort((left, right) => displayMinute(left.stop) - displayMinute(right.stop) || left.index - right.index)
    .map(item => item.stop);
  const groups = [
    { key: 'completed', title: '已完成', stops: ordered.filter(stop => stop.status === 'completed') },
    { key: 'active', title: '进行中', stops: ordered.filter(stop => ['en_route', 'visiting'].includes(stop.status)) },
    { key: 'planned', title: '计划', stops: ordered.filter(stop => (stop.status || 'planned') === 'planned') },
  ];
  const snapshot = { stops: plan.stops || [], routeLegs: plan.routeLegs || [], executionEvents: plan.executionEvents || [], localDate: plan.localDate, timezone: plan.timezone };
  let index = 0;
  return groups.filter(group => group.stops.length).map(group => `<section class="day-state-section" data-plan-state="${group.key}" aria-label="${group.title}地点">
    <div class="day-state-heading"><h4>${group.title}</h4><span>${group.stops.length} 个地点</span></div>
    <div class="timeline dated-plan-timeline">${group.stops.map(stop => timelineItem(stop, index++, group.key === 'completed' ? 'progress' : null, mode, plan.id, snapshot.executionEvents, snapshot)).join('')}</div>
  </section>`).join('');
}

/** 日计划自身就是计划与进度的承载对象，不需要创建 Trip。 */
function renderDatedPlansOverview() {
  if (hasLoadError('plans')) {
    return `<div class="page-head"><div><h2>计划与进度</h2><p>当天安排和执行进度会显示在这里。</p></div></div><section class="card empty-state" role="status"><div><h3>计划暂时无法加载</h3><p>计划服务没有返回数据，先重新加载再继续操作。</p><button class="btn-primary" data-action="retry-current-view">重新加载</button></div></section>`;
  }
  const now = new Date();
  const today = dateKeyInTimeZone(now);
  const plans = (state.savedPlans || []).filter(plan => plan.kind !== 'scheme' && plan.localDate &&
    (plan.localDate >= today || hasOvernightActiveStop(plan, now)));
  const overnightDate = plans.find(plan => hasOvernightActiveStop(plan, now))?.localDate;
  const draftDate = state.planDraft?.dailyPlanDate;
  const dates = [...new Set([...plans.map(plan => plan.localDate),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(draftDate || '') && draftDate >= today ? [draftDate] : [])])].sort();
  if (!dates.includes(today)) dates.unshift(today);
  const selected = state.planViewDate && dates.includes(state.planViewDate) ? state.planViewDate
    : (overnightDate || (dates.includes(today) ? today : (dates.find(date => date > today) || dates[dates.length - 1] || '')));
  const dayPlans = plans.filter(plan => plan.localDate === selected);
  const dayCard = (plan) => {
    const stops = plan.stops || [];
    const events = plan.executionEvents || [];
    const visibleStops = stops.filter(stop => stop.status !== 'skipped');
    // 已跳过地点属于历史记录，不再占用当天计划的编号和主列表空间。
    const completed = visibleStops.filter(stop => stop.status === 'completed').length;
    const active = visibleStops.filter(stop => ['en_route', 'visiting'].includes(stop.status));
    const planned = visibleStops.filter(stop => (stop.status || 'planned') === 'planned');
    const labels = { depart: '出发', arrive: '到达', complete: '完成', skip: '跳过', abort: '中止本次出发' };
    // 同一天出现多份日计划时先锁住执行操作，避免用户在其中一份上记录进度，
    // 另一份仍然可以继续出发，造成两个“进行中”节点。
    const mode = dayPlans.length === 1 && (plan.localDate === today || hasOvernightActiveStop(plan, now)) ? 'dated' : 'plan';
    const percent = visibleStops.length ? Math.round(completed / visibleStops.length * 100) : 0;
    return `<article class="card dated-plan-card"><div class="row-between dated-plan-head"><h3>${escapeHtml(plan.name)}</h3>${dayPlans.length === 1 ? addPlaceButton(plan.localDate) : ''}</div>
      ${stops.some(stop => stop.forecastConflict) ? '<p class="stop-meta stop-overdue-note">预计可能赶不上固定时段，请核对预约并调整后续安排。</p>' : plan.needsReview ? '<p class="stop-meta stop-overdue-note">实际记录与安排需要核对，请查看相关进度与预约。</p>' : ''}
      ${completed ? `<div class="dated-plan-progress"><div class="row-between"><strong>进度 ${completed}/${visibleStops.length}</strong><span class="stop-meta">${percent}%</span></div><div class="progress-wrap"><div class="progress-bar" style="width:${percent}%"></div></div></div>` : ''}
      ${visibleStops.length ? renderStateTimelines(visibleStops, plan, mode) : '<p class="stop-meta">这一天还没有地点安排。</p>'}
      ${events.length ? `<section class="progress-history-section">${renderProgressRecords(stops, events, labels, plan.id, plan.timezone || 'Asia/Shanghai')}</section>` : ''}
      ${planned.length ? '' : active.length ? '<p class="stop-meta">地点正在进行中，结束这一站后可以继续下一站。</p>' : completed ? '<p class="stop-meta">当天安排已结束。</p>' : ''}
      <div class="stop-actions dated-plan-actions">${dayPlans.length === 1 ? `<button class="btn-small btn-primary" data-action="open-companion" data-plan="${escapeHtml(plan.id)}">${buttonContent('home', '回首页随行')}</button>` : ''}<button class="btn-small btn-soft" data-action="versions" data-plan="${escapeHtml(plan.id)}" data-date="${escapeHtml(plan.localDate)}">${buttonContent('archive', '计划快照')}</button><button class="btn-small btn-soft" data-action="edit-day-plan" data-plan="${escapeHtml(plan.id)}">${buttonContent('edit', '编辑')}</button></div></article>`;
  };
  const emptyDay = `<section class="card"><h3>这一天还没有计划</h3><div class="stop-actions"><button class="btn-primary" data-action="edit-selected-day-plan" data-date="${escapeHtml(selected)}">创建计划</button><button class="btn-ghost" data-action="add-place-on-date" data-date="${escapeHtml(selected)}">浏览地点</button></div></section>`;
  const editingSelected = state.planDraft?.dailyPlanDate === selected || (state.planDraft?.editId && dayPlans.some(plan => plan.id === state.planDraft.editId));
  const selectedContent = editingSelected ? renderPlanDraft({ dailyOnly: true }) : dayPlans.map(dayCard).join('') || emptyDay;
  return `
    <div class="page-head"><h2>计划与进度</h2><button class="action-icon" data-action="open-plan-history" title="查看往日记录" aria-label="查看往日记录">${uiIcon('clock', { size: 21 })}</button></div>
    ${dates.length ? `${renderPlanDateNavigation(dates, { selected, today, action: 'plan-view-date' })}
    ${dayPlans.length > 1 ? `<section class="card plan-date-conflict"><h3>${escapeHtml(monthDay(selected))} 有 ${dayPlans.length} 份日计划</h3><p class="stop-meta">请先处理重复计划，再记录当天进度。</p></section>` : ''}
    ${selectedContent}` : selectedContent}`;
}

export function renderToday() {
  return renderDatedPlansOverview();
}

function renderProgressRecords(stops, events, labels, planId = '', timezone) {
  if (!events.length) return '';
  const ids = [...new Set(events.slice().reverse().map(event => event.stopId))];
  return `<details id="progress-records"><summary>进度记录 · ${events.length} 条</summary>${ids.map(id => {
    const stop = stops.find(item => item.stopId === id);
    const history = events.filter(event => event.stopId === id).reverse();
    const place = resolveStopPlace(stop);
    return `<article class="progress-record-card"><div class="row-between"><strong>${escapeHtml(place?.name || id)}</strong>${stop ? `<button class="btn-small btn-soft" data-action="correct-progress" data-stop="${escapeHtml(id)}"${planId ? ` data-plan="${escapeHtml(planId)}"` : ''} ${state.executionPending ? 'disabled' : ''}>纠正进度</button>` : ''}</div>${history.map(event => `<p class="stop-meta">${event.statusOverride ? `纠正为${escapeHtml(({planned:'未完成',en_route:'正在前往',visiting:'正在游览',completed:'已完成',skipped:'已跳过'})[event.statusOverride] || event.statusOverride)}` : escapeHtml(labels[event.type] || event.type)}${events.some(item => item.correctsEventId === event.executionEventId) ? '（已被纠正）' : ''}${event.correctionReason ? ` · ${escapeHtml(event.correctionReason)}` : ''} · ${escapeHtml(clockText(event.occurredAt, timezone))}</p>`).join('')}</article>`;
  }).join('')}</details>`;
}
