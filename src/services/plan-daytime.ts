import { getStopStart, getStopEnd } from '../domain/normalize.js';
import type { PlanStop, RouteLeg, TimeRange } from '../domain/types.js';
import type { SavedPlan } from './plan-library.js';

const DAY = 86400000;
const minuteFields = ['startMinutes', 'plannedStartMinutes', 'plannedArrivalMinutes', 'endMinutes', 'departureMinutes', 'plannedDepartureMinutes'] as const;
export const addPlanDate = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
export interface DaytimeTarget { localDate: string; planId: string | null; expectedRevision: number | null }

/** A content preview only: existing visits and execution logs are never rewritten. */
export function daytimePlanPreview(source: SavedPlan, plans: SavedPlan[], stopId: string, firstDate: string, minimumStartMinutes = 540) {
  const stops = structuredClone(source.stops) as PlanStop[];
  const startIndex = stops.findIndex(stop => stop.stopId === stopId);
  const facts = new Set((source.executionEvents || []).map(event => event.stopId));
  const protectedReason = (stop: PlanStop) => facts.has(stop.stopId) || (stop.status && stop.status !== 'planned') ? '已有进度记录'
    : stop.timeLocked || stop.lockTime || stop.visitWindow ? '固定时段或预约' : '';
  if (startIndex < 0) throw new Error('这个地点已不在原计划中，请重新查看。');
  if (protectedReason(stops[startIndex])) throw new Error('这个地点有进度或固定时段，请先核对；不能自动改期。');
  const moving = stops.slice(startIndex).filter(stop => !protectedReason(stop));
  const visitLabels = moving.map(stop => {
    const identity = stop.place?.placeId || stop.placeId;
    const visits = identity ? stops.filter(item => item.status !== 'skipped' && (item.place?.placeId || item.placeId) === identity) : [stop];
    return { stopId: stop.stopId, visitNumber: visits.findIndex(item => item.stopId === stop.stopId) + 1, totalVisits: visits.length,
      openingKnown: Boolean(stop.openingIntervals?.length || (stop.place as unknown as { openingIntervals?: TimeRange[] })?.openingIntervals?.length) };
  });
  const movedIds = new Set(moving.map(stop => stop.stopId));
  const preserved = stops.filter(stop => !movedIds.has(stop.stopId));
  const targets = new Map<string, DaytimeTarget>();
  const destinations = new Map<string, { date: string; planName: string; existingStops: PlanStop[]; stops: PlanStop[] }>();
  const consulted = (date: string) => {
    const matches = plans.filter(plan => plan.kind === 'plan' && plan.localDate === date);
    if (matches.length > 1) throw new Error(`${date} 有多份日计划，请先处理重复安排。`);
    const plan = matches[0];
    if (plan && (plan.timezone || 'Asia/Shanghai') !== (source.timezone || 'Asia/Shanghai')) throw new Error(`${date} 的计划时区不同，请先核对日期。`);
    if (date !== source.localDate) targets.set(date, { localDate: date, planId: plan?.id || null, expectedRevision: plan ? plan.revision || 0 : null });
    return plan;
  };
  const queue = (plan: SavedPlan | undefined) => (plan?.id === source.id ? preserved : (plan?.stops || []) as PlanStop[]).filter(stop => stop.status !== 'skipped');
  const originalVisits = stops.filter(stop => stop.status !== 'skipped');
  const legFor = (from: PlanStop | undefined, to: PlanStop): RouteLeg | undefined => from && originalVisits.findIndex(stop => stop.stopId === to.stopId) === originalVisits.findIndex(stop => stop.stopId === from.stopId) + 1 ?
    (source.routeLegs as RouteLeg[] || []).find(leg => leg.fromStopId === from.stopId && leg.toStopId === to.stopId &&
      (!to.preferredTransportMode || leg.transportMode === to.preferredTransportMode) &&
      !leg.expiresAt && !leg.departureAt && !['live', 'current_only', 'demo'].includes(leg.departureSupport || '')) : undefined;
  const travel = (leg: RouteLeg | undefined) => {
    if (!leg) return null;
    const duration = Number.isFinite(leg.durationSeconds) ? Math.ceil(leg.durationSeconds! / 60) : leg.durationMinutes;
    return Number.isFinite(duration) && duration! > 0 ? Math.ceil(duration!) + Math.max(0, leg.bufferMinutes || 0) : null;
  };
  let date = firstDate;
  for (const stop of moving) {
    const duration = getStopEnd(stop) - getStopStart(stop);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 660) throw new Error(`「${stop.place?.name || stop.stopId}」的停留时长排不进白天，请先调整停留时间。`);
    const intervals = stop.openingIntervals || (stop.place as unknown as { openingIntervals?: TimeRange[] })?.openingIntervals || [];
    const slots = (intervals.length ? intervals : [{ startMinutes: 540, endMinutes: 1200 }])
      .map(slot => ({ start: Math.max(540, slot.startMinutes), end: Math.min(1200, slot.endMinutes) }))
      .filter(slot => Number.isFinite(slot.start) && Number.isFinite(slot.end) && slot.end - slot.start >= duration).sort((a, b) => a.start - b.start);
    if (!slots.length) throw new Error(`「${stop.place?.name || stop.stopId}」的已知开放时段排不进 09:00–20:00，请调整后重试。`);
    let placed = false;
    // Every occupied date can advance the search; all visits have an empty-day slot.
    for (let attempt = 0; attempt <= plans.length + moving.length + 1; attempt++, date = addPlanDate(date, 1)) {
      const target = consulted(date), prior = consulted(addPlanDate(date, -1));
      const existing = queue(target), previousDay = queue(prior);
      if (target?.id !== source.id && existing.some(stop => ['en_route', 'visiting'].includes(stop.status || ''))) continue;
      const destination = destinations.get(date);
      const pending = destination?.stops || [];
      const previousMoved = pending.at(-1), route = legFor(previousMoved, stop);
      const earliest = Math.max(date === firstDate ? minimumStartMinutes : 540, 540, ...existing.map(getStopEnd), ...previousDay.map(stop => getStopEnd(stop) - 1440),
        previousMoved ? getStopEnd(previousMoved) + (travel(route) || 0) : 0);
      const fitted = slots.map(slot => Math.max(earliest, slot.start)).find((minute, index) => minute + duration <= slots[index].end);
      if (fitted === undefined) continue;
      const moved = structuredClone(stop);
      for (const field of minuteFields) moved[field] = field === 'endMinutes' || field === 'departureMinutes' || field === 'plannedDepartureMinutes' ? fitted + duration : fitted;
      // A previous date's origin and departure estimate cannot become tomorrow's real location.
      delete moved.travelStartMinutes; delete moved.plannedTravelStartMinutes;
      delete moved.estimatedTravelMinutes; delete moved.estimatedTransportMode;
      delete moved.forecastStartMinutes; delete moved.forecastEndMinutes; delete moved.forecastConflict;
      moved.plannedDurationMinutes = duration;
      const entry = destination || { date, planName: target?.name || `${date} 日计划`, existingStops: structuredClone(existing), stops: [] };
      entry.stops.push(moved); destinations.set(date, entry); placed = true; break;
    }
    if (!placed) throw new Error('后续日期暂时排不下这些地点，请调整后再试。');
  }
  const dayOf = new Map(preserved.map(stop => [stop.stopId, source.localDate!]));
  for (const destination of destinations.values()) for (const stop of destination.stops) dayOf.set(stop.stopId, destination.date);
  const routeLegs = (source.routeLegs as RouteLeg[] || []).filter(leg => {
    const to = dayOf.get(leg.toStopId), from = dayOf.get(leg.fromStopId);
    if (!movedIds.has(leg.toStopId) && !movedIds.has(leg.fromStopId)) return true;
    if (!to || !from || from !== to) return false;
    const destination = destinations.get(to), visits = destination?.stops || [];
    const index = visits.findIndex(stop => stop.stopId === leg.toStopId);
    return index > 0 && visits[index - 1].stopId === leg.fromStopId && legFor(visits[index - 1], visits[index]) === leg;
  });
  const retainedLegIds = new Set(routeLegs.map(leg => leg.legId));
  const plannedCharges = source.plannedCharges.filter(value => {
    const charge = value as { routeLegRef?: string; stopId?: string; paymentStatus?: string; status?: string; date?: string; localDate?: string };
    if (charge.stopId && movedIds.has(charge.stopId) && (charge.date || charge.localDate)) throw new Error('改期涉及指定日期的费用，请先核对退改条件；本次未保存。');
    if (!charge.routeLegRef || retainedLegIds.has(charge.routeLegRef)) return true;
    if ((charge.paymentStatus ?? charge.status) !== 'unpaid') throw new Error('改期影响已支付或尚未核对的交通费用，请先核对费用；本次未保存。');
    return false;
  });
  const nextStops: PlanStop[] = structuredClone(preserved);
  for (const destination of destinations.values()) {
    const offset = (Date.parse(`${destination.date}T00:00:00Z`) - Date.parse(`${source.localDate}T00:00:00Z`)) / DAY;
    for (const stop of destination.stops) {
      const absolute = structuredClone(stop);
      for (const field of minuteFields) if (Number.isFinite(absolute[field])) absolute[field] = absolute[field]! + offset * 1440;
      nextStops.push(absolute);
    }
  }
  nextStops.sort((a, b) => getStopStart(a) - getStopStart(b));
  return { stopId, firstDate, visitLabels, destinations: [...destinations.values()], expectedCarryTargets: [...targets.values()],
    preserved: preserved.map(stop => ({ stopId: stop.stopId, name: stop.place?.name || stop.stopId, reason: protectedReason(stop) || '本次调整之前的安排' })),
    snapshot: { stops: nextStops, routeLegs, plannedCharges },
    discardedRouteEstimates: source.routeLegs.length - routeLegs.length,
    discardedUnpaidCharges: source.plannedCharges.length - plannedCharges.length };
}
