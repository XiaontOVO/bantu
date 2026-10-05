import { itineraryTimeLabel } from './itinerary-timing.js';
import { newClientId } from './client-id.js';
import { beginChatComposerSubmission, restoreChatComposerSubmission } from './chat-composer.js';
import { favoriteButton } from './favorite-state.js';
import { findPlace } from './favorites.js';
import { tagChips } from './place-tags.js';
/**
 * 业务动作与面板。
 *
 * 每个函数对应一个用户在界面上能做的决定（采用候选、记一笔、执行进度……），
 * 内部按"调接口 → 更新 state → 重绘 → 给一句反馈"的顺序收尾。
 * 事件绑定不在这里：动作表见 lib/actions.js。
 */
import { LIFECYCLE_LABEL, PLANNING_LABEL, categoryLabel, cityName, clockText, dateKeyInTimeZone, escapeHtml, facilityList, fmt, formatTimeRange, monthDay, placeIdHtml } from './format.js';
import { $, state, tripId, tripRevision, usesSavedDayPlans } from './store.js';
import { currentTripClock } from './trip-clock.js';
import { stopTransportMode } from './stop-transport.js';
import { api } from './api.js';
import { closeSheet, openSheet, toast } from './ui.js';
import { navigate, render } from './render.js';
import { loadMemories, loadAllMemories, loadCommunity, loadGeneralMessages, loadMessages, loadTrip, loadPlaces } from './loaders.js';
import { syncAgentViews } from './agent-view-sync.js';
import { loadPlans, addPlaceToDayDraft } from './plan-library.js';
import { placeAddTargetDate } from './plan-draft-target.js';
import { carryPlaceTarget } from './plan-carry-target.js';
import { loadFavorites } from './favorites.js';
import { hasOvernightActiveStop } from './plan-execution-window.js';
import { requestPlanRoute, routeTravelMinutes } from './plan-route-timing.js';
import { focusPlanVisit, repeatedPlanVisits, repeatVisitNotice } from './plan-repeat-visit.js';
import { companionRequestForText } from './companion-advice.js';
import { departureReview } from './departure-review.js';
import { requestCurrentLocation, isFreshCurrentLocation } from './location.js';
import { currentAgentViewContext, applyAgentUiActions } from './agent-view-context.js';

  export async function patchPlanStops(stops, routeLegs, allowPast = true) {
    const target = tripId();
    const revision = tripRevision();
    const nextRoutes = routeLegs ?? (state.trip.snapshot.routeLegs || []).filter((leg) => stops.some((stop) => stop.stopId === leg.fromStopId) && stops.some((stop) => stop.stopId === leg.toStopId));
    await api(`/api/v1/trips/${target}/plan-edits`, { method: 'POST', body: JSON.stringify({ expectedRevision: revision, stops, routeLegs: nextRoutes, allowPast }) });
    if (tripId() !== target) return;
    state.lastMutation = null;
    await loadTrip(target);
  }

  export async function addPlaceToPlan(placeId) {
    const place = findPlace(placeId);
    if (!place) { toast('地点不存在', 'error'); return; }
    // A plan can always be edited without an active legacy Trip. Keep the
    // fallback explicit so a stale caller cannot route a no-trip action into
    // the old snapshot branch.
    const standalone = usesSavedDayPlans() || !state.trip;
      const mountDate = !standalone ? (state.mountedDate || state.trip.trip.localDate) : '';
      const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
      const selectedDate = standalone ? placeAddTargetDate() : (state.planViewDate || mountDate || today);
      if (standalone && addPlaceToDayDraft(placeId, selectedDate)) return;
      // A late read belongs to the page and draft that initiated it. Returning
      // to the same detail after leaving it is a new navigation, too.
      const context = { owner: state.principal?.principalId, view: state.currentView,
        navigation: state.navigationRevision, detail: state.placeDetailId,
        draft: state.planDraft, preview: state.planEdit };
      const isCurrent = () => context.owner === state.principal?.principalId &&
        context.view === state.currentView && context.navigation === state.navigationRevision &&
        (context.view !== 'place' || context.detail === state.placeDetailId) &&
        context.draft === state.planDraft && context.preview === state.planEdit &&
        (!standalone || selectedDate === placeAddTargetDate());
      if (standalone) {
        try { await loadPlans(); }
        catch (error) { if (isCurrent()) throw error; return; }
        if (!isCurrent()) return;
      }
    if (standalone || selectedDate !== mountDate) {
      if (!selectedDate) { toast('先选择日期，再加入计划。'); return; }
        return addPlaceToDatedPlan(placeId, selectedDate, place, isCurrent);
    }
    // 按日期隔离：新地点只加入当前挂载的那一天，其它日期的站点与进度不受影响。
    const stops = [...(state.trip.snapshot.stops || [])];
    const routeLegs = [...(state.trip.snapshot.routeLegs || [])];
    const dayStops = stops.filter(stop => (stop.date ?? mountDate) === mountDate && stop.status !== 'skipped');
    const last = dayStops.at(-1);
    const targetTrip = tripId(), revision = tripRevision();
    let incoming = null;
    if (last?.place?.coordinates && place.coordinates && !(transportMode === 'transit' && state.mapConfig && !state.mapConfig.routeModes?.includes('transit'))) {
      const result = await api('/api/v1/routes', { method: 'POST', body: JSON.stringify({origin: last.place, destination: place, transportMode: state.routeMode || 'walking', cityCode: state.trip.trip.cityCode}) });
      incoming = result.leg;
    }
      if (!isCurrent()) return;
      if (tripId() !== targetTrip || tripRevision() !== revision) throw new Error('旅行计划已变化，请重新加入地点。');
    const clock = currentTripClock();
    const isToday = mountDate === clock?.date;
    const duration = Math.max(15, Number(place.suggestedDurationMinutes) || 60);
    const travelMinutes = incoming ? Math.ceil(incoming.durationMinutes ?? incoming.durationSeconds / 60) + (incoming.bufferMinutes || 0) : 30;
    if (!Number.isFinite(travelMinutes) || travelMinutes < 0) throw new Error('暂时无法确认交通时间，请稍后重新规划。');
    let start = Math.max(last ? (last.departureMinutes ?? last.endMinutes) + travelMinutes : 12 * 60, isToday ? clock.minutes + 10 + (last ? travelMinutes : 0) : 0);
    let openingNotice = '';
    if (place.openingIntervals?.length) {
      const sorted = [...place.openingIntervals].sort((a,b) => a.startMinutes - b.startMinutes);
      const withinDay = sorted.find(slot => Math.max(start, slot.startMinutes) + duration <= slot.endMinutes);
      if (withinDay) {
        start = Math.max(start, withinDay.startMinutes);
      } else if (start < sorted[0].startMinutes) {
        start = sorted[0].startMinutes;
      } else {
        start = 24 * 60 + sorted[0].startMinutes;
        openingNotice = '今天已来不及，已顺延到次日首段开放时段，请行前核实。';
      }
    }
    const stopId = `place_${Date.now().toString(36)}`;
    stops.push({
      stopId,
      placeId: place.placeId,
      place: {
        placeId: place.placeId,
        name: place.name,
        coordinates: place.coordinates || null,
        facilityCodes: place.facilityCodes || [],
        evidenceIds: place.evidenceIds || [],
      },
      plannedArrivalMinutes: start,
      startMinutes: start,
      endMinutes: start + duration,
      departureMinutes: start + duration,
      minDurationMinutes: duration,
      plannedDurationMinutes: duration,
      status: 'planned',
      date: mountDate,
    });
    if (incoming) routeLegs.push({...incoming, legId: `route_to_${stopId}`, fromStopId: last.stopId, toStopId: stopId});
    previewPlanEdit(stops, `加入「${place.name}」：${formatTimeRange(start, start + duration)}。${incoming ? `已计入约 ${travelMinutes} 分钟交通与缓冲；${incoming.departureSupport === 'demo' || place.coordinates?.source === 'demo' ? '使用样例估算，请核对实际道路。' : '请核对交通情况。'}` : '交通时间暂按 30 分钟预留，请核对实际道路。'}${openingNotice ? ` ${openingNotice}` : ''}`, routeLegs);
  }

  async function addPlaceToDatedPlan(placeId, targetDate, place, isCurrent) {
    const owner = state.principal?.principalId;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('请选择有效的计划日期。');
    const dayPlans = (state.savedPlans || []).filter(plan => plan.kind === 'plan' && plan.localDate === targetDate);
    if (dayPlans.length > 1) throw new Error('这一天有多份日计划，请先处理重复项再添加地点。');
    const plan = dayPlans[0];
    const timezone = plan?.timezone || state.trip?.snapshot?.timezone || state.trip?.trip?.timezone || 'Asia/Shanghai';
    const tripDate = state.trip ? (state.mountedDate || state.trip.trip.localDate) : '';
    const tripStops = state.trip?.snapshot?.stops || [];
    const sourceStops = plan?.stops || tripStops.filter(stop => (stop.date ?? tripDate) === targetDate);
    const stops = sourceStops.filter(stop => stop.status !== 'skipped').map(stop => ({ ...stop, date: targetDate }));
    const stopIds = new Set(stops.map(stop => stop.stopId));
    const sourceRouteLegs = plan?.routeLegs || (state.trip?.snapshot?.routeLegs || []).filter(leg =>
      stopIds.has(leg.toStopId) && (['origin', 'my-location'].includes(leg.fromStopId) || stopIds.has(leg.fromStopId)),
    );
    const routeLegs = sourceRouteLegs.filter(leg =>
      stopIds.has(leg.toStopId) && (['origin', 'my-location'].includes(leg.fromStopId) || stopIds.has(leg.fromStopId)),
    );
    // 基准站必须取「离开最晚」的一站，而不是「开始最晚」的一站：长停留站点
    // 开始早、结束晚，按开始时间选会低估新站点的起始时间，造成时间段重叠。
    const departOf = (stop) => [stop.departureMinutes, stop.plannedDepartureMinutes, stop.endMinutes, stop.startMinutes, stop.plannedStartMinutes].find(Number.isFinite) ?? 0;
    const last = [...stops].sort((a, b) => departOf(a) - departOf(b)).at(-1);
    let incoming = null;
    let routeNotice = '';
    const cityCode = plan?.cityCode || state.trip?.trip?.cityCode || place.cityCode || '000000';
    const lastIncomingMode = routeLegs.find(leg => leg.toStopId === last?.stopId)?.transportMode;
    const transportMode = state.routeModeSelected ? state.routeMode : lastIncomingMode || 'walking';
    const transportLabel = ({ walking: '步行', transit: '公共交通', driving: '驾车' })[transportMode] || '交通';
    if (last) {
      try { incoming = await requestPlanRoute(api, last, { stopId: 'new-stop', place }, transportMode); }
      catch (error) {
        routeNotice = /Failed to fetch|NetworkError|Load failed/i.test(error?.message || '')
          ? '路线服务连接失败，交通时间保持待估。' : error.message || '路线服务暂时不可用。';
      }
    }
    if (!isCurrent()) return;
    if (owner !== state.principal?.principalId) return;
    if (state.planViewDate && state.planViewDate !== targetDate) throw new Error('计划日期已切换，请重新选择地点。');
    if (plan && !(state.savedPlans || []).some(item => item.id === plan.id && item.localDate === targetDate && (item.revision || 0) === (plan.revision || 0))) {
      throw new Error('这一天的计划已变化，请刷新后重新添加。');
    }
    const duration = Math.max(15, Number(place.suggestedDurationMinutes) || 60);
    let travelMinutes = routeTravelMinutes(incoming);
    const clock = currentTripClock();
    const today = clock?.date || dateKeyInTimeZone(new Date(), timezone);
    const nowParts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number);
    const earliestTodayStart = targetDate === today ? nowParts[0] * 60 + nowParts[1] + 10 : 0;
    const lastDeparture = last && [last.departureMinutes, last.plannedDepartureMinutes, last.endMinutes].find(Number.isFinite);
    let start = Math.max(lastDeparture !== undefined ? lastDeparture + (travelMinutes ?? 0) : 12 * 60, earliestTodayStart);
    let openingNotice = '';
    if (place.openingIntervals?.length) {
      const sorted = [...place.openingIntervals].sort((a, b) => a.startMinutes - b.startMinutes);
      const withinDay = sorted.find(slot => Math.max(start, slot.startMinutes) + duration <= slot.endMinutes);
      if (withinDay) {
        start = Math.max(start, withinDay.startMinutes);
      } else if (start < sorted[0].startMinutes) {
        // 早于首个开放时段：提前到当段开始。
        start = sorted[0].startMinutes;
      } else {
        // 当日开放时段已排不下：按 ≥1440 分钟标记归属次日，确认后由服务端（T7）
        // 迁入次日的日计划，当天计划不会保留「次日起始」的站点。
        start = 24 * 60 + sorted[0].startMinutes;
        openingNotice = targetDate === today
          ? '当前安排排不下今天的开放时段，确认后将加入次日计划，请核对道路与开放情况。'
          : '当前安排排不下当天的开放时段，确认后将加入次日计划，请核对道路与开放情况。';
      }
    }
    const carryTarget = start>=1440 ? carryPlaceTarget({baseDate:targetDate,start,duration,intervals:place.openingIntervals,plans:state.savedPlans}) : null;
    if (carryTarget) {
      start = carryTarget.start;
      incoming = null; travelMinutes = null;
      openingNotice = `当天已排不下，将加入 ${monthDay(carryTarget.date)} 的计划，接续已有安排；原日期的地点和进度保留。`;
    }
    const stopId = `place_${newClientId()}`;
    const stop = {
      stopId, placeId: place.placeId,
      place: {
        placeId: place.placeId, name: place.name, coordinates: place.coordinates || null,
        cityCode: place.cityCode, facilityCodes: place.facilityCodes || [], evidenceIds: place.evidenceIds || [],
      },
      plannedArrivalMinutes: start, startMinutes: start, endMinutes: start + duration,
      departureMinutes: start + duration, minDurationMinutes: duration, plannedDurationMinutes: duration,
      status: 'planned', date: targetDate,
    };
    const baseDay = Date.parse(`${targetDate}T00:00:00Z`);
    const targetDay = Math.floor(start / 1440);
    const repeatDays = [{ dayIndex: 0, planId: plan?.id, stops: sourceStops }, ...(state.savedPlans || [])
      .filter(item => item.kind === 'plan' && item.id !== plan?.id && item.localDate)
      .map(item => ({ dayIndex: (Date.parse(`${item.localDate}T00:00:00Z`) - baseDay) / 86400000, planId: item.id, stops: item.stops }))];
    const matches = repeatedPlanVisits(repeatDays, place.placeId, targetDay);
    const repeatDate = new Date(baseDay + targetDay * 86400000).toISOString().slice(0, 10);
    const repeatVisit = matches.length ? { place, matches, date: repeatDate, dayLabel: monthDay(repeatDate) } : null;
    stops.push(stop);
    if (incoming && last) routeLegs.push({ ...incoming, legId: `route_to_${stopId}`, fromStopId: last.stopId, toStopId: stopId });
    const plannedCharges = plan?.plannedCharges || [];
    const dayName = plan?.name || `${targetDate} 日计划`;
    const previewSnapshot = { stops, routeLegs, plannedCharges, timezone };
    previewPlanEdit(
      stops,
      `加入「${place.name}」：${formatTimeRange(start, start + duration)}。${incoming ? `已按${transportLabel}道路路线预留约 ${travelMinutes} 分钟；这是当前道路估算，未来路况可能变化。` : last ? `交通时间待估，只接续游览时段，不表示一定赶得上。${routeNotice}` : '首站交通时间待估，出发时按当前位置计算。'}${openingNotice ? ` ${openingNotice}` : ''}`,
      routeLegs,
      { scope: 'saved-day-plan', planId: plan?.id || '', expectedRevision: plan?.revision || 0, date: targetDate, name: dayName, cityCode, timezone, plannedCharges, snapshot: previewSnapshot, repeatVisit, carryTarget },
    );
  }

  export function previewPlanEdit(stops, summary, routeLegs, savedDayPlan = null) {
    if ($('toast')) $('toast').className = 'toast';
    state.planEdit = savedDayPlan
      ? { ...savedDayPlan, ownerId: state.principal?.principalId, stops, routeLegs }
      : { tripId: tripId(), revision: tripRevision(), stops, routeLegs };
    const snapshot = savedDayPlan?.snapshot || state.trip?.snapshot || { stops: [], routeLegs: [] };
    const repeatVisit = savedDayPlan?.repeatVisit;
    const carry = savedDayPlan?.carryTarget;
    const added = stops.at(-1);
    const previewStops = carry ? [...(carry.plan?.stops || []).filter(stop=>stop.status!=='skipped'),
      {...added,startMinutes:added.startMinutes-carry.dayOffset*1440,endMinutes:added.endMinutes-carry.dayOffset*1440}] : stops;
    const list = carry ? `<section class="plan-carry-preview"><h4>${escapeHtml(monthDay(carry.date))} · 接续后的安排</h4>${previewStops.map((stop,index)=>`<p>${index===previewStops.length-1?'<strong>新增</strong> ':''}${escapeHtml(stop.place?.name||stop.stopId)} · ${escapeHtml(formatTimeRange(stop.startMinutes,stop.endMinutes))}</p>`).join('')}</section>`
      : stops.map(stop => `<p>${escapeHtml(stop.place?.name || stop.stopId)} · ${itineraryTimeLabel(stop, {...snapshot, stops, routeLegs:routeLegs ?? snapshot.routeLegs})}</p>`).join('');
    openSheet(`<div class="sheet-head"><h3>确认加入计划</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>${repeatVisit ? repeatVisitNotice(repeatVisit) : ''}<p>${escapeHtml(summary)}</p><p class="stop-meta">${carry ? '确认后加入上述日期，原日期安排和已发生的进度保留；不写入到访事实。' : savedDayPlan ? '确认后只更新所选日期的计划，不写入当天进度。' : '完整保留已发生的进度；确认后保存新快照。'}</p>${list}<p id="planAddStatus" class="planner-save-error" role="alert" tabindex="-1" hidden></p><div class="plan-repeat-actions">${repeatVisit ? '<button class="btn-soft" data-action="view-repeated-plan-place">查看已有安排</button>' : ''}<button class="btn-primary" data-action="confirm-plan-edit">${repeatVisit ? '确认再次加入' : '确认加入'}</button></div>`);
  }

  export function viewRepeatedPlanPlace() {
    const draft = state.planEdit;
    if (!draft?.repeatVisit) return;
    if (draft.ownerId !== state.principal?.principalId) throw new Error('账号已切换，请重新打开计划。');
    const { date, matches } = draft.repeatVisit;
    state.planEdit = null;
    closeSheet();
    state.planViewDate = date;
    navigate('today');
    const owner = state.principal?.principalId;
    requestAnimationFrame(() => {
      if (state.currentView === 'today' && state.planViewDate === date && state.principal?.principalId === owner) focusPlanVisit(matches[0].stop.stopId);
    });
  }

  export async function confirmPlanEdit() {
    const draft = state.planEdit;
    if (draft?.saving) return;
    if (!draft) throw new Error('计划已变化，请重新预览修改。');
    if (draft.scope === 'saved-day-plan') {
      if (draft.ownerId !== state.principal?.principalId) throw new Error('账号已切换，请重新预览修改。');
      const button = document.querySelector('[data-action="confirm-plan-edit"]');
      draft.saving = true;
      if (button) { button.disabled = true; button.textContent = '正在保存…'; }
      try {
        // 方案列表是分页接口；写入前必须读取完整列表，否则超过第一页的
        // 日计划可能被误判为不存在，产生重复日期或覆盖错误。
        const latestPlans = await loadPlans();
        if (state.planEdit !== draft || draft.ownerId !== state.principal?.principalId) throw new Error('预览已变化，请重新打开后再添加。');
        const latest = draft.planId ? latestPlans.find(plan => plan.id === draft.planId && plan.kind === 'plan') : null;
        if (draft.planId && (!latest || latest.localDate !== draft.date)) throw new Error('这一天的计划已变化，请重新打开后再添加。');
        if (latest && (latest.revision || 0) !== draft.expectedRevision) throw new Error('这一天的计划已有更新，请重新预览后再添加；本次草稿尚未保存。');
        if (!draft.planId && latestPlans.some(plan => plan.kind === 'plan' && plan.localDate === draft.date)) {
          throw new Error('这一天已生成日计划，请重新打开日期后再添加。');
        }
        const carry = draft.carryTarget;
        if (carry) {
          const targets = latestPlans.filter(plan=>plan.kind==='plan'&&plan.localDate===carry.date);
          if (targets.length>1 || (targets[0]?.id||null)!==carry.expected.planId || (targets[0]?(targets[0].revision||0):null)!==carry.expected.expectedRevision) {
            throw new Error('接续日期的计划已有变化，请重新预览后再添加；本次地点尚未保存。');
          }
        }
        const existingNames = new Set(latestPlans.map(plan => plan.name));
        let name = latest?.name || draft.name;
        if (!latest) {
          for (let suffix = 2; existingNames.has(name); suffix += 1) name = `${draft.name} ${suffix}`;
        }
        const body = {
          name, cityCode: draft.cityCode || latest?.cityCode || '000000', timezone: draft.timezone || latest?.timezone || 'Asia/Shanghai',
          localDate: draft.date,
          ...(latest ? { expectedRevision: draft.expectedRevision } : {}),
          ...(carry ? {expectedCarryTargets:[carry.expected]} : {}),
          snapshot: { stops: draft.stops, routeLegs: draft.routeLegs || [], plannedCharges: draft.plannedCharges || latest?.plannedCharges || [] },
        };
        // 起始 ≥ 24:00 的站点会被服务端（T7）迁入次日计划；保存后把视图带到次日。
        const carriedToNextDay = (draft.stops || []).some(stop => Number(stop.startMinutes) >= 1440);
        if (latest) await api(`/api/v1/plans/${encodeURIComponent(latest.id)}`, { method: 'PUT', body: JSON.stringify(body) });
        else await api('/api/v1/plans', { method: 'POST', body: JSON.stringify({ ...body, kind: 'plan', source: 'current' }) });
        if (state.planEdit !== draft) return;
        state.planEdit = null;
        // The write above is already committed. A transient list refresh must
        // not turn a successful add into a retryable error (which could add
        // the same stop twice when the user clicks again).
        await loadPlans().catch(() => {});
        state.planViewDate = carriedToNextDay
          ? carry?.date || new Date(Date.parse(`${draft.date}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10)
          : draft.date;
        if (button?.isConnected) { closeSheet(); navigate('today'); }
        toast(carriedToNextDay ? `地点已加入 ${monthDay(state.planViewDate)} 的计划` : '地点已加入这一天的计划');
      } catch (error) {
        const message = /Failed to fetch|NetworkError|Load failed/i.test(error?.message || '')
          ? '保存失败，请检查网络后重试。本次地点尚未保存。' : error.message;
        const status = state.planEdit===draft && document.getElementById('planAddStatus');
        if (status) { status.textContent=message;status.hidden=false;status.scrollIntoView?.({block:'nearest'});status.focus?.({preventScroll:true}); }
        throw new Error(message);
      } finally {
        draft.saving = false;
        if (button) { button.disabled = false; button.textContent = draft.repeatVisit ? '确认再次加入' : '确认加入'; }
      }
      return;
    }
    if (draft.tripId !== tripId() || draft.revision !== tripRevision()) throw new Error('行程已有更新，请重新预览修改。');
    const button = document.querySelector('[data-action="confirm-plan-edit"]');
    draft.saving = true;
    if (button) { button.disabled = true; button.textContent = '正在保存……'; }
    try {
      await patchPlanStops(draft.stops, draft.routeLegs);
      if (state.planEdit !== draft || tripId() !== draft.tripId) return;
      state.planEdit = null;
      if (button?.isConnected) { closeSheet(); navigate('today'); }
      toast('调整已确认，新快照已保存');
    } finally {
      draft.saving = false;
      if (button) { button.disabled = false; button.textContent = '确认保存'; }
    }
  }

  export async function generateInitialPlan() {
      const data = await api(`/api/v1/trips/${tripId()}/initial-plans`, { method: 'POST', body: JSON.stringify({ baseRevision: tripRevision() }) });
      state.proposal = data.proposal;
      state.actionRequests = data.actionRequests || [];
      navigate('plan');
      toast('初始方案已生成，请对比后采用');
    }

    export async function applyCandidate(proposalId, candidateId, actionRequestId) {
      if (state.candidateMutationPending) return;
      const sourceView = state.currentView;
      if (sourceView === 'agent') {
        if (state.chatPending) return;
        const index = state.proposal?.proposalId === proposalId ? state.proposal.candidates.findIndex(item => item.candidateId === candidateId) : -1;
        if (index < 0) throw new Error('方案已变化，请查看最新的待确认行动。');
        await sendChat(`确认应用方案${index + 1}`);
        return;
      }
      if (state.candidateMutationPending || state.chatPending) return;
      const target = tripId(), revision = tripRevision();
      if (state.proposal?.proposalId !== proposalId || !state.proposal.candidates.some(candidate => candidate.candidateId === candidateId)) throw new Error('候选已变化，请重新查看方案。');
      const key = `${target}:${proposalId}:${candidateId}:${actionRequestId}:${revision}`;
      let attempt = state.candidateApplyAttempt;
      if (attempt?.key !== key) {
        attempt = {key, idempotencyKey: `apply-${newClientId()}`, grantId:null};
        state.candidateApplyAttempt = attempt;
      }
      state.candidateMutationPending = true; render();
      try {
        if (!attempt.grantId) {
          const decided = await api(`/api/v1/trips/${target}/action-requests/${actionRequestId}/decisions`, { method:'POST', body:JSON.stringify({decision:'approve'}) });
          attempt.grantId = decided.grant?.grantId;
        }
        if (tripId() !== target || tripRevision() !== revision || state.proposal?.proposalId !== proposalId) return;
        const applied = await api(`/api/v1/trips/${target}/proposals/${proposalId}/apply`, {
          method:'POST', headers:{'idempotency-key':attempt.idempotencyKey},
          body:JSON.stringify({candidateId,expectedRevision:revision,actionRequestId,grantId:attempt.grantId}),
        });
        if (tripId() !== target) return;
        state.lastMutation = applied.mutationId;
        state.proposal = null; state.actionRequests = [];
        state.candidateApplyAttempt = null;
        await loadTrip(target);
        if (tripId() === target && state.currentView === sourceView) navigate('today');
        toast('已采用，行程已更新');
      } finally { state.candidateMutationPending = false; render(); }
    }

    export async function rejectProposal() {
      if (state.candidateMutationPending || state.chatPending || !state.proposal) return;
      const target = tripId(), proposalId = state.proposal.proposalId;
      state.candidateMutationPending = true; render();
      try {
        await api(`/api/v1/trips/${target}/proposals/${proposalId}/reject`, {method:'POST'});
        if (tripId() !== target || state.proposal?.proposalId !== proposalId) return;
        state.proposal = null; state.actionRequests = []; state.candidateApplyAttempt = null;
        if (state.currentView === 'agent') state.messages.push({role:'assistant',text:'已放弃这次行动，当前行程未修改。可以继续告诉我你的需求。'});
        toast('已放弃候选');
      } finally { state.candidateMutationPending = false; render(); }
    }

    export async function resumeAgentTask(taskId) {
      if (state.chatPending) return;
      const owner = state.principal?.principalId, conversationId = state.agentConversationId || '';
      const task = await api('/api/v1/agent/task' + (conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''));
      if (owner !== state.principal?.principalId || conversationId !== (state.agentConversationId || '') || state.chatPending) return;
      if (!task || task.id !== taskId || task.status !== 'interrupted') { state.agentInterruptedTask = null; render(); toast('任务状态已变化，请查看最新回复。'); return; }
      state.agentInterruptedTask = null;
      return sendChat('继续');
    }

    export async function stopAgentTask() {
      if (state.chatStopPending) return;
      const owner = state.principal?.principalId, conversationId = state.agentConversationId || '';
      const isCurrent = () => owner === state.principal?.principalId && conversationId === (state.agentConversationId || '') && !state.accountContextChanged;
      state.chatStopPending = true; render();
      try {
        const task = await api('/api/v1/agent/task' + (conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''));
        if (!isCurrent()) return;
        if (!task || task.status !== 'running') { toast('当前没有正在执行的任务。'); return; }
        await api('/api/v1/agent/task', { method: 'DELETE', body: JSON.stringify({ taskId: task.id, conversationId }) });
        if (!isCurrent()) return;
        toast('已请求停止，等待当前步骤结束。');
      } finally { state.chatStopPending = false; render(); }
    }

    export async function sendChat(text, options = {}) {
      if (state.chatPending || state.chatImagesBusy || state.agentConversationLoading) return;
      const images = structuredClone(options.images || state.chatImages || []);
      const value = text.trim() || (images.length ? '请看看这些照片，给我与旅行相关的建议；无法确定的地点请说明。' : '');
      if (!value) return;
      const targetTrip = usesSavedDayPlans() ? null : tripId();
      const fix = state.currentLocation?.coordinates;
      let location = options.retry ? options.location : isFreshCurrentLocation(state.currentLocation) ? { lat: fix.lat, lng: fix.lng, accuracyMeters: fix.accuracyMeters, measuredAt: fix.measuredAt } : undefined;
      const clientMessageId = options.clientMessageId || newClientMessageId();
      const displayedProposal = options.retry ? options.proposalId : state.proposal?.proposalId;
      const companionRequest = options.retry ? options.companionRequest : options.companionRequest || companionRequestForText(value);
      const viewContext = options.retry ? options.viewContext : currentAgentViewContext();
      const chatOwner = state.principal?.principalId;
      const conversationId = options.retry ? (options.conversationId || '') : (state.agentConversationId || '');
      const browsingDate = state.planViewDate, browsingRevision = state.navigationRevision;
      const dateSelectionRevision = state.planDateSelectionRevision;
      const pendingMessage = { owner:chatOwner, conversationId, clientMessageId };
      const isCurrentSend = () => state.chatMessagePending === pendingMessage &&
        state.principal?.principalId === chatOwner && (state.agentConversationId || '') === conversationId;
      const isCurrentReceipt = () => state.chatLastReceipt === pendingMessage && !state.chatMessagePending &&
        state.principal?.principalId === chatOwner && (state.agentConversationId || '') === conversationId;
      const releaseSend = () => {
        if (!isCurrentSend()) return;
        state.chatPending = false; state.chatCompanionPending = false;
        state.chatMessagePending = null; state.agentTaskProgress = null;
        state.chatLastReceipt = pendingMessage;
      };
      const submission = beginChatComposerSubmission(text);
      state.chatMessagePending = pendingMessage; state.chatLastReceipt = null; state.agentTaskProgress = null;
      state.chatPending = true;
      state.chatCompanionPending = Boolean(companionRequest);
      state.chatRetry = null;
      let optimisticUserMessage = null;
      if (options.retry) {
        optimisticUserMessage = [...state.messages].reverse().find(message => message.role === 'user' && message.text === value && !message.messageId) || null;
      } else {
        optimisticUserMessage = { role: 'user', text: value, images };
        state.messages.push(optimisticUserMessage);
      }
      render();
      // 无旅行：走通用对话通道（伴途不绑定行程也能聊），不产生行程动作。
      if (!targetTrip) {
        try {
          // Send the existing fresh fix if available; ordinary Agent actions must not wait for GPS.
          // Actual departure and explicit route refresh retain their own location flow.
          const reply = await api('/api/v1/agent/chat', { method: 'POST', body: JSON.stringify({ text: value, clientMessageId, ...(conversationId ? { conversationId } : {}), ...(images.length ? { images } : {}), ...(location ? { location } : {}), ...(companionRequest ? { companionRequest } : {}), ...(viewContext ? { viewContext } : {}) }) });
          if (!isCurrentSend()) return;
          if (typeof reply?.assistantMessage?.text !== 'string' || !reply.assistantMessage.text.trim()) throw new Error('回复未完整接收，请检查任务结果后重试；重试不会重复执行已保存的操作。');
          if (JSON.stringify(state.chatImages || []) === JSON.stringify(images)) state.chatImages = [];
          if (usesSavedDayPlans()) {
            if (optimisticUserMessage && reply.userMessage?.messageId) optimisticUserMessage.messageId = reply.userMessage.messageId;
            state.messages.push({ role: 'assistant', messageId: reply.assistantMessage?.messageId, text: reply.assistantMessage.text, resultLinks: reply.assistantMessage?.resultLinks || [], agentMode: reply.assistantMessage?.agentMode, companionAdjustment: reply.assistantMessage?.companionAdjustment, companionDelegation: reply.assistantMessage?.companionDelegation });
            if (companionRequest?.sourceMessageId && reply.assistantMessage?.companionDelegation) {
              const source = state.messages.find(message => message.messageId === companionRequest.sourceMessageId);
              if (source?.companionDelegation) source.companionDelegation.status = companionRequest.action === 'cancel_delegate' ? 'cancelled' : 'superseded';
            }
            if (companionRequest?.sourceMessageId && reply.assistantMessage?.companionAdjustment) {
              const source = state.messages.find(message => message.messageId === companionRequest.sourceMessageId);
              if (source?.companionAdjustment) source.companionAdjustment = { ...source.companionAdjustment, status: ['apply', 'cancel'].includes(companionRequest.action) ? reply.assistantMessage.companionAdjustment.status : 'superseded' };
            }
            if (reply.assistantMessage?.agentMode && state.ready?.checks) state.ready.checks.agentMode = reply.assistantMessage.agentMode;
            const command = reply.command;
            if (command?.date && state.planViewDate === browsingDate && state.navigationRevision === browsingRevision && state.planDateSelectionRevision === dateSelectionRevision) state.planViewDate = command.date;
            state.chatRetry = null;
            releaseSend(); render();
            // 指令已经在服务端提交成功；刷新只是更新当前画面，失败不能把本次成功操作误报成可重试失败。
            await syncAgentViews(command?.refresh || []);
            if (!isCurrentReceipt()) return;
            try { await applyAgentUiActions(reply.agent?.uiActions || [], viewContext, chatOwner); }
            catch { toast('操作已处理，但页面跳转暂时未完成。可从回复中的入口打开。', 'error'); }
          }
          if (isCurrentSend() || isCurrentReceipt()) state.chatRetry = null;
        } catch (error) {
          if (isCurrentSend()) restoreChatComposerSubmission(submission);
          if (isCurrentSend() && usesSavedDayPlans()) {
            state.chatRetry = { text: value, images, location, clientMessageId, tripId: null, conversationId, proposalId: null, companionRequest, viewContext, error: error.message };
          }
        } finally {
          if (isCurrentSend()) { releaseSend(); render(); }
          else if (isCurrentReceipt()) render();
        }
        return;
      }
      try {
        const reply = await api(`/api/v1/trips/${targetTrip}/messages`, { method: 'POST', body: JSON.stringify({
          text: value, clientMessageId, ...(displayedProposal ? { proposalId: displayedProposal } : {}),
        }) });
        if (!isCurrentSend() || tripId() !== targetTrip) return;
        const replyText = reply?.assistantMessage?.text || reply?.answer;
        if (typeof replyText !== 'string' || !replyText.trim()) throw new Error('回复未完整接收，请检查任务结果后重试。');
        state.chatRetry = null;
        if (optimisticUserMessage && reply.userMessage?.messageId) optimisticUserMessage.messageId = reply.userMessage.messageId;
        state.messages.push({ role: 'assistant', messageId: reply.assistantMessage?.messageId, text: replyText });
        releaseSend(); render();
        if (reply.actionRequest) toast('方案已准备好，请检查后确认');
        if (reply.status === 'recorded') {
          state.lastSavedMemory = reply.memory;
          await Promise.allSettled([loadMemories(), loadTrip(targetTrip)]);
        }
        if (!isCurrentReceipt() || tripId() !== targetTrip) return;
        if (reply.proposal) {
          state.proposal = reply.proposal;
          state.actionRequests = reply.actionRequests || [];
        }
        if (reply.execution?.status === 'succeeded') {
          state.proposal = null;
          state.actionRequests = [];
          state.lastMutation = reply.execution.result?.mutationId || null;
          await loadTrip(targetTrip).catch(() => {});
        }
      } catch (error) {
        if (isCurrentSend()) restoreChatComposerSubmission(submission);
        if (isCurrentSend() && tripId() === targetTrip) {
          state.chatRetry = { text: value, clientMessageId, tripId: targetTrip, proposalId: displayedProposal || null, error: error.message };
        }
      } finally {
        if (isCurrentSend()) { releaseSend(); render(); }
        else if (isCurrentReceipt()) render();
      }
    }

    export async function retryFailedChat() {
      const attempt = state.chatRetry;
      if (!attempt || state.chatPending) return;
      const activeConversationTrip = usesSavedDayPlans() ? null : (tripId() || null);
      if ((attempt.conversationId || '') !== (state.agentConversationId || '')) { toast('请先切回这条消息所属的对话，再重试。', 'error'); return; }
      if ((attempt.tripId || null) !== activeConversationTrip) {
        toast('请先切回发送这条消息时的行程，再重试。', 'error');
        return;
      }
      return sendChat(attempt.text, {
        retry: true,
        conversationId: attempt.conversationId || '',
        images: attempt.images || [],
        location: attempt.location,
        clientMessageId: attempt.clientMessageId,
        proposalId: attempt.proposalId,
        companionRequest: attempt.companionRequest,
        viewContext: attempt.viewContext,
      });
    }

    function newClientMessageId() {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
      return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    async function locateForDeparture() {
      const locationOwner = state.principal?.principalId;
      const place = await requestCurrentLocation({ timeout:15000 });
      if (state.principal?.principalId !== locationOwner) throw new Error('账号已切换，请重新获取定位。');
      return { lat:place.coordinates.lat, lng:place.coordinates.lng };
    }

    async function reviewDepartureRoute(plan, stopId, origin, mode, timezone) {
      const stop = plan.stops?.find(item => item.stopId === stopId);
      if (!stop?.place?.coordinates) return { unavailable: true };
      try {
        const estimate = await api('/api/v1/routes', { method: 'POST', body: JSON.stringify({
          origin, destination: stop.place, transportMode: mode, cityCode: plan.cityCode || stop.place.cityCode || '',
        }) });
        const minutes = routeTravelMinutes({ ...estimate.leg, departureSupport: estimate.departureSupport });
        if (!Number.isFinite(minutes) || minutes <= 0) return { unavailable: true };
        return departureReview(minutes, mode, new Date(), timezone);
      } catch { return { unavailable: true }; }
    }

    export async function recordExecution(stopId, type, options = {}) {
      const target = tripId();
      if (state.executionPending || state.stopTransportPending) return;
      if (usesSavedDayPlans()) {
        const explicitPlanId = options.planId || (state.currentView === 'home' ? state.companionPlanId : '');
        const explicitPlan = explicitPlanId ? (state.savedPlans || []).find(plan => plan.id === explicitPlanId && plan.kind === 'plan' && plan.stops?.some(stop => stop.stopId === stopId)) : null;
        if (explicitPlanId && !explicitPlan) throw new Error('随行目标已变化，请重新查看当前计划。');
        const homeTarget = explicitPlan || (state.currentView === 'home' ? (state.savedPlans || []).find(plan => plan.kind === 'plan' &&
          plan.stops?.some(stop => stop.stopId === stopId && ['en_route', 'visiting'].includes(stop.status))) : null);
        const timezone = homeTarget?.timezone || state.savedPlans?.find(plan => plan.kind === 'plan' && plan.localDate === state.planViewDate)?.timezone || 'Asia/Shanghai';
        const now = new Date();
        const today = dateKeyInTimeZone(now, timezone);
        const date = explicitPlan?.localDate || (state.currentView === 'home' ? homeTarget?.localDate || today : (state.planViewDate || today));
        const plans = (state.savedPlans || []).filter(item => item.kind === 'plan' && item.localDate === date);
        if (date !== today && !(plans.length === 1 && hasOvernightActiveStop(plans[0], now))) {
          throw new Error('进度只能在当天记录。');
        }
        if (!plans.length) throw new Error('今天还没有日计划，请先添加地点。');
        if (plans.length > 1) throw new Error('今天有多份日计划，请先在“计划与进度”中处理重复安排。');
        const plan = plans[0];
        if (options.expectedRevision !== undefined && options.expectedRevision !== (plan.revision || 0)) throw new Error('计划刚刚有变化，请重新查看后再记录。');
        if (type === 'depart') state.companionDepartureFallback = null;
        state.executionPending = { planId: plan.id, stopId, type };
        render();
        let openDepartedStopRoute = false;
        try {
          const payload = { stopId, type, expectedRevision: plan.revision || 0 };
          if (type === 'depart') {
            const mode = (['walking', 'transit', 'driving'].includes(options.transportMode) ? options.transportMode : '') ||
              stopTransportMode(plan.stops?.find(stop => stop.stopId === stopId), plan);
            if (options.withoutLocation) {
              payload.skipRouteEstimate = true;
            } else {
              try { payload.origin = options.origin || await locateForDeparture(); }
              catch (error) {
                state.companionDepartureFallback = { planId: plan.id, stopId, expectedRevision: plan.revision || 0, transportMode: mode, preserveView: options.preserveView || state.currentView === 'home' };
                openSheet(`<div class="sheet-head"><h3>当前位置暂时不可用</h3><button class="icon-btn" data-action="cancel-departure" aria-label="关闭">✕</button></div><p>${escapeHtml(error.message)}</p><p>如果你已经出发，可以先记录真实进度，路线和预计到达时间保持待估。</p><div class="stop-actions departure-location-actions"><button class="btn-primary" data-action="confirm-departure-without-location">我已出发，先记录</button><button class="btn-soft" data-action="retry-departure-location">重新定位</button><button class="btn-ghost" data-action="cancel-departure">取消</button></div>`);
                return;
              }
              if (!options.reviewConfirmed) {
                const review = await reviewDepartureRoute(plan, stopId, payload.origin, mode, timezone);
                if (review?.unavailable) {
                  state.companionDepartureFallback = { planId: plan.id, stopId, expectedRevision: plan.revision || 0, transportMode: mode, preserveView: options.preserveView || state.currentView === 'home' };
                  openSheet(`<div class="sheet-head"><h3>路线暂时无法核对</h3><button class="icon-btn" data-action="cancel-departure" aria-label="关闭">✕</button></div><p>未能取得有效道路时间，暂时无法核对远距离与跨夜到达。可以重新查询；如果你已经出发，也可以先记录真实进度，预计时间保持待估。</p><div class="stop-actions departure-location-actions"><button class="btn-primary" data-action="confirm-departure-without-location">我已出发，先记录</button><button class="btn-soft" data-action="retry-departure-location">重新查询</button><button class="btn-ghost" data-action="cancel-departure">取消</button></div>`);
                  return;
                }
                if (review) {
                  state.departureReview = { planId: plan.id, stopId, expectedRevision: plan.revision || 0,
                    transportMode: mode, preserveView: options.preserveView || state.currentView === 'home', origin: payload.origin };
                  const arrival = fmt(review.arrivalMinutes);
                  openSheet(`<div class="sheet-head"><h3>出发前确认路线</h3><button class="icon-btn" data-action="cancel-departure-review" aria-label="关闭">✕</button></div><p>${review.longWalk ? `步行路线约 ${review.minutes} 分钟，距离较远。` : `路线约 ${review.minutes} 分钟。`}${review.overnight ? `预计次日凌晨 ${arrival} 到达，后续安排可能随之顺延。` : ''}</p><p>请核对定位与交通方式；如果你已经在地点，可直接记录到达。</p><div class="stop-actions departure-location-actions"><button class="btn-primary" data-action="confirm-departure-route">按当前位置出发</button><button class="btn-soft" data-action="arrive-at-place">我已到达</button>${review.overnight ? '<button class="btn-soft" data-action="open-daytime-plan">改到白天</button>' : ''}<button class="btn-ghost" data-action="cancel-departure-review">取消</button></div>`);
                  return;
                }
              }
            }
            payload.transportMode = mode;
            state.routeMode = mode;
            state.routeModeSelected = true;
            openDepartedStopRoute = !options.withoutLocation && !options.preserveView && state.currentView !== 'home';
          }
          const updated = await api(`/api/v1/plans/${encodeURIComponent(plan.id)}/execution-events`, {
            method: 'POST', body: JSON.stringify(payload),
          });
          state.savedPlans = (state.savedPlans || []).map(item => item.id === updated.id ? updated : item);
          state.planViewDate = date;
          if (state.currentView === 'home') state.companionPlanId = updated.id;
          if (state.currentView === 'home' && type === 'complete' && !updated.stops?.some(stop => ['planned', 'en_route', 'visiting'].includes(stop.status || 'planned'))) state.companionFinishedPlan = structuredClone(updated);
          // 完成最后一站后服务端会生成旅行记忆，当前页面立即同步，
          // 不需要用户离开页面再回来才能看到回顾卡片。
          if (type === 'complete') await loadAllMemories().catch(() => {});
          // 站点顺延跨过午夜时（T7 跨天归日）会迁入次日的计划对象，整体刷新拿到最新库。
          if (updated.migratedNextDayStops || updated.interruptedArrangements?.length) await loadPlans().catch(() => {});
          toast(updated.migratedNextDayStops
            ? `已记录真实进度，${updated.migratedNextDayStops} 个站点顺延到次日的计划`
            : '已记录真实进度');
          if (type === 'abort' && updated.interruptedArrangements?.length) {
            openSheet(`<div class="sheet-head"><h3>已中止，后续怎么安排？</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div><p>本次前往已结束。出发时顺延的地点仍在以下日期；可以先预览白天安排，再决定是否调整。</p><div class="interrupted-arrangements">${updated.interruptedArrangements.map(day => `<section class="interrupted-arrangement"><strong>${escapeHtml(monthDay(day.localDate))}</strong><p>${day.names.map(escapeHtml).join('、')}</p>${day.canMoveToDaytime ? `<button class="btn-primary" data-action="open-daytime-plan" data-plan="${escapeHtml(day.planId)}" data-stop="${escapeHtml(day.stopId)}">预览移到白天</button>` : '<p>已有进度或固定时段，请在计划中核对安排。</p>'}</section>`).join('')}</div><p class="stop-meta">中止和出发记录均保留；这里不会自动撤销其他修改。</p><button class="btn-soft" data-action="close-sheet">保留现有安排</button>`);
          }
        } finally {
          state.executionPending = null;
          render();
        }
        if (openDepartedStopRoute) {
          try { await import('./map.js').then(module => module.routeToStop(stopId)); }
          catch (error) { toast(`已记录出发，但地图路线暂未打开：${error.message}`, 'error'); }
        }
        return;
      }
      const revision = tripRevision();
      state.executionPending = { tripId: target, stopId, type };
      render();
      try {
        await api(`/api/v1/trips/${target}/execution-events`, { method: 'POST', body: JSON.stringify({ stopId, type, expectedRevision: revision }) });
        if (tripId() !== target) return;
        await loadTrip(target).catch(() => {});
        if (tripId() !== target) return;
        toast('已记录真实进度');
      } finally {
        state.executionPending = null;
        render();
      }
    }

    export async function undoLast() {
      const data = await api(`/api/v1/trips/${tripId()}/undo`, { method: 'POST', headers: { 'idempotency-key': `undo-${Date.now()}` }, body: JSON.stringify({ mutationId: state.lastMutation, expectedRevision: tripRevision() }) });
      state.lastMutation = null;
      await loadTrip(tripId()).catch(() => {});
      render();
      toast('已撤销，回到调整前');
    }

    export async function addMemory() {
      const input = $('memoryText');
      if (!input || !input.value.trim()) { toast('请先输入要保存的原文'); return; }
      try {
        await api(`/api/v1/trips/${tripId()}/memories`, { method: 'POST', body: JSON.stringify({ userText: input.value.trim() }) });
        input.value = '';
        await loadTrip(tripId()).catch(() => {});
        if (state.currentView === 'memories' || state.currentView === 'mine') await loadAllMemories().catch(() => {});
        else await loadMemories().catch(() => {});
        render();
        toast('已按原文保存记录');
      } catch (error) {
        toast(error.message || '保存记录失败', 'error');
      }
    }

    export async function showPlaceDetail(placeId) {
      const place = findPlace(placeId);
      if (!place) return;
      const identifier = placeIdHtml(place);
      openSheet(`<div class="sheet-head"><h3 style="margin:0">${escapeHtml(place.name)}</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
        ${tagChips(place, 'edit-place-tags')}
        <ul class="change-list">${identifier ? `<li>地点编号：${identifier}</li>` : ''}<li>开放时段：${place.openingIntervals?.length ? place.openingIntervals.map(slot => formatTimeRange(slot.startMinutes, slot.endMinutes)).join('、') : '暂无资料'}</li><li>建议停留：${place.suggestedDurationMinutes ? `${escapeHtml(place.suggestedDurationMinutes)} 分钟` : '暂无资料'}</li><li>位置：${place.address ? `${escapeHtml(place.address)}${place.cityCode ? `（${cityName(place.cityCode)}）` : ''}` : place.coordinates ? `${escapeHtml(place.coordinates.lat)}, ${escapeHtml(place.coordinates.lng)}` : '暂无地址'}</li><li>设施：${escapeHtml(facilityList(place.facilityCodes))}</li><li>资料：${place.evidenceIds?.length ? `已标注 ${place.evidenceIds.length} 条来源` : '未标注来源'}${place.coordinates ? '，含坐标' : '，坐标未知'}</li></ul>
        <p class="stop-meta">${place.coordinates?.source === 'demo' ? '以上为样例资料，仅供体验。' : '开放时间与设施以现场公告为准。'}</p><div class="stop-actions"><button class="btn-primary" data-action="add-to-plan" data-place="${escapeHtml(place.placeId)}">＋ 加入计划</button>${favoriteButton(place.placeId)}</div>`);
    }

    const VERSION_REASON_LABEL = {
      'trip.patch': '手动修改计划',
      'trip.create': '创建旅行',
      'proposal.apply': '采用了一个方案',
      'proposal.undo': '撤销了上次调整',
      'demo.reset': '恢复样例数据',
      'execution.replay': '根据实际进度重排',
    };

    export async function showVersionHistory(targetDate = '') {
      const targetTrip = tripId();
      if (!targetTrip) return;
      const mountedDate = state.mountedDate || state.trip?.trip?.localDate || '';
      const date = targetDate || state.planViewDate || mountedDate;
      const versions = await api(`/api/v1/trips/${targetTrip}/versions`);
      const recent = await Promise.all(versions.slice(-5).reverse().map(async version => {
        const full = await api(`/api/v1/trips/${targetTrip}/versions/${version.revision}`);
        const stops = (full.snapshot?.stops || []).filter(stop =>
          (stop.date || (date === mountedDate ? mountedDate : '')) === date && stop.status !== 'skipped');
        return { ...version, stops };
      }));
      if (targetTrip !== tripId()) return;
      const previousPlanRevision = date === mountedDate ? state.trip?.previousPlanRevision : null;
      openSheet(`<div class="sheet-head"><h3 style="margin:0">${escapeHtml(monthDay(date) || '计划')} · 快照</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div>
        ${previousPlanRevision != null ? `<button class="btn-primary" data-action="restore-version" data-date="${escapeHtml(date)}" data-revision="${previousPlanRevision}">回到上一次计划</button><p class="stop-meta">只恢复这一天的计划，实际进度保留。</p>` : ''}
        <p class="stop-meta">每次修改自动保留快照，最多 5 个。恢复只会改这一天的待进行安排。</p>
        ${recent.filter(version => version.stops.length).map(version => {
          const label = escapeHtml(VERSION_REASON_LABEL[version.reason] || VERSION_REASON_LABEL[version.action] || version.reason || version.action || '计划有更新');
          const current = version.revision === tripRevision();
          const preview = version.stops.map(stop => stop.place?.name || stop.stopId).join(' → ') || '空计划';
          return `<div class="profile-row"><div><strong>${label}</strong><span>${escapeHtml(clockText(version.createdAt))}${current ? ' · 当前版本' : ''}</span><span class="stop-meta">${escapeHtml(preview)}</span></div>${current ? '' : `<button class="btn-small" data-action="restore-version" data-date="${escapeHtml(date)}" data-revision="${version.revision}">恢复此版</button>`}</div>`;
        }).join('') || '<p class="stop-meta">这一天还没有旅行快照。</p>'}`);
    }
