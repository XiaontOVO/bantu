import type { ServerContext } from '../server/http/context.js';
import type { PlanStop, RouteLeg } from '../domain/types.js';
import { getStopStart, getStopEnd } from '../domain/normalize.js';

/** Compare saved evidence only; missing routes are unknown, never zero-distance shortcuts. */
export async function compareAgentSchemes(ctx: ServerContext, actorId: string, planIds: string[]) {
  const ids = [...new Set(planIds)];
  if (ids.length < 2 || ids.length > 5) throw new Error('请选择 2 至 5 份不同的方案。');
  const owned = ctx.planLibrary.list(actorId);
  const plans = ids.map(id => {
    const plan = owned.find(item => item.id === id && item.kind === 'scheme');
    if (!plan) throw new Error('方案不存在或不属于当前账号，请重新读取方案。');
    return structuredClone(plan);
  });
  const directory = ctx.options.placeProvider || ctx.fallbackPlaceProvider;
  const placeIds = [...new Set(plans.flatMap(plan => (plan.days || []).flatMap(day => day.stops.map(stop => (stop as PlanStop).placeId || (stop as PlanStop).place?.placeId || ''))))];
  const places = new Map();
  for (const id of placeIds) places.set(id, await directory.detail(id));
  const now = Date.parse(ctx.now());
  const comparisons = plans.map(plan => {
    const days = (plan.days || []).map(day => {
      const stops = (day.stops as PlanStop[]).filter(stop => stop.status !== 'skipped').sort((a, b) => getStopStart(a) - getStopStart(b));
      let knownTravelMinutes = 0, knownDistanceMeters = 0, missingTimeSegments = 0, missingDistanceSegments = 0;
      const segments = stops.slice(1).map((to, index) => {
        const from = stops[index];
        const matches = (day.routeLegs as RouteLeg[]).filter(leg => leg.fromStopId === from.stopId && leg.toStopId === to.stopId);
        const leg = matches.length === 1 ? matches[0] : undefined;
        const expired = Boolean(leg?.expiresAt && (!Number.isFinite(Date.parse(leg.expiresAt)) || Date.parse(leg.expiresAt) <= now));
        const usable = leg && leg.departureSupport !== 'demo' && !expired;
        const duration = usable ? (leg.durationSeconds !== undefined ? Math.ceil(leg.durationSeconds / 60) : leg.durationMinutes) : undefined;
        const buffer = leg?.bufferMinutes ?? 0;
        const minutes = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && Number.isFinite(buffer) && buffer >= 0 ? duration + buffer : null;
        const distance = usable && typeof leg.distanceMeters === 'number' && Number.isFinite(leg.distanceMeters) && leg.distanceMeters >= 0 ? leg.distanceMeters : null;
        if (minutes === null) missingTimeSegments++; else knownTravelMinutes += minutes;
        if (distance === null) missingDistanceSegments++; else knownDistanceMeters += distance;
        return { fromStopId: from.stopId, toStopId: to.stopId, mode: usable ? leg.transportMode : null, travelMinutes: minutes, distanceMeters: distance, expired };
      });
      return { dayIndex: day.dayIndex, stopCount: stops.length, visitMinutes: stops.reduce((sum, stop) => sum + Math.max(0, getStopEnd(stop) - getStopStart(stop)), 0),
        travelMinutes: missingTimeSegments ? null : knownTravelMinutes, distanceMeters: missingDistanceSegments ? null : knownDistanceMeters,
        knownTravelMinutes, knownDistanceMeters, missingTimeSegments, missingDistanceSegments, segments,
        stops: stops.map(stop => { const place = places.get(stop.placeId || stop.place?.placeId || ''); return { stopId: stop.stopId, placeId: place?.placeId || null, name: place?.name || null, missingPlace: !place, startMinutes: getStopStart(stop), endMinutes: getStopEnd(stop) }; }) };
    });
    return { planId: plan.id, name: plan.name, dayCount: days.length, emptyDays: days.filter(day => !day.stopCount).length, stopCount: days.reduce((sum, day) => sum + day.stopCount, 0), visitMinutes: days.reduce((sum, day) => sum + day.visitMinutes, 0),
      travelMinutes: days.some(day => day.travelMinutes === null) ? null : days.reduce((sum, day) => sum + day.travelMinutes!, 0),
      distanceMeters: days.some(day => day.distanceMeters === null) ? null : days.reduce((sum, day) => sum + day.distanceMeters!, 0), days };
  });
  const latest = ctx.planLibrary.list(actorId);
  if (plans.some(plan => !latest.some(current => current.id === plan.id && current.revision === plan.revision))) throw new Error('比较期间方案已变化，请重新比较。');
  return { comparisons, note: '游览时长来自方案安排；交通仅统计已保存且未过期的路线。null 表示数据不足，不能当作零；没有首站前和末站后的交通。不能据此断言实际体力消耗或营业状态。' };
}
