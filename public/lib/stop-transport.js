import { api } from './api.js';
import { newClientId } from './client-id.js';
import { state } from './store.js';
import { render } from './render.js';
import { toast } from './ui.js';
import { requestPlanRoute } from './plan-route-timing.js';
import { TRANSPORT_LABELS } from './transport-modes.js';
import { isFreshCurrentLocation } from './location.js';

export function stopTransportMode(stop, plan) {
  return stop?.preferredTransportMode || state.stopModes?.[stop?.stopId] || stop?.estimatedTransportMode ||
    plan?.routeLegs?.find(leg => leg.toStopId === stop?.stopId)?.transportMode || 'walking';
}

/** Save the user's choice even when roads or location are unavailable. Estimates are optional. */
export async function saveStopTransport(plan, stopId, mode, { estimate = true } = {}) {
  if (!Object.hasOwn(TRANSPORT_LABELS, mode)) throw new Error('请选择有效的交通方式。');
  if (state.stopTransportPending || state.executionPending) return;
  const source = structuredClone(plan), owner = state.principal?.principalId, view = state.currentView;
  const stops = source.stops || [], stop = stops.find(item => item.stopId === stopId);
  if (!stop || !['planned', 'en_route'].includes(stop.status || 'planned')) throw new Error('这个地点当前不能切换交通方式。');
  const revision = source.revision || 0;
  const pending = { planId: source.id, stopId, mode, owner };
  const isCurrentTransportChange = () => state.principal?.principalId === owner &&
    state.savedPlans?.some(item => item.id === source.id && (item.revision || 0) === revision);
  state.stopTransportPending = pending;
  if (state.currentView === view) render();
  toast('正在保存交通方式…');
  try {
    stop.preferredTransportMode = mode;
    // Never reuse an estimate for a different mode. Keep the old route record so linked fees survive.
    delete stop.estimatedTravelMinutes;
    delete stop.estimatedTransportMode;
    let routeLegs = source.routeLegs || [], known = false;
    const active = stops.filter(item => item.status !== 'skipped'), index = active.findIndex(item => item.stopId === stopId);
    const freshFix = isFreshCurrentLocation(state.currentLocation);
    const previous = index > 0 ? active[index - 1] : freshFix
      ? { stopId: 'my-location', place: state.currentLocation } : null;
    if (estimate && previous && !(mode === 'transit' && state.mapConfig && !state.mapConfig.routeModes?.includes(mode))) {
      try {
        const leg = await requestPlanRoute(api, previous, stop, mode);
        const charged = new Set((source.plannedCharges || []).map(charge => charge.routeLegRef).filter(Boolean));
        routeLegs = routeLegs.filter(item => item.toStopId !== stopId || charged.has(item.legId));
        if (routeLegs.some(item => item.legId === leg.legId)) leg.legId += `_${mode}_${newClientId()}`;
        routeLegs.push(leg); known = true;
      } catch { /* A failed optional estimate must not discard the user's choice. */ }
    }
    if (!isCurrentTransportChange()) throw new Error('账号或计划已变化，请重新选择交通方式。');
    let updated;
    try {
      updated = await api(`/api/v1/plans/${encodeURIComponent(source.id)}`, { method: 'PUT', body: JSON.stringify({
        name: source.name, cityCode: source.cityCode, timezone: source.timezone, localDate: source.localDate,
        expectedRevision: revision, snapshot: { stops, routeLegs, plannedCharges: source.plannedCharges || [] },
      }) });
    } catch (error) {
      // Ignore an old owner's receipt; preflight identity changes still reject above.
      if (state.principal?.principalId !== owner) return;
      throw error;
    }
    if (state.principal?.principalId !== owner) return;
    const current = state.savedPlans?.find(item => item.id === source.id);
    if (!current || (current.revision || 0) > (updated.revision || 0)) return;
    state.savedPlans = state.savedPlans.map(item => item.id === updated.id ? updated : item);
    state.stopModes = { ...state.stopModes, [stopId]: mode };
    state.routeMode = mode; state.routeModeSelected = true; state.companionContext = null;
    if (state.currentView === view) toast(`已保存${TRANSPORT_LABELS[mode]}${known ? '及道路估算' : '，交通时间待估'}`);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('交通方式未保存，请检查网络后重新选择。原选择已保留。');
    throw error;
  } finally {
    if (state.stopTransportPending === pending) state.stopTransportPending = null;
    if (state.principal?.principalId === owner && state.currentView === view) render();
  }
}
