/** 我的方案库：方案（多天，每天一份计划）的保存、载入、删除（服务端持久化）。 */
import { api } from './api.js';
import { loadTrip, loadPlaceCatalog } from './loaders.js';
import { $, state, tripId, tripRevision, usesSavedDayPlans } from './store.js';
import { clockText, dateKeyInTimeZone, escapeHtml, fmt, fmtWithDay, monthDay } from './format.js';
import { closeSheet, openSheet, toast } from './ui.js';
import { openDurationPickerPanel } from './ui-picker.js';
import { navigate, render } from './render.js';
import { previewPlanEdit } from './commands.js';
import { currentTripClock } from './trip-clock.js';
import { canViewPlanDate, companionTarget } from './day-plan-selection.js';
import { incomingPlanRoute, matchesPlanRoute, planRouteSummary, requestPlanRoute, routeTravelMinutes, transportModeToStop, TRANSPORT_LABELS } from './plan-route-timing.js';
import { focusPlanVisit } from './plan-repeat-visit.js';
import { protectPlanDraft, rememberPlanDraft } from './plan-draft-guard.js';
import { dayPlanDraftForDate } from './plan-draft-target.js';
import { retainPlanDraft, clearPlanDraft, planDraftContentKey } from './plan-draft-storage.js';
import { fitPlanStopTime } from './plan-time-constraints.js';
import { normalizeSchemeDays, normalizeSchemeDraft, schemeDayContinuations } from './scheme-days.js';
import { dailyFirstStopMinutes } from './plan-start-default.js';
import { writingDraft } from './writing-drafts.js';
import { fitDatedPlanStopTime } from './plan-time-carry.js';

function activePlanDate() {
  return currentTripClock()?.date || state.trip?.clock?.date || dateKeyInTimeZone(
    new Date(), state.trip?.snapshot?.timezone || state.trip?.trip?.timezone || 'Asia/Shanghai',
  );
}

function activeTimezone() {
  return state.trip?.snapshot?.timezone || state.trip?.trip?.timezone || 'Asia/Shanghai';
}

function cityCodeFromStops(stops = []) {
  const codes = [...new Set(stops
    .map(stop => stop?.place?.cityCode)
    .filter(code => /^\d{6}$/.test(String(code || '')) && code !== '000000'))];
  return codes.length ? codes[0] : '';
}

function cityCodeFromDays(days = []) {
  return cityCodeFromStops(days.flatMap(day => day?.stops || []));
}

const stopStartMinutes = (stop) => [stop?.startMinutes, stop?.plannedStartMinutes, stop?.plannedArrivalMinutes, stop?.plannedDepartureMinutes, stop?.departureMinutes]
  .find(Number.isFinite);
const stopDurationMinutes = (stop) => [
  stop?.plannedDurationMinutes,
  stop?.minDurationMinutes,
  Number.isFinite(stop?.durationSeconds) ? stop.durationSeconds / 60 : undefined,
  Number.isFinite(stop?.minDurationSeconds) ? stop.minDurationSeconds / 60 : undefined,
].find(Number.isFinite);

function validDraftName(draft) {
  const original = (state.savedPlans || []).find(plan => plan.id === draft.editId);
  const names = (draft.days || []).flatMap(day => day.stops || []).filter(stop => stop.status !== 'skipped').slice(0, 2).map(stop => stop.place?.name).filter(Boolean);
  const base = (String(draft.name || '').trim() || original?.name || (names.length ? `${names.join(' · ')}之旅` : '我的旅行方案')).slice(0, 40);
  const used = new Set((state.savedPlans || []).filter(plan => plan.id !== draft.editId).map(plan => plan.name));
  let name = base;
  for (let suffix = 2; used.has(name); suffix++) { const tail = ` ${suffix}`; name = base.slice(0, 40 - tail.length) + tail; }
  return name;
}

function sortStopsByStart(day) {
  if (!Array.isArray(day?.stops)) return day;
  day.stops = day.stops
    .map((stop, index) => ({ stop, index, start: stopStartMinutes(stop) ?? Number.POSITIVE_INFINITY }))
    .sort((left, right) => left.start - right.start || left.index - right.index)
    .map(({ stop }) => stop);
  return day;
}

/** A saved skipped status describes a reusable-plan choice, not an execution fact. */
function executionPlanContent(plan) {
  const stops = (plan?.stops || [])
    .filter(stop => stop?.status !== 'skipped')
    .map(stop => ({ ...stop, status: 'planned' }));
  const stopIds = new Set(stops.map(stop => stop.stopId));
  const routeLegs = (plan?.routeLegs || []).filter(leg =>
    stopIds.has(leg.toStopId) &&
    (leg.fromStopId === 'origin' || leg.fromStopId === 'my-location' || stopIds.has(leg.fromStopId)));
  const routeIds = new Set(routeLegs.map(leg => leg.legId));
  const plannedCharges = (plan?.plannedCharges || []).filter(charge =>
    (!charge.stopId || stopIds.has(charge.stopId)) &&
    (!charge.routeLegRef || routeIds.has(charge.routeLegRef)));
  return { stops, routeLegs, plannedCharges };
}

async function fetchAllSavedPlans() {
  const plans = [];
  let cursor = '';
  let pageCount = 0;
  do {
    // Preserve the unqualified first request for older servers and test doubles.
    // The API applies its normal page size on the first request; subsequent pages
    // explicitly ask for a larger page and carry the cursor returned by the API.
    const suffix = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await api(`/api/v1/plans${suffix}`, {}, true);
    plans.push(...(page.data || []));
    cursor = page.meta?.nextCursor || '';
    pageCount += 1;
  } while (cursor && pageCount < 100);
  return plans;
}

function normalizePlanViewDate(plans) {
  const selected = state.planViewDate;
  if (!selected) return;
  // 新建某一天时，保存前会先刷新一次方案列表；草稿日期虽然还不在
  // 列表里，但仍是用户当前正在编辑的日期，不能在这一步被清掉。
  if (state.planDraft?.dailyPlanDate === selected) return;
  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  // 日计划过期后会由服务端转存为静态方案并从列表移除。清掉已经不再
  // 存在的查看日期，避免地图和计划页继续拿旧日期显示“空白的一天”。
  if (selected !== today && !(plans || []).some(plan =>
    plan.kind === 'plan' && plan.localDate === selected && canViewPlanDate(selected, plans))) {
    state.planViewDate = '';
  }
}

export async function loadPlans() {
  const owner = state.principal?.principalId;
  const plans = await fetchAllSavedPlans();
  if (owner !== state.principal?.principalId) throw new Error('账号已切换，请重新加载计划。');
  state.savedPlans = plans;
  normalizePlanViewDate(plans);
  return plans;
}

/** One-time copy of legacy Trip data; dated plans own all ongoing progress from then on. */
export async function migrateLegacyTripToPlans(tripId) {
  if (!tripId) return null;
  const result = await api(`/api/v1/plans/migrate-trip/${encodeURIComponent(tripId)}`, { method: 'POST' });
  await loadPlans().catch(() => {});
  return result;
}

export async function ensureStandalonePlansFromTrip(view) {
  const tripId = view?.trip?.tripId;
  if (!tripId) return null;
  return migrateLegacyTripToPlans(tripId);
}

export async function showSavedPlanVersionHistory(planId) {
  const plan = (state.savedPlans || []).find(item => item.id === planId && item.kind !== 'scheme');
  if (!plan) throw new Error('找不到这一天的计划，请刷新后重试。');
  const versions = await api(`/api/v1/plans/${encodeURIComponent(planId)}/versions`);
  const current = (state.savedPlans || []).find(item => item.id === planId);
  if (!current) return;
  openSheet(`<div class="sheet-head"><h3 style="margin:0">${escapeHtml(monthDay(plan.localDate || '') || '计划')} · 快照</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">×</button></div>
    <p class="stop-meta">每次修改会保留修改前的计划，最多 5 个版本。恢复后，当前版本也会留在记录里。</p>
    ${versions.map(version => {
      const places = (version.stops || []).filter(stop => stop.status !== 'skipped').map(stop => stop.place?.name || stop.stopId).filter(Boolean).join(' → ') || '空计划';
      return `<div class="profile-row"><div><strong>${escapeHtml(version.name || plan.name)}</strong><span>${escapeHtml(clockText(version.createdAt))}</span><span class="stop-meta">${escapeHtml(places)}</span></div><button class="btn-small" data-action="restore-saved-plan-version" data-plan="${escapeHtml(planId)}" data-revision="${escapeHtml(String(version.revision))}">恢复此版</button></div>`;
    }).join('') || '<p class="stop-meta">这一天还没有历史快照。保存修改时，会把修改前的版本留在这里。</p>'}`);
}

export async function restoreSavedPlanVersion(planId, revision) {
  const plan = (state.savedPlans || []).find(item => item.id === planId && item.kind !== 'scheme');
  if (!plan) throw new Error('找不到这一天的计划，请刷新后重试。');
  const versions = await api(`/api/v1/plans/${encodeURIComponent(planId)}/versions`);
  const version = versions.find(item => String(item.revision) === String(revision));
  if (!version) throw new Error('这个快照已不存在，请重新打开历史记录。');
  await api(`/api/v1/plans/${encodeURIComponent(planId)}/restore`, { method: 'POST', body: JSON.stringify({
    expectedRevision: plan.revision || 0,
    versionRevision: version.revision,
  }) });
  closeSheet();
  // Restoring the snapshot is the mutation. Keep the success result visible
  // even when the follow-up list refresh is temporarily unavailable.
  await loadPlans().catch(() => {});
  render();
  toast('已恢复这一天的计划快照');
}

export async function savePlan(name, snapshot, source = 'current', extras = {}) {
  // 我的方案库统一存为多天方案（候选通常只有一天）；站点日期由服务端剥离，载入时按起始日期重新分配。
  const days = Array.isArray(snapshot?.days) && snapshot.days.length
    ? snapshot.days.map((day, index) => ({
      dayIndex: index,
      stops: day?.stops || [],
      routeLegs: day?.routeLegs || [],
      plannedCharges: day?.plannedCharges || [],
    }))
    : [{ dayIndex: 0, stops: snapshot?.stops || [], routeLegs: snapshot?.routeLegs || [], plannedCharges: snapshot?.plannedCharges || [] }];
  const hasExplicitDate = Object.prototype.hasOwnProperty.call(extras, 'localDate');
  const localDate = hasExplicitDate ? extras.localDate : (state.mountedDate || state.trip?.trip?.localDate || '');
  return api('/api/v1/plans', { method: 'POST', body: JSON.stringify({
    name, source, kind: 'scheme',
    days,
    cityCode: cityCodeFromDays(days) || extras.cityCode || state.trip?.trip.cityCode || '000000',
    timezone: extras.timezone || activeTimezone(),
    ...(localDate ? { localDate } : {}),
  }) });
}

function clonePlanDay(day) {
  return {
    stops: structuredClone(day?.stops || []),
    routeLegs: structuredClone(day?.routeLegs || []),
    plannedCharges: structuredClone(day?.plannedCharges || []),
  };
}

function sourceDayIndex(plan, scheme) {
  if (Number.isInteger(plan?.sourceDayIndex) && plan.sourceDayIndex >= 0) return plan.sourceDayIndex;
  if (!plan?.localDate || !scheme?.localDate) return -1;
  const date = Date.parse(`${plan.localDate}T00:00:00Z`);
  const start = Date.parse(`${scheme.localDate}T00:00:00Z`);
  const offset = (date - start) / 86_400_000;
  return Number.isInteger(offset) && offset >= 0 ? offset : -1;
}

function currentDaySnapshot(snapshot, date) {
  const stops = (snapshot?.stops || []).filter(stop => (stop.date || date) === date);
  const stopIds = new Set(stops.map(stop => stop.stopId));
  const routeLegs = (snapshot?.routeLegs || []).filter(leg =>
    stopIds.has(leg.toStopId) &&
    (leg.fromStopId === 'origin' || leg.fromStopId === 'my-location' || stopIds.has(leg.fromStopId)));
  const routeIds = new Set(routeLegs.map(leg => leg.legId));
  const plannedCharges = (snapshot?.plannedCharges || []).filter(charge =>
    (!charge.stopId || stopIds.has(charge.stopId)) &&
    (!charge.routeLegRef || routeIds.has(charge.routeLegRef)));
  return { stops: structuredClone(stops), routeLegs: structuredClone(routeLegs), plannedCharges: structuredClone(plannedCharges) };
}

/** 把当前行程的多日内容存成一套方案；保留来源方案天数，或汇总当前日期后的独立日计划。 */
export function openSaveCurrentPlan() {
  const date = state.mountedDate || state.trip?.trip?.localDate || activePlanDate();
  const snapshot = state.trip?.snapshot || {};
  const plans = state.savedPlans || [];
  const dailyPlans = plans.filter(plan => plan.kind !== 'scheme');
  const activeDailyPlan = dailyPlans.find(plan => plan.localDate === date);
  const sourceSchemeId = activeDailyPlan?.sourceSchemeId || '';
  const sourceScheme = activeDailyPlan?.sourceSchemeId
    ? plans.find(plan => plan.kind === 'scheme' && plan.id === activeDailyPlan.sourceSchemeId)
    : null;
  const activeSnapshot = usesSavedDayPlans()
    ? currentDaySnapshot(activeDailyPlan || {}, date)
    : currentDaySnapshot(snapshot, date);
  let days;
  let localDate = sourceScheme?.localDate || date;

  if (sourceScheme) {
    const sourceDays = [...(sourceScheme.days || [])].sort((a, b) => a.dayIndex - b.dayIndex);
    const linkedDays = new Map();
    for (const plan of dailyPlans.filter(item => item.sourceSchemeId === sourceScheme.id)) {
      const index = sourceDayIndex(plan, sourceScheme);
      if (index >= 0) linkedDays.set(index, clonePlanDay(plan));
    }
    days = sourceDays.map((day, index) => ({
      ...clonePlanDay(linkedDays.get(day.dayIndex) || day),
      dayIndex: index,
    }));
    for (const [index, day] of linkedDays) {
      if (index >= days.length) days.push({ ...day, dayIndex: days.length });
    }
    const activeIndex = sourceDayIndex(activeDailyPlan, sourceScheme);
    if (activeIndex >= 0 && activeIndex < days.length) {
      days[activeIndex] = { ...activeSnapshot, dayIndex: activeIndex };
    }
  } else if (sourceSchemeId) {
    // 原方案已删除时，仍可通过展开日计划保留多日分组。
    const linkedPlans = dailyPlans.filter(item => item.sourceSchemeId === sourceSchemeId)
      .sort((a, b) => (a.sourceDayIndex ?? Number.MAX_SAFE_INTEGER) - (b.sourceDayIndex ?? Number.MAX_SAFE_INTEGER) ||
        String(a.localDate || '').localeCompare(String(b.localDate || '')));
    const indexedDays = new Map();
    linkedPlans.forEach((plan, position) => {
      const index = Number.isInteger(plan.sourceDayIndex) && plan.sourceDayIndex >= 0 ? plan.sourceDayIndex : position;
      indexedDays.set(index, clonePlanDay(plan));
    });
    const maxIndex = Math.max(0, ...indexedDays.keys());
    days = Array.from({ length: maxIndex + 1 }, (_, index) => ({
      ...(indexedDays.get(index) || { stops: [], routeLegs: [], plannedCharges: [] }),
      dayIndex: index,
    }));
    const firstDayPlan = linkedPlans.find(plan => plan.sourceDayIndex === 0) || linkedPlans[0];
    localDate = firstDayPlan?.localDate || date;
    let activeIndex = sourceDayIndex(activeDailyPlan, null);
    if (activeIndex < 0 && firstDayPlan?.localDate) {
      const offset = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${firstDayPlan.localDate}T00:00:00Z`)) / 86_400_000;
      if (Number.isInteger(offset) && offset >= 0) activeIndex = offset;
    }
    if (activeIndex >= 0 && activeIndex < days.length) {
      days[activeIndex] = { ...activeSnapshot, dayIndex: activeIndex };
    }
  } else {
    const startMs = Date.parse(`${date}T00:00:00Z`);
    const dateOffset = dayDate => {
      const timestamp = Date.parse(`${dayDate}T00:00:00Z`);
      const offset = (timestamp - startMs) / 86_400_000;
      return Number.isInteger(offset) && offset >= 0 ? offset : -1;
    };
    const grouped = new Map();
    for (const plan of dailyPlans) {
      const offset = dateOffset(plan.localDate || '');
      const planCityCode = cityCodeFromStops(plan.stops || []) || plan.cityCode;
      const sameCity = !state.trip?.trip?.cityCode || !planCityCode || planCityCode === state.trip.trip.cityCode;
      if (offset >= 0 && sameCity && !plan.sourceSchemeId) grouped.set(offset, clonePlanDay(plan));
    }
    for (const stop of snapshot.stops || []) {
      const stopDate = stop.date || date;
      const offset = dateOffset(stopDate);
      if (offset < 0) continue;
      const group = grouped.get(offset) || { stops: [], routeLegs: [], plannedCharges: [] };
      const stopIndex = group.stops.findIndex(item => item.stopId === stop.stopId);
      if (stopIndex >= 0) group.stops[stopIndex] = structuredClone(stop);
      else group.stops.push(structuredClone(stop));
      grouped.set(offset, group);
    }
    // 当前挂载日以行程快照为准（包含尚未同步到日计划的改动）。
    if (activeDailyPlan || activeSnapshot.stops.length || grouped.size) grouped.set(0, activeSnapshot);
    const maxOffset = Math.max(0, ...grouped.keys());
    days = Array.from({ length: maxOffset + 1 }, (_, index) => ({
      ...clonePlanDay(grouped.get(index)),
      dayIndex: index,
    }));
    localDate = date;
  }

  if (!days?.length) days = [{ dayIndex: 0, ...activeSnapshot }];
  const defaultName = date ? `当前计划 · ${date.slice(5).replace('-', '/')}` : '当前计划';
  openSavePlanSheet(defaultName, { days }, 'current', {
    localDate,
    cityCode: cityCodeFromDays(days) || state.trip?.trip?.cityCode || sourceScheme?.cityCode || '000000',
    timezone: state.trip?.snapshot?.timezone || sourceScheme?.timezone || activeTimezone(),
  });
}

export async function deleteSavedPlan(id) {
  return api(`/api/v1/plans/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * 方案规划器：新建与编辑共用同一入口。
 * base: { baseStops? }（新建，用当前计划做第 1 天底稿）或 { editId }（编辑既有方案，名称/日期/天数全部带入）。
 */
export function openPlanPlanner(base = {}, afterOpen = render) {
  const targetExists = () => !base.editId || (state.savedPlans || []).some(plan => plan.id === base.editId);
  if (!targetExists()) return false;
  if (state.planDraft && typeof document !== 'undefined') syncDraftInputs();
  const protection = protectPlanDraft(base, () => { if (openPlanPlanner(base)) afterOpen(); }, targetExists);
  if (protection) {
    if (protection === 'resume') queueDraftRoutes(activeDayDraft());
    return protection === 'resume';
  }
  if (base.dailyPlanDate) {
    const date = base.dailyPlanDate;
    const dayContent = executionPlanContent({
      stops: base.stops || [],
      routeLegs: base.routeLegs || [],
      plannedCharges: base.plannedCharges || [],
    });
    const days = [{ dayIndex: 0, ...dayContent }];
    state.planDraft = {
      name: base.name || `${date} 日计划`, ownerId: state.principal?.principalId, planKind: 'plan', activeDay: 0, days, note: '',
      dailyPlanDate: date, localDate: date,
      cityCode: cityCodeFromDays(days) || base.cityCode || state.trip?.trip?.cityCode || '000000',
      timezone: base.timezone || activeTimezone(),
    };
    state.planDraft.days.forEach(day => {
      day.stops.forEach(stop => {
        const start = stopStartMinutes(stop);
        if (!Number.isFinite(stop.startMinutes) && Number.isFinite(start)) stop.startMinutes = start;
        const duration = stopDurationMinutes(stop);
        if (!Number.isFinite(stop.endMinutes) && Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
          stop.endMinutes = start + duration;
        }
      });
      const invalidTime = day.stops.some(stop => !Number.isFinite(stop.startMinutes) || !Number.isFinite(stop.endMinutes) ||
        stop.startMinutes < 0 || stop.endMinutes <= stop.startMinutes);
      sortStopsByStart(day);
      if (invalidTime) recomputeChain(day);
      sortStopsByStart(day);
    });
    const adjusted = state.planDraft.days.flatMap(day => autoAdjustOverlappingStops(day));
    refreshDraftScheduleErrors(state.planDraft);
    notifyAutoAdjustedStops(adjusted.length, count => `已自动错开 ${count} 个地点的时间，请保存计划保留调整。`);
    loadPlaceCatalog().catch(() => {});
    rememberPlanDraft(state.planDraft);
    queueDraftRoutes(activeDayDraft());
    return true;
  }
  if (base.editId) {
    const plan = (state.savedPlans || []).find(item => item.id === base.editId);
    if (!plan) return;
    const days = plan.kind === 'scheme'
      ? (plan.days || []).map(day => ({ dayIndex: day.dayIndex, stops: JSON.parse(JSON.stringify(day.stops || [])), routeLegs: JSON.parse(JSON.stringify(day.routeLegs || [])), plannedCharges: JSON.parse(JSON.stringify(day.plannedCharges || [])) }))
      : [{ dayIndex: 0, stops: JSON.parse(JSON.stringify(plan.stops || [])), routeLegs: JSON.parse(JSON.stringify(plan.routeLegs || [])), plannedCharges: JSON.parse(JSON.stringify(plan.plannedCharges || [])) }];
    if (!days.length) days.push({ dayIndex: 0, stops: [], routeLegs: [] });
    state.planDraft = { name: plan.name, ownerId: state.principal?.principalId, planKind: plan.kind, expectedRevision: plan.revision || 0, activeDay: 0, days, note: '', editId: plan.id, localDate: plan.localDate || '',
      cityCode: cityCodeFromDays(days) || plan.cityCode || '000000', timezone: plan.timezone || 'Asia/Shanghai' };
    // 已保存方案的各站时间可能是用户单独设定的；只补齐缺失时间，不能打开编辑器时重排覆盖。
    state.planDraft.days.forEach(day => {
      day.stops.forEach(stop => {
        const start = stopStartMinutes(stop);
        if (!Number.isFinite(stop.startMinutes) && Number.isFinite(start)) stop.startMinutes = start;
        const duration = stopDurationMinutes(stop);
        if (!Number.isFinite(stop.endMinutes) && Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
          stop.endMinutes = start + duration;
        }
      });
      const invalidTime = day.stops.some(stop => !Number.isFinite(stop.startMinutes) || !Number.isFinite(stop.endMinutes) ||
        stop.startMinutes < 0 || stop.endMinutes <= stop.startMinutes);
      sortStopsByStart(day);
      if (invalidTime) recomputeChain(day);
      sortStopsByStart(day);
    });
    const adjusted = state.planDraft.days.flatMap(day => autoAdjustOverlappingStops(day));
    refreshDraftScheduleErrors(state.planDraft);
    notifyAutoAdjustedStops(adjusted.length, count => `已自动错开 ${count} 个地点的时间，请保存方案保留调整。`);
    loadPlaceCatalog().catch(() => {});
    rememberPlanDraft(state.planDraft);
    queueDraftRoutes(activeDayDraft());
    return true;
  }
  // 当前计划的站点带着执行日期；方案是天级相对结构，底稿里的 date 一律剥掉，载入时再按起始日期盖章。
  // 底稿首站默认从 12:00 开始（可在站点行点击时间修改），后续站点自动顺延。
  const baseStops = (base.baseStops || []).map(stop => { const copy = { ...stop }; delete copy.date; return copy; });
  if (baseStops[0]) baseStops[0].startMinutes = 12 * 60;
  state.planDraft = { name: '', ownerId: state.principal?.principalId, planKind: 'scheme', activeDay: 0, days: [{ dayIndex: 0, stops: baseStops, routeLegs: [], plannedCharges: [] }], note: '', localDate: base.localDate || '',
    cityCode: cityCodeFromDays([ { stops: baseStops } ]) || state.trip?.trip.cityCode || '000000', timezone: activeTimezone() };
  recomputeChain(activeDayDraft());
  sortStopsByStart(activeDayDraft());
  const adjusted = autoAdjustOverlappingStops(activeDayDraft());
  normalizeSchemeDraft(state.planDraft);
  notifyAutoAdjustedStops(adjusted.length, count => `已自动顺延 ${count} 个地点，游览时长保持不变。`);
  loadPlaceCatalog().catch(() => {});
  state.planDraft.name = validDraftName(state.planDraft);
  rememberPlanDraft(state.planDraft);
  queueDraftRoutes(activeDayDraft());
  return true;
}

/** 打开选中日期的编辑器；快照日先转成独立日计划草稿，不改执行进度。 */
export function openSelectedDayPlanEditor(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('请选择有效的计划日期。');
  const dayPlans = (state.savedPlans || []).filter(plan => plan.kind === 'plan' && plan.localDate === date);
  if (dayPlans.length > 1) throw new Error('这一天有多份日计划，请先处理重复项。');
  const openDayDraft = base => {
    const showDay = () => { state.planViewDate = date; render(); };
    if (openPlanPlanner(base, showDay)) state.planViewDate = date;
  };
  if (dayPlans.length === 1) {
    openDayDraft({ editId: dayPlans[0].id });
    return;
  }
  if (!state.trip) {
    const cityCode = state.currentLocation?.cityCode || state.places.find(place => place.cityCode)?.cityCode || '000000';
    openDayDraft({
      dailyPlanDate: date, stops: [], routeLegs: [], plannedCharges: [],
      cityCode, timezone: activeTimezone(),
    });
    return;
  }
  const mountedDate = state.mountedDate || state.trip.trip.localDate;
  const allStops = state.trip.snapshot.stops || [];
  const dayStops = allStops.filter(stop => (stop.date ?? mountedDate) === date);
  const dayStopIds = new Set(dayStops.map(stop => stop.stopId));
  const routeLegs = (state.trip.snapshot.routeLegs || []).filter(leg =>
    dayStopIds.has(leg.toStopId) &&
    (['origin', 'my-location'].includes(leg.fromStopId) || dayStopIds.has(leg.fromStopId)),
  );
  const routeIds = new Set(routeLegs.map(leg => leg.legId));
  const plannedCharges = (state.trip.snapshot.plannedCharges || []).filter(charge =>
    (!charge.stopId || dayStopIds.has(charge.stopId)) &&
    (!charge.routeLegRef || routeIds.has(charge.routeLegRef)),
  );
  openDayDraft({
    dailyPlanDate: date,
    stops: dayStops,
    routeLegs,
    plannedCharges,
    cityCode: state.trip.trip.cityCode,
    timezone: state.trip.snapshot.timezone || state.trip.trip.timezone,
  });
}

// 重渲染会重建规划器表单；任何草稿操作前先把输入框里的名称/日期同步进状态，避免用户输入丢失。
const syncDraftInputs = () => {
  const draft = state.planDraft; if (!draft) return;
  const name = document.getElementById('draftName');
  if (name) draft.name = name.value;
  const startDate = document.getElementById('draftStartDate');
  if (startDate) draft.localDate = startDate.value;
};

/** Keep planner text/date fields in state as they change, so async renders cannot replace them with stale values. */
export function syncPlanDraftInput(input) {
  const draft = state.planDraft;
  if (!draft || !input) return;
  if (input.id === 'draftName') draft.name = input.value;
  else if (input.id === 'draftStartDate') draft.localDate = input.value;
  else return;
  retainPlanDraft(draft);
}

const activeDayDraft = () => {
  const draft = state.planDraft;
  return draft.days[draft.activeDay] || draft.days[0];
};

function recomputeChain(day) {
  const firstStart = day.stops.find(stop => stop.status !== 'skipped')?.startMinutes;
  let start = Number.isFinite(firstStart) && firstStart >= 0 ? firstStart : 9 * 60;
  let index = 0;
  let previous = null;
  for (const stop of day.stops) {
    if (stop.status === 'skipped') continue;
    const originalStart = Number.isFinite(stop.startMinutes) ? stop.startMinutes : start;
    const originalEnd = Number.isFinite(stop.endMinutes) ? stop.endMinutes : originalStart + (Number(stop.plannedDurationMinutes) || 60);
    const duration = Math.min(720, Math.max(15, originalEnd - originalStart));
    if (previous) start = previous.endMinutes + (routeTravelMinutes(incomingPlanRoute(day, previous, stop)) ?? 0);
    // Unknown transport supplies no duration: preserve user spacing, without claiming reachability.
    if (Number.isFinite(stop.startMinutes)) start = Math.max(start, stop.startMinutes);
    const validLockedStart = originalStart >= 0;
    if (index > 0 && validLockedStart && (stop.timeLocked || stop.lockTime)) start = originalStart;
    if (stop.status && stop.status !== 'planned') { previous = stop; start = originalEnd; index += 1; continue; }
    stop.plannedArrivalMinutes = start;
    stop.startMinutes = start;
    stop.endMinutes = start + duration;
    stop.departureMinutes = start + duration;
    // Route completion changes travel timing, not the user's visit constraint.
    stop.minDurationMinutes = Number.isFinite(stop.minDurationMinutes)
      ? Math.min(stop.minDurationMinutes, duration) : duration;
    stop.plannedDurationMinutes = duration;
    start = stop.departureMinutes;
    previous = stop;
    index += 1;
  }
  day.note = planRouteSummary(day).note;
}

function findScheduleOverlap(day) {
  const scheduled = (day?.stops || [])
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => stop.status !== 'skipped' &&
      Number.isFinite(stop.startMinutes) && Number.isFinite(stop.endMinutes) && stop.endMinutes > stop.startMinutes);
  for (let left = 0; left < scheduled.length; left += 1) {
    for (let right = left + 1; right < scheduled.length; right += 1) {
      const a = scheduled[left];
      const b = scheduled[right];
      if (a.stop.startMinutes < b.stop.endMinutes && b.stop.startMinutes < a.stop.endMinutes) {
        return { first: a.stop, second: b.stop };
      }
    }
  }
  return null;
}

/**
 * Move only the overlapping suffix forward. Existing gaps and visit durations
 * stay intact, and applying the adjustment twice produces the same schedule.
 */
function autoAdjustOverlappingStops(day) {
  if (!Array.isArray(day?.stops)) return [];
  sortStopsByStart(day);
  let delay = 0;
  let previousEnd = Number.NEGATIVE_INFINITY;
  const adjusted = [];

  for (const stop of day.stops) {
    if (stop.status === 'skipped' || !Number.isFinite(stop.startMinutes) ||
      !Number.isFinite(stop.endMinutes) || stop.endMinutes <= stop.startMinutes) continue;

    const originalStart = stop.startMinutes;
    const duration = stop.endMinutes - originalStart;
    let nextStart = originalStart + delay;
    if (nextStart < previousEnd) {
      delay += previousEnd - nextStart;
      nextStart = originalStart + delay;
    }

    if (nextStart !== originalStart) {
      const shift = nextStart - originalStart;
      const nextEnd = nextStart + duration;
      stop.startMinutes = nextStart;
      stop.plannedStartMinutes = Number.isFinite(stop.plannedStartMinutes)
        ? stop.plannedStartMinutes + shift : nextStart;
      stop.plannedArrivalMinutes = Number.isFinite(stop.plannedArrivalMinutes)
        ? stop.plannedArrivalMinutes + shift : nextStart;
      stop.endMinutes = nextEnd;
      stop.departureMinutes = Number.isFinite(stop.departureMinutes)
        ? stop.departureMinutes + shift : nextEnd;
      stop.plannedDepartureMinutes = Number.isFinite(stop.plannedDepartureMinutes)
        ? stop.plannedDepartureMinutes + shift : nextEnd;
      if (Number.isFinite(stop.travelStartMinutes)) stop.travelStartMinutes += shift;
      stop.plannedDurationMinutes = duration;
      stop.minDurationMinutes = Number.isFinite(stop.minDurationMinutes)
        ? Math.min(stop.minDurationMinutes, duration) : duration;
      if (Number.isFinite(stop.durationSeconds)) stop.durationSeconds = duration * 60;
      if (Number.isFinite(stop.minDurationSeconds)) {
        stop.minDurationSeconds = Math.min(stop.minDurationSeconds, duration * 60);
      }
      adjusted.push(stop);
    }

    previousEnd = nextStart + duration;
  }

  return adjusted;
}

function notifyAutoAdjustedStops(count, message) {
  if (!count || typeof document === 'undefined' || !document.getElementById?.('toast')) return;
  toast(message(count));
}

function scheduleOverlapMessage(overlap) {
  if (!overlap) return '';
  const first = overlap.first.place?.name || overlap.first.stopId || '前一地点';
  const second = overlap.second.place?.name || overlap.second.stopId || '后一地点';
  return `「${first}」与「${second}」的游览时间重叠，请调整后再保存。`;
}

function dayScheduleError(day) {
  return scheduleOverlapMessage(findScheduleOverlap(day));
}

function draftScheduleIssue(draft) {
  for (const day of draft?.days || []) {
    const message = dayScheduleError(day);
    if (message) return { day, message };
    const conflict = planRouteSummary(day).conflict;
    if (conflict) return { day, message: `「${conflict.previous.place?.name || conflict.previous.stopId}」到「${conflict.stop.place?.name || conflict.stop.stopId}」的${TRANSPORT_LABELS[conflict.mode] || '交通'}需要至少 ${conflict.minutes} 分钟，请调整开始时间。` };
  }
  const visits = (draft?.days || []).flatMap(day => (day.stops || [])
    .filter(stop => stop.status !== 'skipped' && Number.isFinite(stop.startMinutes) &&
      Number.isFinite(stop.endMinutes) && stop.endMinutes > stop.startMinutes)
    .map(stop => ({ day, stop, start: day.dayIndex * 1440 + stop.startMinutes, end: day.dayIndex * 1440 + stop.endMinutes })))
    .sort((left, right) => left.start - right.start);
  for (let left = 0; left < visits.length; left += 1) {
    for (let right = left + 1; right < visits.length; right += 1) {
      const first = visits[left];
      const second = visits[right];
      if (second.start >= first.end) break;
      if (first.day.dayIndex !== second.day.dayIndex && first.start < second.end && second.start < first.end) {
        const firstName = first.stop.place?.name || first.stop.stopId || '前一天地点';
        const secondName = second.stop.place?.name || second.stop.stopId || '后一天地点';
        return {
          day: first.day,
          message: `第 ${first.day.dayIndex + 1} 天「${firstName}」与第 ${second.day.dayIndex + 1} 天「${secondName}」的游览时间重叠，请调整。`,
        };
      }
    }
  }
  return null;
}

function refreshDraftScheduleErrors(draft) {
  normalizeSchemeDraft(draft);
  for (const day of draft?.days || []) delete day.timeError;
  const issue = draftScheduleIssue(draft);
  if (issue) issue.day.timeError = issue.message;
  return issue;
}

const withActiveDay = (fn) => {
  const draft = state.planDraft; if (!draft) return;
  if (Object.hasOwn(draft, 'ownerId') && draft.ownerId !== state.principal?.principalId) throw new Error('账号已切换，请重新打开编辑器。');
  syncDraftInputs();
  const day = activeDayDraft(); if (!day) return;
  const previousIds = new Set(day.stops.map(stop => stop.stopId));
  fn(draft, day);
  recomputeChain(day);
  sortStopsByStart(day);
  const adjusted = autoAdjustOverlappingStops(day);
  const added = day.stops.find(stop => !previousIds.has(stop.stopId));
  normalizeSchemeDraft(draft, added?.stopId);
  refreshDraftScheduleErrors(draft);
  notifyAutoAdjustedStops(adjusted.length, count => `已自动顺延 ${count} 个地点，游览时长保持不变。`);
  queueDraftRoutes(day);
  if (activeDayDraft() !== day) queueDraftRoutes(activeDayDraft());
  return day;
};

function pruneDraftReferences(day) {
  const aliasesFor = (stop) => [stop.stopId, stop.placeId, stop.place?.placeId].filter(value => typeof value === 'string' && value);
  const stopReferences = new Set((day.stops || []).flatMap(aliasesFor));
  const activeStops = (day.stops || []).filter(stop => stop.status !== 'skipped' && stop.stopId);
  const adjacentPairs = new Set();
  activeStops.forEach((stop, index) => {
    const toAliases = aliasesFor(stop);
    if (index === 0) {
      for (const toId of toAliases) {
        adjacentPairs.add(`origin\u0000${toId}`);
        adjacentPairs.add(`my-location\u0000${toId}`);
      }
    } else {
      for (const fromId of aliasesFor(activeStops[index - 1])) {
        for (const toId of toAliases) adjacentPairs.add(`${fromId}\u0000${toId}`);
      }
    }
  });
  const oldLegs = day.routeLegs || [];
  day.routeLegs = oldLegs.filter(leg => adjacentPairs.has(`${leg.fromStopId}\u0000${leg.toStopId}`));
  const routeLegIds = new Set(day.routeLegs.map(leg => leg.legId));
  const oldCharges = day.plannedCharges || [];
  day.plannedCharges = oldCharges.filter(charge =>
    (!charge.stopId || stopReferences.has(charge.stopId)) &&
    (!charge.routeLegRef || routeLegIds.has(charge.routeLegRef)));
  return {
    removedRoutes: oldLegs.length - day.routeLegs.length,
    removedCharges: oldCharges.length - day.plannedCharges.length,
  };
}

function showRouteCleanup(day, cleanup, reason) {
  if (cleanup.removedRoutes || cleanup.removedCharges) {
    day.routeWarning = `${reason}；关联路线和费用已清理，载入行程后可在地图重新规划路线。`;
  }
}

export function draftSwitchDay(dayIndex) {
  const draft = state.planDraft; if (!draft) return;
  syncDraftInputs();
  const position = draft.days.findIndex(day => day.dayIndex === dayIndex);
  if (position >= 0) {
    draft.activeDay = position;
    queueDraftRoutes(draft.days[position]);
  }
}
export function setDraftDayCount(value) {
  const draft = state.planDraft;
  if (!draft) return;
  const count = Number(value);
  const maxCount = Math.max(366, draft.days.length);
  if (!Number.isSafeInteger(count) || count < 1 || count > maxCount) {
    throw new Error(`方案天数需在 1 到 ${maxCount} 天之间。`);
  }
  syncDraftInputs();
  if (count < draft.days.length && schemeDayContinuations(draft.days.slice(0, count), count).length) {
    throw new Error('前一天的游览仍延续到后续日期，请先调整跨日地点的时间，再减少天数。');
  }
  if (count < draft.days.length) draft.days.splice(count);
  while (draft.days.length < count) {
    draft.days.push({ dayIndex: draft.days.length, stops: [], routeLegs: [], plannedCharges: [] });
  }
  draft.days.forEach((day, index) => { day.dayIndex = index; });
  draft.activeDay = Math.min(Math.max(0, draft.activeDay ?? 0), count - 1);
  refreshDraftScheduleErrors(draft);
}

export function requestDraftDayCountChange(value) {
  const draft = state.planDraft;
  if (!draft) return false;
  const count = Number(value);
  const maxCount = Math.max(366, draft.days.length);
  if (!Number.isSafeInteger(count) || count < 1 || count > maxCount) {
    throw new Error(`方案天数需在 1 到 ${maxCount} 天之间。`);
  }
  if (count >= draft.days.length) {
    setDraftDayCount(count);
    return true;
  }
  const removedDays = draft.days.slice(count);
  const removedStops = removedDays.flatMap(day => day.stops || []);
  const removedCharges = removedDays.flatMap(day => day.plannedCharges || []);
  const hasOtherContent = removedDays.some(day => (day.routeLegs || []).length > 0);
  if (!removedStops.length && !removedCharges.length && !hasOtherContent) {
    setDraftDayCount(count);
    return true;
  }
  syncDraftInputs();
  const removedDayLabel = removedDays.map(day => day.dayIndex + 1).join('、');
  const contents = [
    removedStops.length ? `${removedStops.length} 个地点` : '',
    removedCharges.length ? `${removedCharges.length} 项费用` : '',
    hasOtherContent && !removedStops.length ? '路线信息' : '',
  ].filter(Boolean).join('、');
  openSheet(`<div class="sheet-head"><h3>缩短方案天数？</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
    <p>将删除第 ${removedDayLabel} 天${contents ? `的${contents}` : '的安排'}。此操作只修改方案。</p>
    <div class="stop-actions"><button class="btn-danger" data-action="confirm-plan-day-count" data-count="${count}">删除并调整天数</button><button class="btn-ghost" data-action="close-sheet">取消</button></div>`);
  return false;
}

export function draftMove(index, dir) {
  const day = activeDayDraft();
  const next = index + dir;
  if (!day || next < 0 || next >= day.stops.length) return;
  withActiveDay((_draft, activeDay) => {
    [activeDay.stops[index], activeDay.stops[next]] = [activeDay.stops[next], activeDay.stops[index]];
  });
  showRouteCleanup(day, pruneDraftReferences(day), '地点顺序已调整');
}

export function draftRemove(index) {
  const day = activeDayDraft();
  if (!day?.stops?.[index]) return;
  withActiveDay((_draft, activeDay) => { activeDay.stops.splice(index, 1); });
  showRouteCleanup(day, pruneDraftReferences(day), '已删除地点');
}

export function draftAdjustDuration(index, delta) {
  withActiveDay((draft, day) => {
    const stop = day.stops[index]; if (!stop) return;
    const duration = Math.max(15, Math.min(480, (stop.endMinutes - stop.startMinutes) + delta));
    stop.endMinutes = stop.startMinutes + duration;
  });
}

export function setDraftStopDuration(dayIndex, stopId, index, minutes) {
  const draft = state.planDraft;
  if (!draft) return false;
  const day = draft.days.find(item => item.dayIndex === dayIndex) ?? draft.days[dayIndex];
  if (!day) return false;
  const stopIndex = stopId ? day.stops.findIndex(item => item.stopId === stopId) : index;
  const stop = day.stops[stopIndex];
  if (!stop) return false;
  syncDraftInputs();
  const duration = Math.max(15, Math.min(480, Math.round(Number(minutes) / 15) * 15 || 15));
  const fitted = fitPlanStopTime(day, stop.stopId, stop.startMinutes, duration);
  day.stops = fitted.stops;
  if (fitted.corrected) draft.saveNotice = `已填入可用时段：${fmt(fitted.start)}，停留 ${fitted.duration} 分钟，保留前后固定安排。`;
  else delete draft.saveNotice;
  normalizeSchemeDraft(draft, stop.stopId);
  refreshDraftScheduleErrors(draft);
  notifyAutoAdjustedStops(fitted.adjusted.length, count => `已自动顺延 ${count} 个地点，游览时长保持不变。`);
  queueDraftRoutes(day);
  if (activeDayDraft() !== day) queueDraftRoutes(activeDayDraft());
  return true;
}

function draftPlace(placeId) {
  return [...(state.placeCatalog || []), ...(state.mapPlaces || []), ...(state.places || [])].find(item => item.placeId === placeId);
}

function appendDraftPlace(place) {
  withActiveDay((draft, day) => {
    const duration = Math.max(15, Number(place.suggestedDurationMinutes) || 60);
    const last = [...day.stops].reverse().find(stop => stop.status !== 'skipped');
    const continuationEnd = draft.planKind === 'plan' || draft.dailyPlanDate ? 0 :
      Math.max(0, ...schemeDayContinuations(draft.days, day.dayIndex).map(item => item.endMinutes));
    const firstStart = draft.planKind === 'plan' || draft.dailyPlanDate
      ? dailyFirstStopMinutes(draft.dailyPlanDate || draft.localDate, draft.timezone)
      : 12 * 60;
    const start = last ? last.departureMinutes ?? last.endMinutes : Math.max(firstStart, continuationEnd);
    day.stops.push({ stopId: `draft_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`, placeId: place.placeId,
      place: { placeId: place.placeId, name: place.name, coordinates: place.coordinates || null, cityCode: place.cityCode, facilityCodes: place.facilityCodes || [], evidenceIds: place.evidenceIds || [] },
      plannedArrivalMinutes: start, startMinutes: start, endMinutes: start + duration, departureMinutes: start + duration,
      minDurationMinutes: duration, plannedDurationMinutes: duration, status: 'planned' });
  });
}

export function draftAddPlace(placeId) {
  const draft = state.planDraft;
  if (!draft) return;
  if (Object.hasOwn(draft, 'ownerId') && draft.ownerId !== state.principal?.principalId) throw new Error('账号已切换，请重新打开编辑器。');
  syncDraftInputs();
  const place = draftPlace(placeId);
  if (!place) throw new Error('地点不存在，请刷新后重试。');
  // A place identifies the destination; a fresh stop identifies this visit.
  appendDraftPlace(place);
  return true;
}

export function moveEmptyDayDraftToTomorrow() {
  const draft = state.planDraft;
  if (!draft?.dailyPlanDate || draft.editId || draft.days.some(day => day.stops.length)) return false;
  const oldDate = draft.dailyPlanDate;
  const next = new Date(Date.parse(`${oldDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (draft.name === `${oldDate} 日计划`) draft.name = `${next} 日计划`;
  draft.dailyPlanDate = next;
  draft.localDate = next;
  state.planViewDate = next;
  rememberPlanDraft(draft);
  return true;
}

  /** Continue the daily editor rather than saving a competing plan behind it. */
  export function addPlaceToDayDraft(placeId, date) {
    const draft = dayPlanDraftForDate(date);
    if (!draft) return false;
    if (Object.hasOwn(draft, 'ownerId') && draft.ownerId !== state.principal?.principalId) throw new Error('账号已切换，请重新打开编辑器。');
    state.planViewDate = date;
    navigate('today');
    const added = draftAddPlace(placeId);
    render();
    if (added) {
      focusPlanVisit(activeDayDraft().stops.at(-1).stopId);
      toast('地点已加入编辑草稿，保存后生效');
    }
    return true;
  }

export function setDraftTransportMode(mode) {
  if (!state.planDraft || !TRANSPORT_LABELS[mode]) return;
  syncDraftInputs();
  const day = activeDayDraft();
  day.transportMode = mode;
  day.note = planRouteSummary(day).note;
  refreshDraftScheduleErrors(state.planDraft);
}

const draftRouteRequests = new WeakMap();
const draftRouteTimers = new WeakMap();
const settledRouteSignatures = new WeakMap();
const routeRequestSignature = day => JSON.stringify({ dayMode: day.transportMode || '',
  stops: (day.stops || []).map((stop, index) => [stop.stopId, stop.status, stop.startMinutes, stop.endMinutes,
    transportModeToStop(day, stop, day.stops[index - 1]), stop.place]),
});
export function queueDraftRoutes(day = activeDayDraft()) {
  const draft = state.planDraft;
  if (!draft || !day || !draft.days.includes(day)) return;
  const oldTimer = draftRouteTimers.get(day);
  if (oldTimer) clearTimeout(oldTimer.timer);
  draftRouteTimers.delete(day);
  const stops = (day.stops || []).filter(stop => stop.status !== 'skipped');
  if (stops.length < 2) {
    const active = draftRouteRequests.get(day);
    if (active) { active.controller.abort(); draftRouteRequests.delete(day); }
    day.routePending = false;
    return;
  }
  const hasRouteableSegment = stops.slice(1).some((stop, index) => {
    const origin = stops[index].place, destination = stop.place;
    return origin?.coordinates && destination?.coordinates &&
      (!origin.cityCode || !destination.cityCode || origin.cityCode === destination.cityCode);
  });
  if (!hasRouteableSegment) {
    const active = draftRouteRequests.get(day);
    if (active) { active.controller.abort(); draftRouteRequests.delete(day); }
    day.routePending = false; return;
  }
  const signature = routeRequestSignature(day);
  if (settledRouteSignatures.get(day) === signature ||
    (planRouteSummary(day).unknown === 0 && !draftRouteRequests.get(day))) {
    day.routePending = false;
    return;
  }
  if (draftRouteRequests.get(day)?.signature === signature) return;
  const active = draftRouteRequests.get(day);
  if (active) { active.controller.abort(); draftRouteRequests.delete(day); }
  day.routePending = true;
  const record = { signature, timer: setTimeout(() => {
    if (draftRouteTimers.get(day) !== record) return;
    draftRouteTimers.delete(day);
    if (state.planDraft !== draft || !draft.days.includes(day) ||
      !['plan', 'today'].includes(state.currentView)) { day.routePending = false; return; }
    estimateDraftRoutes(day, { force: false }).catch(error => {
      day.routePending = false; day.routeWarning = error?.message || '路线暂不可用';
      if (state.planDraft === draft) render();
    });
  }, 120) };
  draftRouteTimers.set(day, record);
}

export function setDraftStopTransportMode(dayIndex, stopId, mode) {
  const draft = state.planDraft;
  if (!draft || !TRANSPORT_LABELS[mode]) return false;
  const day = draft.days.find(item => item.dayIndex === dayIndex);
  const stop = day?.stops?.find(item => item.stopId === stopId);
  if (!stop || stop.status && stop.status !== 'planned') return false;
  if (Object.hasOwn(draft, 'ownerId') && draft.ownerId !== state.principal?.principalId) throw new Error('账号已切换，请重新打开编辑器。');
  syncDraftInputs();
  const index = day.stops.indexOf(stop);
  const previous = [...day.stops.slice(0, index)].reverse().find(item => item.status !== 'skipped');
  const affected = previous ? (day.routeLegs || []).filter(leg => matchesPlanRoute(leg, previous, stop)) : [];
  const paid = (day.plannedCharges || []).some(charge => affected.some(leg => leg.legId === charge.routeLegRef) && charge.paymentStatus === 'paid');
  if (transportModeToStop(day, stop, previous) === mode) {
    stop.preferredTransportMode = mode;
    retainPlanDraft(draft);
    queueDraftRoutes(day);
    return true;
  }
  if (paid) throw new Error('这段交通关联已支付费用，请先核对费用再修改交通方式。');
  stop.preferredTransportMode = mode;
  const affectedIds = new Set(affected.map(leg => leg.legId));
  day.routeLegs = (day.routeLegs || []).filter(leg => !affectedIds.has(leg.legId));
  day.plannedCharges = (day.plannedCharges || []).filter(charge => !charge.routeLegRef || !affectedIds.has(charge.routeLegRef));
  day.routeWarning = '';
  refreshDraftScheduleErrors(draft);
  retainPlanDraft(draft);
  queueDraftRoutes(day);
  return true;
}

export async function estimateDraftRoutes(day = activeDayDraft(), { force = true, targetStopId = null } = {}) {
  const draft = state.planDraft;
  if (!draft || !day || !draft.days.includes(day)) return;
  syncDraftInputs();
  const owner = state.principal?.principalId, view = state.currentView;
  const stops = (day.stops || []).filter(stop => stop.status !== 'skipped');
  if (stops.length < 2) return;
  const segments = stops.slice(1).map((stop, index) => ({ previous: stops[index], stop,
    mode: transportModeToStop(day, stop, stops[index]) })).filter(segment =>
    (!targetStopId || segment.stop.stopId === targetStopId) &&
    (force || !incomingPlanRoute(day, segment.previous, segment.stop)));
  if (!segments.length) { day.routePending = false; return; }
  const signature = routeRequestSignature(day);
  if (draftRouteRequests.get(day)?.signature === signature) return draftRouteRequests.get(day).promise;
  if (draftRouteRequests.get(day)) {
    draftRouteRequests.get(day).controller.abort(); draftRouteRequests.delete(day);
  }
  const controller = new AbortController(), record = { signature, controller, promise: null };
  draftRouteRequests.set(day, record);
  day.routePending = true;
  render();
  record.promise = (async () => {
    const results = await Promise.allSettled(segments.map(segment => requestPlanRoute(api, segment.previous, segment.stop, segment.mode, controller.signal)));
    const valid = state.planDraft === draft && draft.days.includes(day) && state.principal?.principalId === owner &&
      state.currentView === view && signature === routeRequestSignature(day) && draftRouteRequests.get(day) === record && !controller.signal.aborted;
    if (!valid) return;
    const oldRoutes = day.routeLegs || [];
    day.routeLegs = oldRoutes.filter(leg => !segments.some(segment => matchesPlanRoute(leg, segment.previous, segment.stop)));
    day.routeLegs.push(...results.filter(result => result.status === 'fulfilled').map(result => result.value));
    const retainedRoutes = new Set(day.routeLegs.map(leg => leg.legId));
    day.plannedCharges = (day.plannedCharges || []).filter(charge => !charge.routeLegRef || retainedRoutes.has(charge.routeLegRef));
    recomputeChain(day);
    refreshDraftScheduleErrors(draft);
    const failed = results.filter(result => result.status === 'rejected');
    day.routeWarning = failed.length ? `${failed.length} 段交通未能计算：${[...new Set(failed.map(result => result.reason?.message || '路线服务暂不可用'))].join('；')}` : '';
    settledRouteSignatures.set(day, routeRequestSignature(day));
    retainPlanDraft(draft);
  })().finally(() => {
    if (draftRouteRequests.get(day) === record) {
      draftRouteRequests.delete(day); day.routePending = false;
      if (state.planDraft === draft && state.currentView === view) render();
    }
  });
  return record.promise;
}

/** 时间选择作为偏好：按顺序、已知道路和固定安排回填可用值，不自动添加固定标记。 */
export function setDraftStopStart(dayIndex, stopIndex, minutes) {
  const draft = state.planDraft;
  if (!draft) return false;
  const day = draft.days.find(item => item.dayIndex === dayIndex) ?? draft.days[dayIndex] ?? draft.days[0];
  const stop = day?.stops?.[stopIndex];
  if (!stop) return false;
  const nextStops = day.stops.map(item => ({ ...item }));
  const nextStop = nextStops[stopIndex];
  const duration = Math.min(720, Math.max(15, stop.endMinutes - stop.startMinutes));
  nextStop.startMinutes = Math.max(0, minutes);
  nextStop.endMinutes = nextStop.startMinutes + duration;
  const nextDay = { ...day, stops: nextStops };
  sortStopsByStart(nextDay);
  const fitted = fitPlanStopTime(nextDay, stop.stopId, nextStop.startMinutes, duration);
  nextDay.stops = fitted.stops;
  sortStopsByStart(nextDay);
  const candidate = { ...draft, days: draft.days.map(item => item === day ? nextDay : item) };
  if (candidate.planKind !== 'plan' && !candidate.dailyPlanDate) candidate.days = normalizeSchemeDays(candidate.days);
  const issue = draftScheduleIssue(candidate);
  if (issue) {
    day.timeError = issue.message;
    return false;
  }
  day.stops = nextDay.stops;
  showRouteCleanup(day, pruneDraftReferences(day), '时间调整后地点顺序已变化');
  day.note = nextDay.note;
  if (fitted.corrected) draft.saveNotice = `已按前后安排填入可用时间：${fmt(fitted.start)}，停留 ${fitted.duration} 分钟。`;
  else delete draft.saveNotice;
  normalizeSchemeDraft(draft, stop.stopId);
  refreshDraftScheduleErrors(draft);
  notifyAutoAdjustedStops(fitted.adjusted.length, count => `已自动顺延 ${count} 个地点，游览时长保持不变。`);
  queueDraftRoutes(day);
  if (activeDayDraft() !== day) queueDraftRoutes(activeDayDraft());
  return true;
}

const draftSaveRequests = new WeakMap();
export async function savePlanDraft() {
  const draft = state.planDraft; if (!draft) return;
  if (draftSaveRequests.has(draft)) return draftSaveRequests.get(draft);
  draft.saving = true;
  const request = savePlanDraftContent(draft).finally(() => {
    draft.saving = false;
    draftSaveRequests.delete(draft);
  });
  draftSaveRequests.set(draft, request);
  return request;
}

async function savePlanDraftContent(draft) {
  if (draft.days?.some(day => day.routePending)) throw new Error('道路时间正在计算，请完成后再保存。');
  if (Object.hasOwn(draft, 'ownerId') && draft.ownerId !== state.principal?.principalId) throw new Error('账号已切换，请重新打开编辑器。');
  syncDraftInputs();
  let adjustedCount = 0;
  for (const day of draft.days) {
    sortStopsByStart(day);
    adjustedCount += autoAdjustOverlappingStops(day).length;
  }
  const issue = refreshDraftScheduleErrors(draft);
  if (issue) {
    draft.activeDay = draft.days.indexOf(issue.day);
    throw new Error(issue.message);
  }
  const enteredName = draft.name;
  draft.name = validDraftName(draft);
  const nameInput = document.getElementById('draftName');
  if (nameInput) nameInput.value = draft.name;
  if (draft.name !== enteredName) draft.saveNotice = `名称已自动填写为「${draft.name}」。`;
  const startDateInput = document.getElementById('draftStartDate');
  if (startDateInput) draft.localDate = startDateInput.value || '';
  const days = draft.days.map(day => ({ dayIndex: day.dayIndex, stops: day.stops.map(stop => { const copy = { ...stop }; delete copy.date; return copy; }), routeLegs: day.routeLegs, plannedCharges: day.plannedCharges || [] }));
  const submittedContent = planDraftContentKey(draft);
  let saved;
  if (draft.dailyPlanDate) {
    const latestPlans = await loadPlans();
    if (state.planDraft !== draft || (Object.hasOwn(draft, 'ownerId') && draft.ownerId !== state.principal?.principalId)) throw new Error('编辑器已变化，请重新查看后再保存。');
    if (latestPlans.some(plan => plan.kind === 'plan' && plan.localDate === draft.dailyPlanDate)) {
      throw new Error('这一天已生成日计划，请刷新日期后再编辑。');
    }
    const baseName = draft.name.trim() || `${draft.dailyPlanDate} 日计划`;
    const existingNames = new Set(latestPlans.map(plan => plan.name));
    let name = baseName;
    for (let suffix = 2; existingNames.has(name); suffix += 1) { const tail = ` ${suffix}`; name = baseName.slice(0, 40 - tail.length) + tail; }
    const day = days[0] || { stops: [], routeLegs: [], plannedCharges: [] };
    saved = await api('/api/v1/plans', { method: 'POST', body: JSON.stringify({
      name, kind: 'plan', source: 'current', localDate: draft.dailyPlanDate,
      cityCode: cityCodeFromDays(days) || draft.cityCode || '000000',
      timezone: draft.timezone || 'Asia/Shanghai',
      snapshot: { stops: day.stops.map(stop => ({ ...stop, date: draft.dailyPlanDate })), routeLegs: day.routeLegs, plannedCharges: day.plannedCharges },
    }) });
  } else if (draft.editId) {
    // 原地编辑：整体更新回同一个方案（日期留空＝改回日期待定）。
    saved = await api(`/api/v1/plans/${encodeURIComponent(draft.editId)}`, { method: 'PUT', body: JSON.stringify({
      name: draft.name, expectedRevision: draft.expectedRevision ?? 0, cityCode: cityCodeFromDays(days) || draft.cityCode || '000000',
      timezone: draft.timezone || 'Asia/Shanghai',
      ...(draft.localDate ? { localDate: draft.localDate } : {}), days,
    }) });
    toast(adjustedCount ? `已自动顺延 ${adjustedCount} 个地点，方案已更新。` : '方案已更新');
  } else {
    saved = await api('/api/v1/plans', { method: 'POST', body: JSON.stringify({
      name: draft.name, kind: 'scheme', source: 'draft',
      cityCode: cityCodeFromDays(days) || draft.cityCode || '000000',
      timezone: draft.timezone || 'Asia/Shanghai',
      ...(draft.localDate ? { localDate: draft.localDate } : {}), days,
    }) });
    toast(adjustedCount ? `已自动顺延 ${adjustedCount} 个地点，方案已保存。` : '方案已保存到我的方案库');
  }
  if (state.planDraft !== draft || (Object.hasOwn(draft, 'ownerId') && draft.ownerId !== state.principal?.principalId)) return saved;
  if (planDraftContentKey(draft) !== submittedContent) {
    draft.editId = saved.id;
    draft.expectedRevision = saved.revision || 0;
    draft.planKind = saved.kind;
    delete draft.dailyPlanDate;
    delete draft.saveError;
    draft.saveNotice = '提交时的内容已保存；之后的修改仍在草稿中，请核对后再保存。';
    retainPlanDraft(draft);
    await loadPlans().catch(() => {});
    return saved;
  }
  clearPlanDraft(draft);
  state.planDraft = null;
  await loadPlans().catch(() => {});
  return saved;
}

let pendingDraftScheme = null;
let draftSchemeSequence = 0;
export function openDraftAsScheme() {
  const draft = state.planDraft;
  if (!draft || draft.ownerId !== state.principal?.principalId) return;
  syncDraftInputs();
  const token = String(++draftSchemeSequence);
  pendingDraftScheme = { draft, content: planDraftContentKey(draft), owner: draft.ownerId, token };
  openSheet(`<div class="sheet-head"><h3>保留为新方案草稿？</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">×</button></div><p>保留「${escapeHtml(draft.name || '未命名计划')}」里的地点、时段和路线，日期改为待定。之后可重新选择出行日期。</p><p class="stop-meta">原计划和真实进度不变。转为草稿后仍需点击保存。</p><div class="stop-actions"><button class="btn-soft" data-action="close-sheet">先不转换</button><button class="btn-primary" data-action="confirm-draft-as-scheme" data-token="${token}">保留为新方案草稿</button></div>`);
}

export function confirmDraftAsScheme(button) {
  const pending = pendingDraftScheme;
  if (!pending || button?.dataset.token !== pending.token) return;
  pendingDraftScheme = null;
  if (state.planDraft !== pending.draft || state.principal?.principalId !== pending.owner || planDraftContentKey(pending.draft) !== pending.content) {
    closeSheet(); toast('草稿或账号已变化，当前内容已保留，请重新查看。', 'error'); return;
  }
  const draft = pending.draft;
  draft.days = draft.days.map(day => ({ ...day, ...executionPlanContent({
    ...day, stops: day.stops.map(stop => ({ ...stop, status: 'planned' })),
  }) }));
  delete draft.editId; delete draft.expectedRevision; delete draft.dailyPlanDate; delete draft.saveError; delete draft.saveNotice;
  draft.planKind = 'scheme'; draft.localDate = '';
  normalizeSchemeDraft(draft);
  retainPlanDraft(draft);
  closeSheet(); navigate('plan');
}

let pendingSave = null;
export function openSavePlanSheet(defaultName, snapshot, source, extras = {}) {
  pendingSave = { snapshot, source, extras };
  const dayCount = Math.max(1, snapshot?.days?.length || 1);
  openSheet(`<div class="sheet-head"><h3>存入计划</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
    <div class="field"><label for="planSheetName">方案名称</label><input id="planSheetName" maxlength="40" value="${escapeHtml(defaultName)}"></div>
    <p class="stop-meta">共 ${dayCount} 天，将按天存入方案库，之后可继续编辑或载入。</p>
    <button class="btn-primary" data-action="confirm-save-plan-sheet">存入</button>`);
}

export async function confirmSavePlanSheet() {
  if (!pendingSave) return;
  const button = document.querySelector('[data-action="confirm-save-plan-sheet"]');
  if (button) button.disabled = true;
  try {
    await savePlan($('planSheetName')?.value, pendingSave.snapshot, pendingSave.source, pendingSave.extras);
    pendingSave = null;
    closeSheet();
    await loadPlans().catch(() => {});
    render();
    toast('已存入方案库');
  } finally { if (button) button.disabled = false; }
}

export function confirmDeleteSavedPlan(id) {
  const plan = (state.savedPlans || []).find(item => item.id === id);
  if (!plan) throw new Error('这份安排已不存在，请刷新后查看。');
  const isScheme = plan.kind === 'scheme';
  const records = (plan.executionEvents || []).length;
  const detail = isScheme
    ? '仅删除这份方案候选，已载入的日计划和实际进度不受影响。'
    : `将删除这一天的 ${plan.stops?.length || 0} 个地点安排${records ? `，以及 ${records} 条实际进度记录` : ''}。该日计划的操作记录也会一并删除。`;
  openSheet(`<div class="sheet-head"><h3>${isScheme ? '删除这个方案？' : '删除这一天的计划？'}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
    <p>${escapeHtml(plan.name)}${isScheme ? '' : ` · ${escapeHtml(plan.localDate || '')}`}</p><p>${detail}</p><p>删除后无法恢复，请确认这份安排不再需要。</p><div class="stop-actions"><button class="btn-ghost" data-action="close-sheet">取消</button><button class="btn-danger" data-action="confirm-delete-saved-plan" data-plan="${escapeHtml(id)}">${isScheme ? '删除方案' : '删除日计划及记录'}</button></div>`);
}

export function confirmDeleteDatePlan(date) {
  const dayPlans = (state.savedPlans || []).filter(plan => plan.kind !== 'scheme' && plan.localDate === date);
  if (!dayPlans.length) return;
  if (dayPlans.length === 1) return confirmDeleteSavedPlan(dayPlans[0].id);
  openSheet(`<div class="sheet-head"><h3>选择要删除的日计划</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
    <p>${escapeHtml(monthDay(date))} 有多份日计划，请选择一份删除。</p>
    <div class="stop-actions">${dayPlans.map(plan => `<button class="btn-small btn-danger" data-action="delete-saved-plan" data-plan="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</button>`).join('')}<button class="btn-ghost" data-action="close-sheet">取消</button></div>`);
}

export async function removeSavedPlan(id) {
  // 删除当前查看日期的最后一份日计划后，清掉这个查看偏好。
  // 否则返回地图或重新打开「计划与进度」时，仍会拿已删除的日期查找
  // 计划，用户会看到空地图，误以为今天的安排丢失。
  const removedPlan = (state.savedPlans || []).find(item => item.id === id);
  await deleteSavedPlan(id);
  closeSheet();
  await loadPlans().catch(() => {});
  if (removedPlan?.kind !== 'scheme' && removedPlan?.localDate === state.planViewDate &&
      !(state.savedPlans || []).some(item => item.kind !== 'scheme' && item.localDate === removedPlan.localDate)) {
    state.planViewDate = '';
  }
  render();
  toast(removedPlan?.kind === 'scheme' ? '方案已删除' : '日计划及记录已删除');
}

/** 载入后只替换计划队列；真实进度由执行记录单独保留。 */
async function finishSchemeLoad(scheme, plans, adjustedDates = []) {
  await loadPlans().catch(() => {});
  const loadedStartDate = plans[0]?.localDate || scheme.localDate;
  if (loadedStartDate === dateKeyInTimeZone(new Date(), scheme.timezone || 'Asia/Shanghai')) {
    // 有实际进度的旧旅行继续保留其执行状态；普通日期计划直接由日计划承载。
    if (state.trip && !usesSavedDayPlans()) await mountPlanForDate(loadedStartDate);
    state.planViewDate = loadedStartDate;
    navigate('today');
    toast(`已载入「${scheme.name}」并切换到今天的计划（${plans.length} 天）${adjustedDates.length ? `，${adjustedDates.length} 天已顺延避开进度` : ''}`);
    return;
  }
  render();
  toast(`已载入「${scheme.name}」：生成 ${plans.length} 天计划（${loadedStartDate} 起）${adjustedDates.length ? `，${adjustedDates.length} 天已顺延避开进度` : ''}`);
}

function schemeLoadStartDate(scheme) {
  const today = dateKeyInTimeZone(new Date(), scheme.timezone || 'Asia/Shanghai');
  return scheme.localDate && scheme.localDate >= today ? scheme.localDate : today;
}

function showProgressLoadConflict(id, progressConflicts, replaceRequested, planConflict, confirmationToken, stale = false) {
  const rows = (progressConflicts || []).map(item => {
    const names = Array.isArray(item.names) ? item.names.map(name => escapeHtml(name)).join('、') : '已有进度';
    return `<li><strong>${escapeHtml(monthDay(item.date) || item.date)}</strong> · ${names}${item.timeOverlap ? ' <span class="plan-load-conflict-tag">时间顺序需调整</span>' : ''}</li>`;
  }).join('');
  openSheet(`<div class="sheet-head"><h3>载入方案前发现进度冲突</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
    ${stale ? '<p class="stop-meta">行程或计划刚刚有变化，请按当前内容重新确认。</p>' : ''}
    <ul class="change-list plan-load-conflict-list">${rows}</ul>
    <p>继续后只写入待进行计划，已完成、已跳过和正在进行的记录会保留。重复地点会作为新的计划节点导入；排在已完成进度之前或时间重叠的安排会自动顺延。导入的节点不会变成进行中节点。</p>
    ${planConflict ? `<p class="stop-meta">这些日期也已有日计划；${replaceRequested && !stale ? '你已确认替换。' : '继续后还会询问是否替换。'}</p>` : ''}
    <div class="stop-actions"><button class="btn-primary" data-action="confirm-scheme-progress-load" data-scheme="${escapeHtml(id)}" data-replace-existing="${replaceRequested && !stale ? 'true' : 'false'}" data-confirmation-token="${escapeHtml(confirmationToken || '')}">保留进度并继续载入</button><button class="btn-ghost" data-action="close-sheet">取消</button></div>`);
}

async function submitSchemeLoad(id, { replace = false, progressConfirmed = false, confirmationToken = '' } = {}) {
  const scheme = (state.savedPlans || []).find(item => item.id === id);
  if (!scheme) return;
  const result = await api(`/api/v1/plans/${encodeURIComponent(id)}/load`, { method: 'POST', body: JSON.stringify({
    startDate: schemeLoadStartDate(scheme),
    ...(state.trip?.trip?.tripId ? { tripId: state.trip.trip.tripId } : {}),
    replace,
    confirmProgressConflict: progressConfirmed,
    ...(confirmationToken ? { confirmationToken } : {}),
  }) });
  if (result.confirmationStale && !result.progressConflict && !result.conflict) {
    openSheet(`<div class="sheet-head"><h3>行程内容已变化</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
      <p>你确认期间，行程或计划内容发生了变化。请重新检查后载入。</p>
      <div class="stop-actions"><button class="btn-primary" data-action="load-scheme" data-scheme="${escapeHtml(id)}">重新检查并载入</button><button class="btn-ghost" data-action="close-sheet">取消</button></div>`);
    return;
  }
  if (result.progressConflict) {
    showProgressLoadConflict(id, result.progressConflicts, replace && !result.confirmationStale,
      result.conflict, result.confirmationToken, result.confirmationStale);
    return;
  }
  if (result.conflict) {
    const list = result.dates.map(date => monthDay(date)).join('、');
    openSheet(`<div class="sheet-head"><h3>载入方案「${escapeHtml(scheme.name)}」</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
      <p>以下日期已有计划：<strong>${escapeHtml(list)}</strong></p>
      <p class="stop-meta">载入会<b>替换</b>这些日期现有的计划，旧计划删除后不可恢复；其余日期不受影响。日期待定的内容在「方案候选」，不会被改动。</p>
      ${result.confirmationStale ? '<p class="stop-meta">行程或计划刚刚有变化，请按当前内容重新确认。</p>' : ''}
      <p class="stop-actions"><button class="btn-danger" data-action="confirm-replace-load" data-scheme="${escapeHtml(id)}" data-progress-confirmed="${progressConfirmed && !result.confirmationStale ? 'true' : 'false'}" data-confirmation-token="${escapeHtml(result.confirmationToken || '')}">替换并载入</button><button class="btn-ghost" data-action="close-sheet">取消</button></p>`);
    return;
  }
  await finishSchemeLoad(scheme, result.plans, result.progressAdjustedDates || []);
}

export async function loadSchemeAsPlans(id) {
  await submitSchemeLoad(id);
}

export async function confirmSchemeProgressLoad(id, replaceExisting = false, confirmationToken = '') {
  await submitSchemeLoad(id, { replace: replaceExisting, progressConfirmed: true, confirmationToken });
}

export async function confirmReplaceLoad(id, progressConfirmed = false, confirmationToken = '') {
  closeSheet();
  await submitSchemeLoad(id, { replace: true, progressConfirmed, confirmationToken });
}

/** 概览卡上的站点时间调整：与旅行内“调整时间”同款双时间输入，保存回方案库。 */
let planStopEdit = null;
const durationLabel = minutes => {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours && rest ? `${hours} 小时 ${rest} 分钟` : hours ? `${hours} 小时` : `${rest} 分钟`;
};

const planTimeStorage = (planId, stopId) => writingDraft('plan-stop-time', JSON.stringify([planId, stopId]));
function validTimeDraft(value) {
  return value && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 &&
    Number.isInteger(value.startMinutes) && value.startMinutes >= 0 && value.startMinutes < 43_200 &&
    Number.isInteger(value.durationMinutes) && value.durationMinutes >= 15 && value.durationMinutes <= 480;
}
function rememberPlanStopTime(edit) {
  if (!edit || edit.ownerId !== state.principal?.principalId || document.getElementById('planStopEditStatus') !== edit.marker) return;
  const raw = document.getElementById('planStopStart')?.value;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw || '')) return;
  const offset = Number(document.getElementById('planStopDayOffset')?.value || 0);
  const captured = { expectedRevision:edit.expectedRevision, startMinutes:offset * 1440 + parseTimeInput(raw),
    durationMinutes:Number(document.getElementById('planStopDuration')?.value) };
  if (!validTimeDraft(captured)) return;
  const retained = edit.storage.save(captured);
  const notice = document.getElementById('planStopDraftStatus');
  if (notice) notice.textContent = retained ? '调整已在本标签页暂存，关闭或刷新后可继续；尚未保存到计划。' : '调整已在本页暂存，关闭后可继续；刷新可能丢失。';
  return captured;
}

function planStopTimeFit(edit) {
  const plan = (state.savedPlans || []).find(item => item.id === edit.planId);
  if (edit.ownerId !== state.principal?.principalId || !plan || (plan.revision || 0) !== edit.expectedRevision) throw new Error('计划或账号已变化，请重新打开时间编辑；本次修改尚未保存。');
  const day = plan.kind === 'scheme' ? plan.days?.find(day => day.stops?.some(stop => stop.stopId === edit.stopId)) : plan;
  const raw = document.getElementById('planStopStart')?.value;
  const offsetInput = document.getElementById('planStopDayOffset');
  const offset = offsetInput ? Math.max(0, Math.floor(Number(offsetInput.value) || 0)) : Math.floor(edit.start / 1440);
  const start = /^([01]\d|2[0-3]):[0-5]\d$/.test(raw || '') ? offset * 1440 + parseTimeInput(raw) : edit.start;
  const duration = Math.max(15, Math.min(480, Number(document.getElementById('planStopDuration')?.value) || edit.duration));
  const fitted = plan.kind === 'plan' && plan.localDate
    ? fitDatedPlanStopTime(day, edit.stopId, start, duration, edit.carryPlans)
    : fitPlanStopTime(day, edit.stopId, start, duration);
  for (const expected of fitted.expectedCarryTargets || []) {
    const targets = (state.savedPlans || []).filter(item => item.kind === 'plan' && item.localDate === expected.localDate);
    const current = targets[0];
    if (targets.length > 1 || (current?.id || null) !== expected.planId || (current ? current.revision || 0 : null) !== expected.expectedRevision) {
      throw new Error('接续日期的安排已变化，请核对最新安排；本次时间调整尚未保存。');
    }
  }
  return { plan, day, fitted, corrected: fitted.corrected || raw !== fmt(start) };
}

function fillPlanStopTime() {
  const edit = planStopEdit;
  if (!edit || edit.saving) return;
  const status = document.getElementById('planStopEditStatus');
  try {
    status?.classList?.remove('has-error');
    const result = planStopTimeFit(edit), { fitted } = result;
    const startInput = document.getElementById('planStopStart');
    if (startInput) startInput.value = fmt(fitted.start);
    const dayInput = document.getElementById('planStopDayOffset');
    if (dayInput) {
      const offset = Math.floor(fitted.start / 1440);
      if (![...dayInput.options].some(option => Number(option.value) === offset)) dayInput.add(new Option(`第 ${offset + 1} 天`, String(offset)));
      dayInput.value = String(offset);
    }
    const durationInput = document.getElementById('planStopDuration');
    if (durationInput) durationInput.value = String(fitted.duration);
    const button = document.getElementById('planStopDurationBtn');
    if (button) button.textContent = durationLabel(fitted.duration);
    if (status) status.textContent = result.corrected ? `已按前后安排填入可用时间：${fmtWithDay(fitted.start)}，停留 ${fitted.duration} 分钟。${fitted.adjusted.length ? `后续 ${fitted.adjusted.length} 个地点将顺延。` : ''}` : fitted.adjusted.length ? `后续 ${fitted.adjusted.length} 个地点将按游览时长和已知路线时间顺延。` : '保存后更新计划，实际进度保持原样。';
    const carryPreview = document.getElementById('planStopCarryPreview');
    if (carryPreview) {
      carryPreview.hidden = !fitted.destinations?.length;
      carryPreview.innerHTML = (fitted.destinations || []).map(destination => `<section><strong>${escapeHtml(monthDay(destination.date))}</strong><span class="carry-plan-name">${escapeHtml(destination.planName)}</span><p>${destination.existingStops.length ? `原有 ${destination.existingStops.length} 站保留，接续在后面。` : '将自动创建这一天的日计划。'}跨日交通待估。</p>${destination.stops.map(stop => `<div><span>${escapeHtml(stop.place?.name || stop.stopId)}</span><b>${escapeHtml(fmtWithDay(stop.startMinutes))}–${escapeHtml(fmtWithDay(stop.endMinutes))}</b></div>`).join('')}</section>`).join('');
    }
    const saveButton = document.querySelector?.('[data-action="save-plan-stop-time"]');
    if (saveButton) saveButton.disabled = false;
    return result;
  } catch (error) {
    const carryPreview = document.getElementById('planStopCarryPreview');
    if (carryPreview) { carryPreview.hidden = true; carryPreview.innerHTML = ''; }
    if (status) status.textContent = error.message;
    status?.classList?.add('has-error');
    const planTimeRecheckButton = document.getElementById('planStopRecheck');
    if (planTimeRecheckButton && edit.ownerId === state.principal?.principalId) planTimeRecheckButton.hidden = false;
    const saveButton = document.querySelector?.('[data-action="save-plan-stop-time"]');
    if (saveButton) saveButton.disabled = true;
  }
}
export function askRemovePlanStop(planId, stopId) {
  const plan = (state.savedPlans || []).find(item => item.id === planId && item.kind === 'plan');
  const stop = (plan?.stops || []).find(item => item.stopId === stopId);
  if (!plan || !stop) throw new Error('找不到这一天的计划地点，请刷新后重试。');
  openSheet(`<div class="sheet-head"><h3>从计划中移除地点？</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">×</button></div><p>将「${escapeHtml(stop.place?.name || stop.stopId)}」从 ${escapeHtml(monthDay(plan.localDate || ''))} 的计划中移除。旅行进度不会受影响。</p><div class="stop-actions"><button class="btn-danger" data-action="remove-plan-stop" data-plan="${escapeHtml(planId)}" data-stop="${escapeHtml(stopId)}">确认移除</button><button class="btn-ghost" data-action="close-sheet">取消</button></div>`);
}

export async function removePlanStop(planId, stopId) {
  const plan = (state.savedPlans || []).find(item => item.id === planId && item.kind === 'plan');
  if (!plan || !(plan.stops || []).some(stop => stop.stopId === stopId)) throw new Error('这一天的计划已变化，请刷新后重试。');
  const stops = plan.stops.filter(stop => stop.stopId !== stopId);
  const routeLegs = (plan.routeLegs || []).filter(leg => leg.fromStopId !== stopId && leg.toStopId !== stopId);
  const routeIds = new Set(routeLegs.map(leg => leg.legId));
  const plannedCharges = (plan.plannedCharges || []).filter(charge =>
    charge.stopId !== stopId && (!charge.routeLegRef || routeIds.has(charge.routeLegRef)));
  await api(`/api/v1/plans/${encodeURIComponent(planId)}`, { method: 'PUT', body: JSON.stringify({
    name: plan.name, expectedRevision: plan.revision || 0, cityCode: plan.cityCode || cityCodeFromStops(stops) || '000000',
    timezone: plan.timezone || 'Asia/Shanghai', ...(plan.localDate ? { localDate: plan.localDate } : {}),
    snapshot: { stops, routeLegs, plannedCharges },
  }) });
  closeSheet();
  await loadPlans().catch(() => {});
  render();
  toast('地点已从这一天的计划中移除');
}

export function editPlanStopTime(planId, stopId) {
  const plan = (state.savedPlans || []).find(item => item.id === planId);
  const stop = (plan?.kind === 'scheme' ? plan.days?.flatMap(day => day.stops || []) || [] : plan?.stops || []).find(item => item.stopId === stopId);
  if (!plan || !stop) return;
  const savedStart = stopStartMinutes(stop) ?? 9 * 60;
  const end = Number.isFinite(stop.endMinutes) ? stop.endMinutes : savedStart + (stopDurationMinutes(stop) ?? 60);
  const savedDuration = Math.max(15, Math.min(480, end - savedStart));
  const storage = planTimeStorage(planId, stopId);
  const previous = storage.read();
  const restored = validTimeDraft(previous) ? previous : null;
  const start = restored?.startMinutes ?? savedStart;
  const duration = restored?.durationMinutes ?? savedDuration;
  const edit = { planId, stopId, start, duration, storage, carryPlans:structuredClone(state.savedPlans || []), expectedRevision: plan.revision || 0, ownerId: state.principal?.principalId };
  planStopEdit = edit;
  openSheet(`<div class="sheet-head"><h3>调整 · ${escapeHtml(stop.place?.name || stop.stopId)}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
    <p class="stop-meta">已保存：${escapeHtml(fmtWithDay(savedStart))} · 停留 ${escapeHtml(durationLabel(savedDuration))}</p>
    <div class="plan-time-fields"><div class="field"><label for="planStopDayOffset">游览日期</label><select id="planStopDayOffset" data-ui="picker">${Array.from({length:Math.max(2,Math.floor(start / 1440) + 1)},(_,offset)=>`<option value="${offset}" ${offset===Math.floor(start / 1440)?'selected':''}>${offset===0?'计划当天':offset===1?'次日':`第 ${offset+1} 天`}</option>`).join('')}</select></div>
    <div class="field"><label for="planStopStart">游览开始</label><input id="planStopStart" type="time" data-ui="picker" value="${fmt(start)}"></div></div>
    <div class="field"><label for="planStopDurationBtn">停留时长</label><button type="button" id="planStopDurationBtn" class="btn-soft" style="width:100%;text-align:left">${durationLabel(duration)}</button><input type="hidden" id="planStopDuration" value="${duration}"></div>
    <p class="stop-meta">按前后安排和已知路线时间填入可用值；后续未开始地点自动顺延，固定时段和实际进度保留。未知交通仍需估算。</p>
    <p id="planStopDraftStatus" class="stop-meta" role="status">${restored ? restored.expectedRevision === edit.expectedRevision ? '已恢复未保存的时间调整，可继续编辑。' : '计划已有更新；未保存的时间按当前安排重新核对，保存前请查看可用时段。' : ''}</p>
    <p id="planStopEditStatus" role="status"></p>
    <div id="planStopCarryPreview" class="plan-stop-carry-preview" hidden></div>
    <div class="stop-actions plan-stop-time-actions"><button class="btn-primary" data-action="save-plan-stop-time">保存调整</button><button class="btn-ghost" id="planStopDiscardDraft" aria-label="放弃本次未保存调整，恢复已保存时间">恢复原值</button><button class="btn-soft" id="planStopRecheck" hidden>核对最新安排</button></div>`);
  edit.marker = document.getElementById('planStopEditStatus');
  const changed = () => { fillPlanStopTime(); rememberPlanStopTime(edit); };
  const durationBtn = document.getElementById('planStopDurationBtn');
  const durationInput = document.getElementById('planStopDuration');
  durationBtn?.addEventListener('click', () => {
    const current = parseInt(durationInput?.value, 10) || 60;
    openDurationPickerPanel(durationBtn, current, (minutes) => {
      durationInput.value = String(minutes);
      durationBtn.textContent = durationLabel(minutes);
      changed();
    });
  });
  document.getElementById('planStopStart')?.addEventListener?.('change', changed);
  document.getElementById('planStopDayOffset')?.addEventListener?.('change', changed);
  document.getElementById('planStopDiscardDraft')?.addEventListener?.('click', () => {
    if (planStopEdit !== edit || edit.saving || edit.ownerId !== state.principal?.principalId) return;
    edit.storage.clearIf(edit.storage.read());
    editPlanStopTime(planId, stopId);
  });
  document.getElementById('planStopRecheck')?.addEventListener?.('click', async event => {
    if (planStopEdit !== edit || edit.saving || edit.ownerId !== state.principal?.principalId) return;
    rememberPlanStopTime(edit);
    const button = event.currentTarget;
    button.disabled = true;
    edit.marker.textContent = '正在核对最新安排，未保存的时间仍保留……';
    edit.marker.classList?.remove('has-error');
    try {
      await loadPlans();
      if (planStopEdit !== edit || edit.ownerId !== state.principal?.principalId || document.getElementById('planStopEditStatus') !== edit.marker) return;
      const latest = state.savedPlans.find(plan => plan.id === planId);
      const latestStops = latest?.kind === 'scheme' ? latest.days?.flatMap(day => day.stops || []) : latest?.stops;
      if (!latestStops?.some(stop => stop.stopId === stopId)) throw new Error('这个地点已从计划中移除，时间调整仍暂存；请先核对计划。');
      editPlanStopTime(planId, stopId);
    } catch (error) {
      if (document.getElementById('planStopEditStatus') === edit.marker) {
        edit.marker.textContent = error.message === 'Failed to fetch' ? '无法核对，请检查连接后重试；时间调整仍保留。' : error.message;
        edit.marker.classList?.add('has-error');
      }
    } finally { button.disabled = false; }
  });
  fillPlanStopTime();
}

const parseTimeInput = (value) => {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!matched) throw new Error('请填写有效的时间。');
  return Number(matched[1]) * 60 + Number(matched[2]);
};

export async function savePlanStopTime() {
  if (!planStopEdit || planStopEdit.saving) return;
  const edit = planStopEdit;
  const status = document.getElementById('planStopEditStatus');
  if (status !== edit.marker || edit.ownerId !== state.principal?.principalId) return;
  const controls = [...(document.querySelectorAll?.('#planStopStart, #planStopDayOffset, #planStopDurationBtn, #planStopDiscardDraft, #planStopRecheck, [data-action="save-plan-stop-time"]') || [])];
  try {
    const result = fillPlanStopTime();
    if (!result) return;
    const { plan, day, fitted: adjustedStops } = result;
    const updatedPlan = plan.kind === 'scheme'
      ? { ...plan, days: (plan.days || []).map(item => item === day ? { ...item, stops: adjustedStops.stops } : item) }
      : { ...plan, stops: adjustedStops.stops, routeLegs:adjustedStops.routeLegs ?? plan.routeLegs,
        plannedCharges:adjustedStops.plannedCharges ?? plan.plannedCharges };
    const body = updatedPlan.kind === 'scheme'
      ? { name: updatedPlan.name, cityCode: updatedPlan.cityCode, ...(updatedPlan.localDate ? { localDate: updatedPlan.localDate } : {}), days: updatedPlan.days }
      : { name: updatedPlan.name, cityCode: updatedPlan.cityCode, ...(updatedPlan.localDate ? { localDate: updatedPlan.localDate } : {}), snapshot: { stops: updatedPlan.stops, routeLegs: updatedPlan.routeLegs, plannedCharges: updatedPlan.plannedCharges || [] } };
    body.expectedRevision = edit.expectedRevision;
    if (adjustedStops.expectedCarryTargets?.length) body.expectedCarryTargets = adjustedStops.expectedCarryTargets;
    const captured = rememberPlanStopTime(edit);
    edit.saving = true;
    controls.forEach(control => { control.disabled = true; });
    if (status) status.textContent = '正在保存……';
    const saved = await api(`/api/v1/plans/${encodeURIComponent(edit.planId)}`, { method: 'PUT', body: JSON.stringify(body) });
    if (captured) edit.storage.clearIf(captured);
    if (edit.ownerId !== state.principal?.principalId) return;
    if (planStopEdit === edit) {
      planStopEdit = null;
      if (document.getElementById('planStopEditStatus') === edit.marker) {
        const movedTo = adjustedStops.destinations?.find(destination => destination.stops.some(stop => stop.stopId === edit.stopId));
        if (movedTo && state.currentView === 'today') state.planViewDate = movedTo.date;
        closeSheet();
      }
    }
    await loadPlans().catch(() => {});
    if (edit.ownerId !== state.principal?.principalId || state.accountContextChanged) return;
    if (planStopEdit?.planId === edit.planId && document.getElementById('planStopEditStatus') === planStopEdit.marker) fillPlanStopTime();
    render();
    toast(adjustedStops.adjusted.length
      ? `时间已调整，${adjustedStops.adjusted.length} 个地点已顺延：${saved.name ?? ''}`
      : `时间已调整：${saved.name ?? ''}`);
  } catch (error) {
    const message = error.message === 'Failed to fetch' ? '保存失败，请检查连接后重试；时间调整仍保留。' : error.message;
    if (edit.ownerId !== state.principal?.principalId || state.accountContextChanged) return;
    if (planStopEdit === edit && document.getElementById('planStopEditStatus') === edit.marker) {
      status.textContent = message;
      status.classList?.add('has-error');
      const planTimeRecheckButton = document.getElementById('planStopRecheck');
      if (planTimeRecheckButton) planTimeRecheckButton.hidden = false;
    }
    else toast(`时间调整尚未保存，可重新打开继续。${message}`, 'error');
  } finally {
    edit.saving = false;
    controls.forEach(control => { control.disabled = false; });
  }
}

let nearestPlanSessionPromise = null;

/** 加载日期计划；旅行容器是可选的，不需要创建旅行才能查看或记录当天进度。 */
export async function ensureNearestPlanSession() {
  if (nearestPlanSessionPromise) return nearestPlanSessionPromise;
  nearestPlanSessionPromise = (async () => {
    await loadPlans();
    if (usesSavedDayPlans()) {
      const today = activePlanDate();
        if (!state.planViewDate || !canViewPlanDate(state.planViewDate, state.savedPlans)) {
          state.planViewDate = companionTarget(state.savedPlans).plan?.localDate || today;
        }
      state.pendingMountedDate = '';
      return;
    }
    while (state.currentView === 'today' && state.pendingMountedDate) {
      const requestedDate = state.pendingMountedDate;
      if (requestedDate !== activePlanDate()) {
        state.pendingMountedDate = '';
        break;
      }
      if ((state.mountedDate || state.trip.trip.localDate) === requestedDate) {
        state.pendingMountedDate = '';
        continue;
      }
      try {
        await mountPlanForDate(requestedDate);
      } catch (error) {
        if (state.pendingMountedDate === requestedDate) state.pendingMountedDate = '';
        toast(error.message, 'error');
        break;
      }
      if (state.pendingMountedDate === requestedDate) state.pendingMountedDate = '';
    }
  })();
  try {
    return await nearestPlanSessionPromise;
  } finally {
    nearestPlanSessionPromise = null;
  }
}

/** 把今天的方案站点挂载为当前执行计划。 */
let planDateMountQueue = Promise.resolve();
export function mountPlanForDate(date) {
  const targetTripId = tripId();
  const request = planDateMountQueue.catch(() => {}).then(() => mountPlanForDateNow(date, targetTripId));
  planDateMountQueue = request.catch(() => {});
  return request;
}

async function mountPlanForDateNow(date, targetTripId) {
  if (!state.trip || !targetTripId || tripId() !== targetTripId) return;
  // 「计划与进度」会先渲染、再异步加载方案列表；切换日期时重新加载，避免把尚未加载的今天方案误判为空日并清掉待进行站点。
  await loadPlans();
  if (!state.trip || tripId() !== targetTripId) return;
  const datedPlans = (state.savedPlans || []).filter(item => item.kind === 'plan' && item.localDate === date);
  if (datedPlans.length > 1) {
    const names = datedPlans.map(item => `「${item.name}」`).join('、');
    throw new Error(`${date} 有多份日计划：${names}。请先在「计划与进度」中处理重复项，再切换这一天。`);
  }
  const plan = datedPlans[0];
  // 已发生的进度事实（完成/进行中/跳过）跨日期保留，不被切换抹掉；各站点日期保持原日。
  const prevMounted = state.mountedDate || state.trip?.trip?.localDate || date;
  const facts = (state.trip.snapshot.stops || []).filter(stop => stop.status !== 'planned')
    .map(stop => ({ ...stop, date: stop.date ?? prevMounted }));
  // 同一站点不能同时以「已完成事实」和「待进行」两条存在：事实优先，方案里的同 ID 条目剔除，
  // 否则界面按待进行渲染执行按钮、服务端按已完成校验，每次执行都会报「当前进展不能记录该动作」。
  const factIds = new Set(facts.map(stop => stop.stopId));
  if (!plan) {
    // 该日期没有方案：挂载为空日——只保留进度事实，待进行站点不跟着日期跑。
    await api(`/api/v1/trips/${targetTripId}/plan-edits`, { method: 'POST', body: JSON.stringify({
      expectedRevision: tripRevision(), allowPast: true, stops: facts, routeLegs: [], plannedCharges: [],
    }) });
    if (tripId() !== targetTripId) return;
    state.mountedDate = date;
    await loadTrip(targetTripId);
    render();
    return;
  }
  // 同一站点不能同时以「已完成事实」和「待进行」两条存在：事实优先，方案里的同 ID 条目剔除，
  // 否则界面按待进行渲染执行按钮、服务端按已完成校验，每次执行都会报「当前进展不能记录该动作」。
  const content = executionPlanContent(plan);
  const dedupedPlanStops = content.stops.filter(stop => !factIds.has(stop.stopId));
  await api(`/api/v1/trips/${targetTripId}/plan-edits`, { method: 'POST', body: JSON.stringify({
    expectedRevision: tripRevision(), allowPast: true,
    stops: [...facts, ...dedupedPlanStops.map(stop => ({ ...stop, date: stop.date ?? date }))],
    routeLegs: content.routeLegs,
    plannedCharges: content.plannedCharges,
  }) });
  if (tripId() !== targetTripId) return;
  state.mountedDate = date;
  await loadTrip(targetTripId);
  render();
}
