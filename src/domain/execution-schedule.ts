import type { ExecutionEvent, PlanStop, RouteLeg, TripSnapshot } from './types.js';
import { getStopEnd, getStopStart } from './normalize.js';

export function effectiveExecutionEvents(events: readonly ExecutionEvent[]) {
  const replaced = new Set(events.map(event => event.correctsEventId).filter(Boolean));
  return events.filter(event => !replaced.has(event.executionEventId))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.recordedAt.localeCompare(b.recordedAt));
}

/** 只使用当前有效尝试；中止和纠正回计划后，旧出发不能继续占据队首。 */
export function executionTriggerTimes(events: readonly ExecutionEvent[]) {
  const times = new Map<string, number>();
  for (const event of effectiveExecutionEvents(events)) {
    const status = event.correctsEventId && event.statusOverride ? event.statusOverride
      : ({ depart: 'en_route', arrive: 'visiting', complete: 'completed', abort: 'planned', skip: 'skipped' })[event.type];
    if (status === 'planned' || status === 'skipped') times.delete(event.stopId);
    else if (!times.has(event.stopId)) times.set(event.stopId, Date.parse(event.occurredAt));
  }
  return times;
}

export function eventMinutes(instant: string, snapshot: TripSnapshot, stop?: PlanStop): number | null {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: snapshot.timezone || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name: string) => parts.find(value => value.type === name)?.value || '';
  const localDate = `${part('year')}-${part('month')}-${part('day')}`;
  const baseDate = stop?.date || snapshot.localDate || snapshot.travelDate || localDate;
  const days = Math.round((Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${baseDate}T00:00:00Z`)) / 86400000);
  return days * 1440 + Number(part('hour')) * 60 + Number(part('minute'));
}

export function routeTravelMinutes(leg?: RouteLeg): number | null {
  if (!leg) return null;
  const duration = leg.durationSeconds !== undefined ? leg.durationSeconds / 60 : leg.durationMinutes;
  const buffer = leg.bufferMinutes ?? 0;
  return Number.isFinite(duration) && duration! >= 0 && Number.isFinite(buffer) && buffer >= 0
    ? Math.ceil(duration! + buffer) : null;
}

export function departureBaseline(stop: PlanStop, snapshot: TripSnapshot): number {
  if (Number.isFinite(stop.plannedTravelStartMinutes)) return stop.plannedTravelStartMinutes!;
  const index = snapshot.stops?.findIndex(item => item.stopId === stop.stopId) ?? -1;
  const previous = index > 0 ? snapshot.stops![index - 1] : undefined;
  const incoming = snapshot.routeLegs?.find(leg => leg.toStopId === stop.stopId && (!stop.preferredTransportMode || leg.transportMode === stop.preferredTransportMode) &&
    (previous ? leg.fromStopId === previous.stopId : ['origin', 'my-location'].includes(leg.fromStopId)));
  const minutes = routeTravelMinutes(incoming) ?? (Number.isFinite(stop.estimatedTravelMinutes) ? stop.estimatedTravelMinutes! : 0);
  return getStopStart(stop) - minutes;
}

/** 预测只是视图：不把路线 ETA 写成实际到达，不对同一次延误重复顺延。 */
export function projectExecutionSchedule(snapshot: TripSnapshot, now?: string): PlanStop[] {
  const times = executionTriggerTimes(snapshot.executionEvents || []);
  const ordered = (snapshot.stops || []).map((stop, index) => ({ stop, index })).sort((a, b) => {
    const activeA = a.stop.status !== 'planned' && times.has(a.stop.stopId);
    const activeB = b.stop.status !== 'planned' && times.has(b.stop.stopId);
    if (activeA !== activeB) return activeA ? -1 : 1;
    return activeA ? times.get(a.stop.stopId)! - times.get(b.stop.stopId)!
      : (a.stop.originalPlanOrder ?? a.index) - (b.stop.originalPlanOrder ?? b.index);
  });
  const effective = effectiveExecutionEvents(snapshot.executionEvents || []);
  let previous: PlanStop | undefined;
  let previousEnd: number | undefined;
  const projected = new Map<string, PlanStop>();
  for (const { stop } of ordered) {
    const copy = { ...stop };
    for (const field of ['forecastStartMinutes', 'forecastEndMinutes', 'actualArrivalMinutes', 'actualCompletionMinutes',
      'transferTimeUnknown', 'executionOverdue', 'forecastConflict'] as const) delete copy[field];
    if (stop.status === 'skipped') { projected.set(stop.stopId, copy); continue; }
    const stopEvents = effective.filter(event => event.stopId === stop.stopId);
    let arrival: number | null = null, completion: number | null = null;
    for (const event of stopEvents) {
      const status = event.correctsEventId && event.statusOverride ? event.statusOverride
        : ({ arrive: 'visiting', complete: 'completed', depart: 'en_route', abort: 'planned', skip: 'skipped' })[event.type];
      if (status === 'visiting') {
        if (arrival === null || event.type === 'arrive') arrival = eventMinutes(event.occurredAt, snapshot, stop);
        completion = null;
      }
      else if (status === 'completed') completion = eventMinutes(event.occurredAt, snapshot, stop);
      else { arrival = null; completion = null; }
    }
    if (arrival !== null) copy.actualArrivalMinutes = arrival;
    if (completion !== null) copy.actualCompletionMinutes = completion;
    const duration = Math.min(1440, Math.max(0, stop.plannedDurationMinutes ?? getStopEnd(stop) - getStopStart(stop)));
    let start = getStopStart(stop), end = getStopEnd(stop);
    if (stop.status === 'en_route') {
      const departure = stop.travelStartMinutes;
      const estimate = stop.estimatedTravelMinutes;
      if (Number.isFinite(departure) && Number.isFinite(estimate)) {
        start = Math.max(start, departure! + estimate!); end = start + duration;
        copy.forecastStartMinutes = start; copy.forecastEndMinutes = end;
      }
    } else if (stop.status === 'planned' || !stop.status) {
      const leg = previous && snapshot.routeLegs?.find(item => item.fromStopId === previous!.stopId && item.toStopId === stop.stopId && (!stop.preferredTransportMode || item.transportMode === stop.preferredTransportMode));
      const transfer = routeTravelMinutes(leg || undefined);
      copy.transferTimeUnknown = Boolean(previous && transfer === null);
      const locked = stop.lockTime || stop.timeLocked || snapshot.constraints?.some(constraint => constraint.kind === 'lock_time' && constraint.payload.stopId === stop.stopId);
      if (previousEnd !== undefined) {
        const earliest = previousEnd + (transfer ?? 0);
        if (!locked) start = Math.max(start, earliest);
        else copy.forecastConflict = earliest > start;
      }
      end = start + duration;
      copy.forecastStartMinutes = start; copy.forecastEndMinutes = end;
    }
    if (['en_route', 'visiting'].includes(stop.status || '') && now) {
      const current = eventMinutes(now, snapshot, stop);
      copy.executionOverdue = current !== null && current > end;
      if (stop.status === 'visiting') {
        end = Math.max(end, current ?? end);
        copy.forecastEndMinutes = end;
      }
    }
    if (stop.status === 'completed') end = completion ?? end;
    projected.set(stop.stopId, copy);
    previous = stop; previousEnd = end;
  }
  return (snapshot.stops || []).map(stop => projected.get(stop.stopId)!);
}
