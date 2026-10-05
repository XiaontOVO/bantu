import type {
  ExecutionEvent,
  ExecutionEventType,
  PlanStop,
  SpendEvent,
  StopStatus,
  TripSnapshot,
  WalkingEvent,
} from './types.js';
import { getStopStart, normalizeTripSnapshot, sortStopsChronologically } from './normalize.js';
import { departureBaseline, executionTriggerTimes, routeTravelMinutes } from './execution-schedule.js';

export interface ExecutionMutationResult {
  ok: boolean;
  snapshot?: TripSnapshot;
  event?: ExecutionEvent;
  error?: { code: string; message: string };
}

const TRANSITIONS: Record<StopStatus, readonly ExecutionEventType[]> = {
  planned: ['depart', 'arrive', 'complete', 'skip'],
  en_route: ['arrive', 'abort', 'skip'],
  visiting: ['complete'],
  completed: [],
  skipped: [],
};

const STATUS_TEXT: Record<StopStatus, string> = {
  planned: '待出发', en_route: '前往中', visiting: '游览中', completed: '已完成', skipped: '已跳过',
};

const ACTION_TEXT: Record<ExecutionEventType, string> = {
  depart: '出发', arrive: '到达', complete: '完成', skip: '跳过', abort: '中止',
};

const stopLabel = (stop: { stopId: string; place?: { name?: string } }) => stop.place?.name || stop.stopId;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isValidTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP.test(value)) return false;
  const dateKey = value.slice(0, 10);
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateKey;
}

/** 事件时间转行程当地日期与分钟；无效返回 null。 */
function localTimeInTripZone(occurredAt: string, timezone: string): { date: string; minute: number } | null {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = value('year'); const month = value('month'); const day = value('day');
    const h = Number(parts.find((part) => part.type === 'hour')?.value);
    const m = Number(parts.find((part) => part.type === 'minute')?.value);
    if (year && month && day && Number.isFinite(h) && Number.isFinite(m)) {
      return { date: `${year}-${month}-${day}`, minute: h * 60 + m };
    }
  } catch { /* 未知时区时不做对齐 */ }
  return null;
}

function minutesOnDate(localTime: { date: string; minute: number }, date?: string): number | null {
  if (!date) return localTime.minute;
  const targetDay = Date.parse(`${date}T00:00:00.000Z`);
  const eventDay = Date.parse(`${localTime.date}T00:00:00.000Z`);
  if (!Number.isFinite(targetDay) || !Number.isFinite(eventDay)) return null;
  return Math.round((eventDay - targetDay) / 86400000) * 1440 + localTime.minute;
}

function stopDate(stop: PlanStop, snapshot: TripSnapshot): string | undefined {
  return stop.date ?? snapshot.travelDate ?? snapshot.localDate;
}

function addCalendarDays(date: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(days)) return null;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + days * 86_400_000);
  return Number.isFinite(shifted.getTime()) ? shifted.toISOString().slice(0, 10) : null;
}

function hasTimeLock(snapshot: TripSnapshot, stop: PlanStop): boolean {
  return Boolean(stop.lockTime || stop.timeLocked) || (snapshot.constraints ?? []).some(
    (constraint) => constraint.kind === 'lock_time' && constraint.payload.stopId === stop.stopId,
  );
}

const SCHEDULE_MINUTE_FIELDS = [
  'travelStartMinutes', 'plannedArrivalMinutes', 'startMinutes', 'plannedStartMinutes',
  'endMinutes', 'departureMinutes', 'plannedDepartureMinutes',
  'plannedTravelStartMinutes',
] as const;

/**
 * 规则 T1/T6/T7（docs/计划与进度三态转换逻辑.md）：执行后的时间表不得留下区间重叠。
 * 可移动的「计划」站点按队列顺序推到前一站结束之后，时长与站间间隔守恒；顺延跨过
 * 午夜的站点推进日期并归一化分钟数（跨天归日，日计划模式由服务层迁入次日计划对象）。
 * 已完成 / 进行中 / 锁定站点是事实或约束，不移动；它们彼此之间的重叠无法自动消解，
 * 标记 needs_review 交由用户处理，而不是拒绝进度记录。
 */
function resolveStopOverlaps(
  stops: readonly PlanStop[],
  snapshot: TripSnapshot,
): { stops: PlanStop[]; needsReview: boolean } {
  const fallbackDate = snapshot.travelDate ?? snapshot.localDate ?? snapshot.tripSettings?.localDate;
  const hasSchedule = (stop: PlanStop) =>
    SCHEDULE_MINUTE_FIELDS.some((field) => Number.isFinite(Number(stop[field])));
  type Entry = { index: number; day: number; start: number; end: number; movable: boolean };
  const entries: Entry[] = [];
  stops.forEach((stop, index) => {
    if ((stop.status ?? 'planned') === 'skipped' || !hasSchedule(stop)) return;
    const date = stopDate(stop, snapshot) ?? fallbackDate ?? '';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? Date.parse(`${date}T00:00:00.000Z`) / 86_400_000
      : 0;
    if (!Number.isFinite(day)) return;
    const start = stop.status === 'en_route' && Number.isFinite(stop.travelStartMinutes) ? stop.travelStartMinutes! : getStopStart(stop);
    const plannedDuration = Math.max(0, Number(stop.plannedDurationMinutes) || 0);
    // en_route（前往中）的到达时刻未知：只按已出发时刻占位，不把「计划」站点推到
    // 估计结束之后——真正的占用时长在到达事件里按实际值顺延（文档 §3 T4）。
    const end = stop.status === 'en_route' ? start : Number.isFinite(Number(stop.endMinutes))
      ? Number(stop.endMinutes)
      : start + plannedDuration;
    if (end < start) return;
    const movable = (stop.status ?? 'planned') === 'planned' && !hasTimeLock(snapshot, stop);
    entries.push({ index, day, start: day * 1440 + start, end: day * 1440 + end, movable });
  });
  // T6 乱序重排：队列按实际执行顺序排列——已触发执行的站点按首次触发时刻排序，
  // 未触发的「计划」站点保持原相对顺序跟在后面。消解沿该顺序推进。
  const firstTrigger = executionTriggerTimes(snapshot.executionEvents ?? []);
  const originalIndex = new Map(stops.map((stop, index) => [stop.stopId, stop.originalPlanOrder ?? index] as const));
  entries.sort((left, right) => {
    const leftStop = stops[left.index];
    const rightStop = stops[right.index];
    const leftTriggered = firstTrigger.has(leftStop.stopId);
    const rightTriggered = firstTrigger.has(rightStop.stopId);
    if (leftTriggered !== rightTriggered) return leftTriggered ? -1 : 1;
    if (leftTriggered && rightTriggered) {
      const diff = (firstTrigger.get(leftStop.stopId) ?? 0) - (firstTrigger.get(rightStop.stopId) ?? 0);
      if (diff !== 0) return diff;
    }
    return (originalIndex.get(leftStop.stopId) ?? 0) - (originalIndex.get(rightStop.stopId) ?? 0) ||
      left.day - right.day || left.start - right.start || left.index - right.index;
  });

  let needsReview = false;
  const shiftByIndex = new Map<number, number>();
  let prevEnd = Number.NEGATIVE_INFINITY;
  let previousStop: PlanStop | undefined;
  for (const entry of entries) {
    const currentStop = stops[entry.index];
    const leg = previousStop && snapshot.routeLegs?.find(leg => leg.fromStopId === previousStop!.stopId && leg.toStopId === currentStop.stopId);
    const transfer = previousStop?.status === 'en_route' ? 0 : routeTravelMinutes(leg || undefined) ?? 0;
    const earliestStart = prevEnd + transfer;
    if (Number.isFinite(prevEnd) && entry.start < earliestStart) {
      if (!entry.movable) needsReview = true;
      else {
        const duration = entry.end - entry.start;
        shiftByIndex.set(entry.index, earliestStart - entry.start);
        entry.start = earliestStart;
        entry.end = earliestStart + duration;
      }
    }
    prevEnd = Math.max(Number.isFinite(prevEnd) ? prevEnd : entry.start, entry.end);
    previousStop = currentStop;
  }

  const resolved = stops.map((stop, index) => {
    const shift = shiftByIndex.get(index);
    if (shift === undefined || shift === 0) return stop;
    let invalid = false;
    const shifted: PlanStop = { ...stop };
    for (const field of SCHEDULE_MINUTE_FIELDS) {
      const value = stop[field];
      if (value === undefined || value === null) continue;
      const shiftedValue = Number(value) + shift;
      if (!Number.isFinite(shiftedValue)) invalid = true;
      else shifted[field] = shiftedValue;
    }
    if (invalid) { needsReview = true; return stop; }
    return shifted;
  });

  const normalized = resolved.map((stop) => {
    // 只迁移尚未开始的「计划」站点；已出发 / 游览中 / 已完成的站点钉在当天的计划里，
    // 直到访问结束由归档流程接管（跨午夜计划保持可执行的产品语义）。
    if ((stop.status ?? 'planned') !== 'planned') return stop;
    // 归属日只看起始时间（文档 T7：「地点起始时间到了第二天」迁入次日计划）；
    // 起始仍在当天的跨午夜游览（23:50 开始、00:20 结束）留在当天，按超长区间展示。
    const startRef = Number(stop.startMinutes ?? stop.plannedStartMinutes ?? stop.plannedArrivalMinutes ?? stop.travelStartMinutes ?? NaN);
    if (!Number.isFinite(startRef) || startRef < 1440) return stop;
    const dayOffset = Math.floor(startRef / 1440);
    const baseDate = stopDate(stop, snapshot) ?? fallbackDate;
    if (!baseDate || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) return stop;
    const shiftedDate = addCalendarDays(baseDate, dayOffset);
    if (!shiftedDate) { needsReview = true; return stop; }
    let invalid = false;
    const shifted: PlanStop = { ...stop, date: shiftedDate };
    for (const field of SCHEDULE_MINUTE_FIELDS) {
      const value = stop[field];
      if (value === undefined || value === null) continue;
      const normalizedValue = Number(value) - dayOffset * 1440;
      if (!Number.isFinite(normalizedValue)) { invalid = true; break; }
      // 前一天的实际出发事实迁入次日时归零，不保留负值。
      shifted[field] = Math.max(0, normalizedValue);
    }
    if (invalid) { needsReview = true; return stop; }
    return shifted;
  });

  return { stops: normalized, needsReview };
}

export function isActiveStopStatus(status: StopStatus): boolean {
  return status === 'en_route' || status === 'visiting';
}

export function canApplyExecutionAction(current: StopStatus, type: ExecutionEventType): boolean {
  return TRANSITIONS[current].includes(type);
}

export function nextStopStatus(current: StopStatus, type: ExecutionEventType): StopStatus | null {
  if (!canApplyExecutionAction(current, type)) return null;
  switch (type) {
    case 'depart':
      return 'en_route';
    case 'arrive':
      return 'visiting';
    case 'complete':
      return 'completed';
    case 'skip':
      return 'skipped';
    case 'abort':
      return 'planned';
  }
}

function findStop(snapshot: TripSnapshot, stopId: string): PlanStop | undefined {
  return (snapshot.stops ?? []).find((stop) => stop.stopId === stopId);
}

function otherActiveStop(
  stops: readonly PlanStop[],
  exceptStopId: string,
): PlanStop | undefined {
  return stops.find(
    (stop) => stop.stopId !== exceptStopId && isActiveStopStatus(stop.status ?? 'planned'),
  );
}

/**
 * 记录一次用户报告的执行事件，返回状态更新后的快照。
 * 不自动把导航跳转当作到达；occurredAt 由调用方按旅行时钟提供。
 */
export function applyExecutionEvent(
  snapshotInput: TripSnapshot,
  input: {
    stopId: string;
    type: ExecutionEventType;
    planId?: string;
    occurredAt: string;
    recordedAt?: string;
    executionEventId?: string;
    correctsEventId?: string | null;
    userReported?: boolean;
  },
): ExecutionMutationResult {
  const snapshot = normalizeTripSnapshot(snapshotInput);
  snapshot.stops = (snapshot.stops || []).map((stop, index) => ({ ...stop, originalPlanOrder: stop.originalPlanOrder ?? index }));
  if (!isValidTimestamp(input.occurredAt)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: '进度时间必须是有效的日期时间，并包含时区。' } };
  }
  const stop = findStop(snapshot, input.stopId);
  if (!stop) {
    return { ok: false, error: { code: 'STOP_NOT_FOUND', message: '节点不存在。' } };
  }

  const currentStatus = stop.status ?? 'planned';
  const nextStatus = nextStopStatus(currentStatus, input.type);
  if (nextStatus === null) {
    return {
      ok: false,
      error: {
        code: 'INVALID_EXECUTION_TRANSITION',
        message: `「${stopLabel(stop)}」当前是「${STATUS_TEXT[currentStatus]}」，不能执行「${ACTION_TEXT[input.type]}」。`,
      },
    };
  }

  if (isActiveStopStatus(nextStatus)) {
    const conflict = otherActiveStop(snapshot.stops, stop.stopId);
    if (conflict) {
      return {
        ok: false,
        error: {
          code: 'ACTIVE_STOP_CONFLICT',
          message: `「${stopLabel(conflict)}」正在${STATUS_TEXT[conflict.status ?? 'planned']}；同一时间只能有一个地点在进行中，请先「完成」或「中止」它。`,
        },
      };
    }
  }

  const localTime = localTimeInTripZone(input.occurredAt, snapshot.timezone || 'Asia/Shanghai');
  const nowMinutes = localTime && minutesOnDate(localTime, stopDate(stop, snapshot));
  if (nowMinutes === null || nowMinutes === undefined) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: '行程时区无效，无法记录进度时间。' } };
  }
  if ((input.type === 'complete' && currentStatus === 'visiting' && nowMinutes < getStopStart(stop)) ||
    (input.type === 'arrive' && currentStatus === 'en_route' && Number.isFinite(stop.travelStartMinutes) && nowMinutes < stop.travelStartMinutes!)) {
    return { ok: false, error: { code: 'EXECUTION_TIME_CONFLICT', message: '实际时间顺序不正确：到达不能早于出发，完成不能早于到达。请纠正相关进度。' } };
  }

  const event: ExecutionEvent = {
    executionEventId:
      input.executionEventId ?? `exec_${input.stopId}_${input.type}_${input.occurredAt}`,
    ...(input.planId ? { planId: input.planId } : { tripId: snapshot.tripId }),
    stopId: input.stopId,
    type: input.type,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    correctsEventId: input.correctsEventId ?? null,
    userReported: input.userReported ?? true,
  };

  // 出发/到达/完成把对应计划时间对齐到实际时间；离开本站后顺延同日仍待进行的站点。
  const oldDeparture = [stop.departureMinutes, stop.plannedDepartureMinutes, stop.endMinutes]
    .find((value): value is number => Number.isFinite(value));
  const nextStops = (snapshot.stops ?? []).map((item) => {
    if (item.stopId !== stop.stopId) return item;
    const aligned: PlanStop = { ...item, status: nextStatus };
    if (input.type === 'depart') {
      aligned.travelStartMinutes = nowMinutes;
      aligned.propagatedDepartureDelayMinutes = Math.max(item.propagatedDepartureDelayMinutes || 0, nowMinutes - departureBaseline(item, snapshot));
    } else if (input.type === 'arrive') {
      delete aligned.propagatedDepartureDelayMinutes;
      aligned.plannedArrivalMinutes = nowMinutes;
      aligned.startMinutes = nowMinutes;
      const plannedDuration = Number(item.plannedDurationMinutes);
      const fallbackDuration = Math.max(0, Number(item.endMinutes ?? nowMinutes) - Number(item.startMinutes ?? nowMinutes));
      // R24：计划预计窗口最多 24 小时，真实完成时刻由完成事件记录。
      const duration = Math.min(24 * 60, Number.isFinite(plannedDuration) && plannedDuration > 0 ? plannedDuration : fallbackDuration);
      if (duration > 0) {
        aligned.endMinutes = nowMinutes + duration;
        aligned.departureMinutes = aligned.endMinutes;
      }
    } else if (input.type === 'complete') {
      // 直达完成没有到达事实：记录完成这个时刻，不把计划开始冒充实际到达。
      if (currentStatus === 'planned') aligned.startMinutes = nowMinutes;
      aligned.endMinutes = nowMinutes;
      aligned.departureMinutes = aligned.endMinutes;
    } else if (input.type === 'abort') {
      delete aligned.travelStartMinutes;
      delete aligned.estimatedTravelMinutes;
      delete aligned.estimatedTransportMode;
    }
    return aligned;
  });
  // 出发基准是前往本站的计划时刻（显式值或到达减路线耗时），不是离开本站。
  // 到达扣除出发已传播的延误，完成再按新增延误顺延；只延后不提前。
  let delta = 0;
  if (input.type === 'depart') {
    delta = nowMinutes - departureBaseline(stop, snapshot) - (stop.propagatedDepartureDelayMinutes || 0);
  } else {
    const updatedStop = nextStops.find((item) => item.stopId === stop.stopId);
    const newDeparture = updatedStop && [updatedStop.departureMinutes, updatedStop.plannedDepartureMinutes, updatedStop.endMinutes]
      .find((value): value is number => Number.isFinite(value));
    if (oldDeparture !== undefined && newDeparture !== undefined) delta = newDeparture - oldDeparture -
      (input.type === 'arrive' ? stop.propagatedDepartureDelayMinutes || 0 : 0);
  }
  delta = Math.max(0, delta);

  // 顺延同一计划日后续待进行站点（T4）。跳过的站点不占时间；锁定/已发生的站点不移动
  // 但也不中断顺延（文档 §7-Q4），它们与顺延结果的冲突由 resolveStopOverlaps 统一消解（T6）。
  let needsReview = false;
  const stops = snapshot.stops ?? [];
  const stopPosition = stops.findIndex((item) => item.stopId === stop.stopId);
  if (delta > 0 && stopPosition >= 0) {
    for (let index = stopPosition + 1; index < stops.length; index += 1) {
      const next = stops[index];
      if ((stopDate(next, snapshot) ?? null) !== (stopDate(stop, snapshot) ?? null)) break;
      if (next.status === 'skipped') continue;
      if ((next.status ?? 'planned') !== 'planned' || hasTimeLock(snapshot, next)) continue;
      const shifted: PlanStop = { ...next };
      let hasScheduleTime = false;
      for (const field of SCHEDULE_MINUTE_FIELDS) {
        const value = next[field];
        if (value === undefined || value === null) continue;
        const shiftedValue = Number(value) + delta;
        if (!Number.isFinite(shiftedValue) || shiftedValue < 0) {
          needsReview = true;
          break;
        }
        shifted[field] = shiftedValue;
        hasScheduleTime = true;
      }
      if (needsReview) break;
      if (hasScheduleTime) nextStops[index] = shifted;
    }
  }

  // T1/T6 冲突消解：可移动的「计划」站点按队列顺序推到前一站结束之后（时长与站间间隔
  // 守恒）；跨过午夜的站点按 T7 推进日期。无法消解的重叠（只可能发生在事实/约束站点
  // 之间）标记 needs_review，由用户手动处理，而不是拒绝进度记录。
  const resolved = resolveStopOverlaps(nextStops, { ...snapshot, executionEvents: [...(snapshot.executionEvents ?? []), event] });
  needsReview = needsReview || resolved.needsReview;
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      stops: resolved.stops,
      ...(needsReview ? { planningStatus: 'needs_review' as const } : {}),
      executionEvents: [...(snapshot.executionEvents ?? []), event],
      version: (snapshot.version ?? 0) + 1,
    },
    event,
  };
}

export interface ReplayResult {
  stops: PlanStop[];
  effectiveEvents: ExecutionEvent[];
  errors: { eventId: string; code: string; message: string }[];
}

/**
 * 从 planned 基线重放事件。被 correctsEventId 指向的旧事件不再生效，
 * 从而保证误点“完成”可由独立纠正操作修正。
 */
export function replayExecutionEvents(
  stops: readonly PlanStop[],
  events: readonly ExecutionEvent[],
): ReplayResult {
  const orderedStops = sortStopsChronologically(stops);
  const correctedIds = new Set(
    events
      .map((event) => event.correctsEventId)
      .filter((value): value is string => Boolean(value)),
  );
  const effectiveEvents = events
    .filter((event) => !correctedIds.has(event.executionEventId))
    .sort((a, b) => {
      const timeA = Date.parse(a.occurredAt);
      const timeB = Date.parse(b.occurredAt);
      if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) return timeA - timeB;
      return a.recordedAt.localeCompare(b.recordedAt);
    });

  const statusByStop = new Map(orderedStops.map((stop) => [stop.stopId, 'planned' as StopStatus]));
  const labelOf = (stopId: string) => stopLabel(orderedStops.find((stop) => stop.stopId === stopId) ?? { stopId });
  const errors: ReplayResult['errors'] = [];
  for (const event of effectiveEvents) {
    const current = statusByStop.get(event.stopId);
    if (!current) {
      errors.push({ eventId: event.executionEventId, code: 'STOP_NOT_FOUND', message: '节点不存在。' });
      continue;
    }
    const next = event.correctsEventId && event.statusOverride ? event.statusOverride : nextStopStatus(current, event.type);
    if (next === null) {
      errors.push({
        eventId: event.executionEventId,
        code: 'INVALID_EXECUTION_TRANSITION',
        message: `「${labelOf(event.stopId)}」处于「${STATUS_TEXT[current]}」，无法执行「${ACTION_TEXT[event.type]}」。`,
      });
      continue;
    }
    if (isActiveStopStatus(next)) {
      const active = [...statusByStop.entries()].find(
        ([stopId, status]) => stopId !== event.stopId && isActiveStopStatus(status),
      );
      if (active) {
        errors.push({
          eventId: event.executionEventId,
          code: 'ACTIVE_STOP_CONFLICT',
          message: `「${labelOf(active[0])}」仍在进行中；同一时间只能有一个地点在进行中。`,
        });
        continue;
      }
    }
    statusByStop.set(event.stopId, next);
  }

  return {
    stops: orderedStops.map((stop) => ({
      ...stop,
      status: statusByStop.get(stop.stopId) ?? 'planned',
    })),
    effectiveEvents,
    errors,
  };
}

/** 记录一次纠正事件；被纠正事件在重放时不再生效。 */
export function applyExecutionCorrection(
  snapshotInput: TripSnapshot,
  input: {
    eventIdToCorrect: string;
    type: ExecutionEventType;
    planId?: string;
    statusOverride?: StopStatus;
    correctionReason?: string;
    occurredAt?: string;
    recordedAt?: string;
    executionEventId?: string;
  },
): ExecutionMutationResult {
  const snapshot = normalizeTripSnapshot(snapshotInput);
  const events = snapshot.executionEvents ?? [];
  const target = events.find((event) => event.executionEventId === input.eventIdToCorrect);
  if (!target) {
    return { ok: false, error: { code: 'EVENT_NOT_FOUND', message: '被纠正的执行事件不存在。' } };
  }
  if (events.some(event => event.correctsEventId === target.executionEventId)) return {ok:false, error:{code:'REVISION_CONFLICT', message:'这条进度已被纠正，请刷新后选择最新记录。'}};
  if (input.statusOverride !== undefined && !['planned','en_route','visiting','completed','skipped'].includes(input.statusOverride)) return {ok:false,error:{code:'INVALID_INPUT',message:'请选择有效进度。'}};
  if (!isValidTimestamp(input.occurredAt ?? target.occurredAt)) return {ok:false,error:{code:'INVALID_INPUT',message:'进度时间必须是有效的日期时间，并包含时区。'}};
  const correction: ExecutionEvent = {
    statusOverride: input.statusOverride,
    correctionReason: input.correctionReason?.trim().slice(0, 500),
    executionEventId:
      input.executionEventId ??
      `correction_${target.executionEventId}_${Date.now().toString(36)}`,
    ...(input.planId ? { planId: input.planId } : { tripId: snapshot.tripId }),
    stopId: target.stopId,
    type: input.type,
    occurredAt: input.occurredAt ?? target.occurredAt,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    correctsEventId: target.executionEventId,
    userReported: true,
  };
  const nextEvents = [...events, correction];
  const previousReplay = replayExecutionEvents(snapshot.stops ?? [], events);
  const replay = replayExecutionEvents(snapshot.stops ?? [], nextEvents);
  const previousErrorKeys = new Set(previousReplay.errors.map((error) => JSON.stringify(error)));
  const introducedErrors = replay.errors.filter((error) => !previousErrorKeys.has(JSON.stringify(error)));
  if (introducedErrors.length) return {ok:false,error:{code:'INVALID_EXECUTION_TRANSITION',message:'纠正后会与其他进度冲突，请先纠正相关记录；同一时间只能有一个正在进行的地点。'}};
  let correctedStops = replay.stops;
  const latest = replay.effectiveEvents.filter(event => event.stopId === target.stopId).at(-1);
  const correctedStop = replay.stops.find(stop => stop.stopId === target.stopId);
  if (input.occurredAt && latest?.executionEventId === correction.executionEventId && correctedStop?.status === 'completed') {
    // Replacing a completion timestamp changes the remaining schedule by only
    // the difference from the already applied completion, not from the old plan.
    const aligned = applyExecutionEvent({ ...snapshot, stops: replay.stops.map(stop => stop.stopId === target.stopId ? { ...stop, status: 'visiting' } : stop) }, {
      stopId: target.stopId, type: 'complete', occurredAt: correction.occurredAt, recordedAt: correction.recordedAt,
    });
    if (!aligned.ok || !aligned.snapshot) return aligned;
    correctedStops = aligned.snapshot.stops || replay.stops;
  }
  // 纠正后的时间表同样做冲突消解与跨天归日（T1/T6/T7），不再拒绝记录。
  const resolvedCorrection = resolveStopOverlaps(correctedStops, { ...snapshot, executionEvents: nextEvents });
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      stops: resolvedCorrection.stops,
      ...(resolvedCorrection.needsReview ? { planningStatus: 'needs_review' as const } : {}),
      executionEvents: nextEvents,
      version: (snapshot.version ?? 0) + 1,
    },
    event: correction,
  };
}

/** 开始记录旅行：至少一个节点；needs_review 不会被自动改写。 */
export function startTrip(snapshotInput: TripSnapshot): ExecutionMutationResult {
  const snapshot = normalizeTripSnapshot(snapshotInput);
  if ((snapshot.stops ?? []).length === 0) {
    return { ok: false, error: { code: 'INVALID_TRIP_STATE', message: '没有节点不能开始记录。' } };
  }
  if (snapshot.lifecycle !== 'draft') {
    return { ok: false, error: { code: 'INVALID_TRIP_STATE', message: '只有草稿旅行可以开始记录。' } };
  }
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      lifecycle: 'active',
      version: (snapshot.version ?? 0) + 1,
    },
  };
}

export function finishTrip(snapshotInput: TripSnapshot): ExecutionMutationResult {
  const snapshot = normalizeTripSnapshot(snapshotInput);
  if (snapshot.lifecycle !== 'active') {
    return { ok: false, error: { code: 'INVALID_TRIP_STATE', message: '只有进行中的旅行可以结束。' } };
  }
  const active = (snapshot.stops ?? []).find((stop) =>
    isActiveStopStatus(stop.status ?? 'planned'),
  );
  if (active) {
    return {
      ok: false,
      error: { code: 'INVALID_TRIP_STATE', message: `节点「${active.stopId}」尚未结束。` },
    };
  }
  const pending = (snapshot.stops ?? []).find((stop) => (stop.status ?? 'planned') === 'planned');
  if (pending) {
    return {
      ok: false,
      error: { code: 'INVALID_TRIP_STATE', message: `节点「${pending.stopId}」仍待进行，请完成或跳过后再结束行程。` },
    };
  }
  return {
    ok: true,
    snapshot: { ...snapshot, lifecycle: 'completed', version: (snapshot.version ?? 0) + 1 },
  };
}

export function archiveTrip(snapshotInput: TripSnapshot): ExecutionMutationResult {
  const snapshot = normalizeTripSnapshot(snapshotInput);
  if (snapshot.lifecycle !== 'draft' && snapshot.lifecycle !== 'completed') {
    return { ok: false, error: { code: 'INVALID_TRIP_STATE', message: '进行中的旅行不能归档。' } };
  }
  return {
    ok: true,
    snapshot: { ...snapshot, lifecycle: 'archived', version: (snapshot.version ?? 0) + 1 },
  };
}

export interface FactRecordResult {
  ok: boolean;
  snapshot?: TripSnapshot;
  spendEvent?: SpendEvent;
  walkingEvent?: WalkingEvent;
  error?: { code: string; message: string };
}

/** 记录全团累计已花费；普通读取不因此改变，真实事实使 revision 递增。 */
export function recordSpendEvent(
  snapshotInput: TripSnapshot,
  input: {
    amountMinor: number;
    currency?: string;
    occurredAt: string;
    recordedAt?: string;
    completenessConfirmed: boolean;
    includedChargeIds?: string[];
    spendEventId?: string;
    correctsEventId?: string | null;
  },
): FactRecordResult {
  const snapshot = normalizeTripSnapshot(snapshotInput);
  if (!Number.isFinite(input.amountMinor) || input.amountMinor < 0 || !isValidTimestamp(input.occurredAt)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: '已花费金额或记录时间无效。' } };
  }
  const event: SpendEvent = {
    spendEventId: input.spendEventId ?? `spend_${Date.now().toString(36)}`,
    tripId: snapshot.tripId,
    amountMinor: input.amountMinor,
    currency: input.currency ?? snapshot.budget?.currency ?? 'CNY',
    basis: 'party',
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    completenessConfirmed: input.completenessConfirmed,
    includedChargeIds: input.includedChargeIds ?? [],
    correctsEventId: input.correctsEventId ?? null,
  };
  return {
    ok: true,
    spendEvent: event,
    snapshot: {
      ...snapshot,
      actualSpendMinor: event.amountMinor,
      actualSpendComplete: event.completenessConfirmed,
      spendRef: event.spendEventId,
      spendEvents: [...(snapshot.spendEvents ?? []), event],
      version: (snapshot.version ?? 0) + 1,
    },
  };
}

/** 记录累计实际步行；未知不采用计划距离代替。 */
export function recordWalkingEvent(
  snapshotInput: TripSnapshot,
  input: {
    walkingMeters: number;
    occurredAt: string;
    recordedAt?: string;
    completenessConfirmed: boolean;
    walkingEventId?: string;
    correctsEventId?: string | null;
  },
): FactRecordResult {
  const snapshot = normalizeTripSnapshot(snapshotInput);
  if (!Number.isFinite(input.walkingMeters) || input.walkingMeters < 0 || !isValidTimestamp(input.occurredAt)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: '步行米数或记录时间无效。' } };
  }
  const event: WalkingEvent = {
    walkingEventId: input.walkingEventId ?? `walk_${Date.now().toString(36)}`,
    tripId: snapshot.tripId,
    walkingMeters: input.walkingMeters,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    completenessConfirmed: input.completenessConfirmed,
    correctsEventId: input.correctsEventId ?? null,
  };
  return {
    ok: true,
    walkingEvent: event,
    snapshot: {
      ...snapshot,
      actualWalkingMeters: event.walkingMeters,
      actualWalkingComplete: event.completenessConfirmed,
      walkingRef: event.walkingEventId,
      walkingEvents: [...(snapshot.walkingEvents ?? []), event],
      version: (snapshot.version ?? 0) + 1,
    },
  };
}

/** 执行事实不属于规划版本回滚范围；这里只返回事实是否在版本之后发生。 */
export function hasExecutionFactsAfter(
  events: readonly ExecutionEvent[],
  revisionVersion: number,
): boolean {
  // PlanVersion 不保存事件 revision；调用方可用实际事件时间判断。
  return events.length > 0 && revisionVersion < 0;
}
