import type { PlanStop, TripSnapshot } from './types.js';
import { isDeepStrictEqual } from 'node:util';
import { findStopTimeConflict, normalizePlanStop } from './normalize.js';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateKey(value: string): boolean {
  if (!DATE_KEY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 候选可以重排未来，但必须携带完整的执行事实。 */
export function preserveExecutedStops(candidate: readonly PlanStop[] = [], current: readonly PlanStop[] = []): PlanStop[] {
  const facts = current.filter((stop) => stop.status && stop.status !== 'planned');
  const protectedIds = new Set(facts.map((stop) => stop.stopId));
  return structuredClone([...facts, ...candidate.filter((stop) => !protectedIds.has(stop.stopId)).map(stop => ({ ...stop, status: 'planned' as const }))]);
}

export function tripClock(snapshot: TripSnapshot, now: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: snapshot.timezone || 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(new Date(now));
  const part = (name: string) => parts.find((item) => item.type === name)?.value || '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const travelDate = snapshot.travelDate || snapshot.localDate || snapshot.tripSettings?.localDate;
  return { now, date, travelDate, minutes: Number(part('hour')) * 60 + Number(part('minute')),
    relation: !travelDate ? 'unknown' : travelDate < date ? 'past' : travelDate > date ? 'future' : 'today' };
}

export function checkPlanBoundary(
  current: TripSnapshot,
  next: TripSnapshot,
  now: string,
  options: { allowPast?: boolean } = {},
) {
  const clock = tripClock(next, now);
  const oldClock = tripClock(current, now);
  const oldStops = current.stops || [];
  const nextStops = next.stops || [];
  if (nextStops.some((stop) => stop.date !== undefined && !isValidDateKey(stop.date))) {
    return '地点日期无效，请选择有效的日历日期。';
  }
  // 多日化：站点的有效日期（未带日期的站点沿用旅行起始日）。
  const stopDay = (stop: { date?: string }) => stop.date ?? clock.travelDate;
  const stopDayOfOld = (stop: { date?: string }) => stop.date ?? oldClock.travelDate;
  // 深比较前对齐日期缺省：两侧站点经同一缺省规则归一，避免“日期字段有无”造成误判。
  const alignDate = (stop: PlanStop, fallback?: string) => ({ ...normalizePlanStop(stop), date: stop.date ?? fallback });
  for (const stop of oldStops.filter((item) => item.status && item.status !== 'planned')) {
    const replacement = nextStops.find((item) => item.stopId === stop.stopId);
    if (!replacement || !isDeepStrictEqual(alignDate(normalizePlanStop(replacement), clock.travelDate), alignDate(normalizePlanStop(stop), oldClock.travelDate)) || oldClock.travelDate !== clock.travelDate || (current.timezone || 'Asia/Shanghai') !== (next.timezone || 'Asia/Shanghai')) return '已发生的进度必须完整保留，不能在调整计划时删除或改写。';
  }
  if (nextStops.some(stop => stop.status && stop.status !== 'planned' && !oldStops.some(old => old.stopId === stop.stopId && old.status === stop.status))) return '请通过记录进度确认完成，不能通过改计划制造执行记录。';
  for (const stop of nextStops.filter((item) => !item.status || item.status === 'planned')) {
    const old = oldStops.find((item) => item.stopId === stop.stopId);
    const oldPlan = old ? normalizePlanStop(old) : undefined;
    const nextPlan = normalizePlanStop(stop);
    if (stop.travelStartMinutes !== undefined) {
      const departure = stop.travelStartMinutes;
      if (!Number.isInteger(departure) || departure < 0 || departure >= (stop.endMinutes ?? 1440) || departure > (stop.startMinutes ?? 1440)) return '出发时间必须有效且早于预计离开时间。';
      const date = stopDay(stop);
      const activeStops = nextStops.filter(item => item.status !== 'skipped' && stopDay(item) === date);
      const previous = activeStops[activeStops.findIndex(item => item.stopId === stop.stopId) - 1];
      if (previous && departure < (previous.departureMinutes ?? previous.endMinutes ?? 0)) return '下一站出发时间早于上一站预计离开时间，请调整相邻节点时间。';
      const leg = (next.routeLegs || []).find(item => item.toStopId === stop.stopId && (previous ? item.fromStopId === previous.stopId : !nextStops.some(origin => origin.stopId === item.fromStopId)));
      const duration = leg?.durationMinutes ?? (leg?.durationSeconds != null ? leg.durationSeconds / 60 : undefined);
      const buffer = leg?.bufferMinutes ?? 0;
      if (duration !== undefined && Number.isFinite(duration) && duration >= 0 && Number.isFinite(buffer) && buffer >= 0 && departure + Math.ceil(duration + buffer) > (stop.startMinutes ?? 1440)) return '出发时间与交通时长无法衔接当前安排，请重新规划路线或调整节点时间。';
      if (!options.allowPast && (!old || old.travelStartMinutes !== departure || stopDayOfOld(stop) !== date) && date && (date < clock.date || (date === clock.date && departure < clock.minutes))) return '出发时间不能早于当前时间。';
    }
    const scheduleFields: Array<keyof PlanStop> = [
      'date', 'travelStartMinutes', 'plannedArrivalMinutes', 'startMinutes', 'plannedStartMinutes',
      'endMinutes', 'departureMinutes', 'plannedDepartureMinutes', 'plannedDurationMinutes',
      'minDurationMinutes', 'durationSeconds', 'minDurationSeconds', 'visitWindow',
    ];
    const changedSchedule = !oldPlan || scheduleFields.some((field) =>
      !isDeepStrictEqual(oldPlan[field], nextPlan[field])) ||
      oldPlan.placeId !== nextPlan.placeId || oldPlan.place?.placeId !== nextPlan.place?.placeId;
    const changedTime = changedSchedule || oldClock.travelDate !== clock.travelDate;
    if (changedSchedule) {
      const start = nextPlan.startMinutes;
      const end = nextPlan.endMinutes;
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        return '时间安排无效，请检查开始时间、结束时间和所属日期。';
      }
    }
    const date = stopDay(stop);
    if (!options.allowPast && changedTime && date && (date < clock.date || (date === clock.date && (stop.startMinutes ?? 0) < clock.minutes))) return '新安排不能放在当前时间之前，请把尚未完成的活动调整到之后的时间。';
  }
  const overlap = findStopTimeConflict(nextStops, clock.travelDate);
  if (overlap) {
    const name = (stopId: string) => nextStops.find((stop) => stop.stopId === stopId)?.place?.name || stopId;
    return `「${name(overlap.firstStopId)}」与「${name(overlap.secondStopId)}」的时间重叠，进度、进行中和计划中的地点不能占用同一时段。`;
  }
  return null;
}
