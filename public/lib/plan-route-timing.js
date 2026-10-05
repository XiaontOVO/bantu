/** Shared planning semantics: missing/invalid/demo travel is unknown, never a fabricated 30 minutes. */
import { TRANSPORT_LABELS } from './transport-modes.js';
export { TRANSPORT_LABELS };

export function routeTravelMinutes(leg) {
  if (!leg || leg.departureSupport === 'demo') return null;
  if (leg.durationSeconds != null && typeof leg.durationSeconds !== 'number') return null;
  const duration = leg.durationSeconds !== undefined && leg.durationSeconds !== null
    ? leg.durationSeconds / 60 : leg.durationMinutes;
  const buffer = leg.bufferMinutes ?? 0;
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 &&
    typeof buffer === 'number' && Number.isFinite(buffer) && buffer >= 0 ? Math.ceil(duration + buffer) : null;
}

const aliases = stop => [stop?.stopId, stop?.placeId, stop?.place?.placeId].filter(Boolean);
export const matchesPlanRoute = (leg, previous, stop) => aliases(previous).includes(leg.fromStopId) && aliases(stop).includes(leg.toStopId);
export function transportModeToStop(day, stop, previous) {
  if (stop?.preferredTransportMode) return stop.preferredTransportMode;
  if (day?.transportMode) return day.transportMode;
  return (day?.routeLegs || []).find(leg => previous && matchesPlanRoute(leg, previous, stop))?.transportMode || 'walking';
}
export function incomingPlanRoute(day, previous, stop) {
  if (!previous || !stop) return null;
  return (day.routeLegs || []).find(leg => matchesPlanRoute(leg, previous, stop) &&
    (!stop.preferredTransportMode || leg.transportMode === stop.preferredTransportMode) &&
    (stop.preferredTransportMode || !day.transportMode || leg.transportMode === day.transportMode) && routeTravelMinutes(leg) !== null) || null;
}

export function planRouteSummary(day) {
  const stops = (day?.stops || []).filter(stop => stop.status !== 'skipped');
  const segments = stops.slice(1).map((stop, index) => {
    const previous = stops[index], leg = incomingPlanRoute(day, previous, stop);
    return { previous, stop, leg, minutes: routeTravelMinutes(leg), mode: transportModeToStop(day, stop, previous) };
  });
  const unknown = segments.filter(segment => segment.minutes === null).length;
  const conflict = segments.find(({ previous, stop, minutes }) => minutes !== null &&
    Number.isFinite(previous.endMinutes) && Number.isFinite(stop.startMinutes) && stop.startMinutes < previous.endMinutes + minutes);
  const note = !segments.length ? '前往第一站的时间，在出发时按当前位置计算。'
    : unknown ? `${unknown} 段交通待估；当前仅排列游览时段，不能据此判断能否赶到。`
    : '已按每个地点选定的交通方式估算道路时间；出发时再按当前位置更新。';
  return { segments, unknown, conflict, note };
}

export async function requestPlanRoute(callApi, previous, stop, transportMode, signal) {
  const origin = previous?.place, destination = stop?.place;
  if (!origin?.coordinates || !destination?.coordinates) throw new Error('地点缺少坐标，交通时间待估。');
  if (origin.cityCode && destination.cityCode && origin.cityCode !== destination.cityCode) throw new Error('跨城交通时间待估，请单独安排城际交通。');
  const result = await callApi('/api/v1/routes', { method: 'POST', signal,
    body: JSON.stringify({ origin, destination, transportMode, cityCode: origin.cityCode || destination.cityCode || '' }),
  });
  const leg = { ...result.leg, departureSupport: result.departureSupport };
  if (result.error || routeTravelMinutes(leg) === null || leg.transportMode !== transportMode) throw new Error('未取得所选方式的有效道路时间，交通保持待估。');
  return { ...leg, legId: `route_${previous.stopId}_${stop.stopId}`, fromStopId: previous.stopId, toStopId: stop.stopId };
}
