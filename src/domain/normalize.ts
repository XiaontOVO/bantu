import type {
  PlaceRef,
  PlanStop,
  RouteLeg,
  TravelMode,
  TripSnapshot,
} from './types.js';

const DEFAULT_PLACE: PlaceRef = {
  placeId: 'unknown',
  name: '未知地点',
  coordinates: null,
  facilityCodes: [],
};

export function floorMinutes(value: number): number {
  return Math.max(0, Math.floor(value));
}

export function secondsToMinutes(seconds: number): number {
  return seconds / 60;
}

export function minutesToSeconds(minutes: number): number {
  return minutes * 60;
}

export function getStopPlace(stop: PlanStop): PlaceRef {
  if (stop.place) {
    // place 常常来自手动编辑（POST /trips/:id/plan-edits），客户端只送 placeId／name 是合理的。
    // facilityCodes 必须在这里归一成数组，否则约束检查会出两类错：
    //   - 缺字段 → `undefined.includes` 抛 TypeError，整个请求 500；
    //   - 传字符串 → `.includes` 退化成子串匹配（'no-toilet' 也能匹配 'toilet'），硬约束假通过。
    return {
      ...DEFAULT_PLACE,
      ...stop.place,
      facilityCodes: Array.isArray(stop.place.facilityCodes) ? stop.place.facilityCodes : [],
    };
  }
  return {
    ...DEFAULT_PLACE,
    placeId: stop.placeId ?? stop.stopId,
    name: stop.placeId ?? stop.stopId,
  };
}

export function getStopStart(stop: PlanStop): number {
  return (
    stop.startMinutes ??
    stop.plannedStartMinutes ??
    stop.plannedArrivalMinutes ??
    stop.plannedDepartureMinutes ??
    stop.departureMinutes ??
    0
  );
}

export function getStopEnd(stop: PlanStop): number {
  if (stop.endMinutes !== undefined) return stop.endMinutes;
  if (stop.durationSeconds !== undefined) {
    return getStopStart(stop) + secondsToMinutes(stop.durationSeconds);
  }
  return getStopStart(stop) + getStopDuration(stop);
}

export function getStopArrival(stop: PlanStop): number {
  return stop.plannedArrivalMinutes ?? getStopStart(stop);
}

export function getStopDeparture(stop: PlanStop): number {
  return stop.departureMinutes ?? stop.plannedDepartureMinutes ?? getStopEnd(stop);
}

export function getStopDuration(stop: PlanStop): number {
  if (stop.plannedDurationMinutes !== undefined) return stop.plannedDurationMinutes;
  if (stop.minDurationMinutes !== undefined) return stop.minDurationMinutes;
  if (stop.durationSeconds !== undefined) return secondsToMinutes(stop.durationSeconds);
  if (stop.minDurationSeconds !== undefined) return secondsToMinutes(stop.minDurationSeconds);
  if (stop.endMinutes !== undefined) {
    return Math.max(0, stop.endMinutes - getStopStart(stop));
  }
  return 0;
}

/** 按日期和活动开始时间稳定排序；同一时刻保留原始相对顺序。 */
export function sortStopsChronologically(
  stops: readonly PlanStop[],
  fallbackDate?: string,
): PlanStop[] {
  return stops
    .map((stop, index) => ({
      stop,
      index,
      date: stop.date ?? fallbackDate ?? '',
      start: getStopStart(stop),
    }))
    .sort((left, right) =>
      left.date.localeCompare(right.date) ||
      ((Number.isFinite(left.start) ? left.start : Number.POSITIVE_INFINITY) -
        (Number.isFinite(right.start) ? right.start : Number.POSITIVE_INFINITY)) ||
      left.index - right.index,
    )
    .map(({ stop }) => stop);
}

export interface StopTimeConflict {
  firstStopId: string;
  secondStopId: string;
}

/** 检查进度、进行中和待计划节点合并后的活动区间；跳过的节点不占用时间。 */
export function findStopTimeConflict(
  stops: readonly PlanStop[],
  fallbackDate?: string,
): StopTimeConflict | null {
  const entries = stops.flatMap((stop, index) => {
    if ((stop.status ?? 'planned') === 'skipped') return [];
    const start = getStopStart(stop);
    const end = getStopEnd(stop);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const date = stop.date ?? fallbackDate ?? '';
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const day = date
      ? Date.parse(`${date}T00:00:00.000Z`) / 86_400_000
      : null;
    if (day !== null && !Number.isFinite(day)) return [];
    const absoluteStart = day === null ? start : day * 1440 + start;
    const absoluteEnd = day === null ? end : day * 1440 + end;
    return [{ stopId: stop.stopId, date: day === null ? '' : 'dated', start: absoluteStart, end: absoluteEnd, index }];
  });

  entries.sort((left, right) => left.date.localeCompare(right.date) || left.start - right.start || left.index - right.index);
  let previous: (typeof entries)[number] | undefined;
  for (const current of entries) {
    if (previous && previous.date === current.date && current.start < previous.end) {
      return { firstStopId: previous.stopId, secondStopId: current.stopId };
    }
    if (!previous || previous.date !== current.date || current.end > previous.end) previous = current;
  }
  return null;
}

export function getStopMinDuration(stop: PlanStop): number {
  if (stop.minDurationMinutes !== undefined) return stop.minDurationMinutes;
  if (stop.minDurationSeconds !== undefined) return secondsToMinutes(stop.minDurationSeconds);
  return getStopDuration(stop);
}

export function isRetainStop(stop: PlanStop): boolean {
  return stop.retainStop === true || stop.retain === true;
}

export function isTimeLocked(stop: PlanStop): boolean {
  return stop.timeLocked === true || stop.lockTime === true;
}

export function getRouteDurationMinutes(route: RouteLeg): number | null {
  if (route.durationMinutes !== undefined && route.durationMinutes !== null) {
    if (!Number.isFinite(route.durationMinutes) || route.durationMinutes < 0) return null;
    return route.durationMinutes;
  }
  if (route.durationSeconds !== undefined && route.durationSeconds !== null) {
    if (!Number.isFinite(route.durationSeconds) || route.durationSeconds < 0) return null;
    return secondsToMinutes(route.durationSeconds);
  }
  return null;
}

export function getRouteWalkingMeters(route: RouteLeg): number | null {
  if (route.walkingMeters !== undefined && route.walkingMeters !== null) return route.walkingMeters;
  // 旧字段 walkingMinutes 是分钟，不能无依据地按某个速度换算成米。
  return null;
}

export function getStopSearchText(stop: PlanStop): string {
  return `${stop.stopId} ${getStopPlace(stop).name} ${getStopPlace(stop).placeId}`.toLowerCase();
}

export function normalizeDataMode(value: string | undefined): TravelMode {
  return value === 'online' ? 'online' : 'demo';
}

export type NormalizedTripSnapshot = TripSnapshot &
  Required<
    Pick<
      TripSnapshot,
      | 'tripId'
      | 'dataMode'
      | 'lifecycle'
      | 'planningStatus'
       | 'timezone'
       | 'dayStartMinutes'
       | 'stops'
      | 'routeLegs'
      | 'version'
      | 'contextSnapshotId'
    >
  >;

export function normalizeTripSnapshot(snapshot: TripSnapshot): NormalizedTripSnapshot {
  // Stop.date is optional by contract: an omitted date follows the trip's travelDate.
  // Keep it omitted so changing the trip date does not freeze stops to the old date.
  const stops = sortStopsChronologically(
    (snapshot.stops ?? []).map((stop) => normalizePlanStop(stop)),
    snapshot.travelDate ?? snapshot.localDate ?? snapshot.tripSettings?.localDate,
  );
  const routeLegs = (snapshot.routeLegs ?? []).map((leg) => normalizeRouteLeg(leg));
  return {
    ...snapshot,
    tripId: snapshot.tripId,
    dataMode: snapshot.dataMode ?? 'demo',
    lifecycle: snapshot.lifecycle ?? 'draft',
    planningStatus:
      snapshot.planningStatus ?? (stops.length === 0 ? 'empty' : 'needs_review'),
    timezone: snapshot.timezone ?? snapshot.tripSettings?.timezone ?? 'Asia/Shanghai',
    travelDate: snapshot.travelDate ?? snapshot.localDate ?? snapshot.tripSettings?.localDate,
    dayStartMinutes: snapshot.dayStartMinutes ?? 9 * 60,
    stops,
    routeLegs,
    version: snapshot.version ?? 0,
    contextSnapshotId: snapshot.contextSnapshotId ?? null,
  };
}

/**
 * 可选数组字段的形状归一。
 *
 * 缺省保持 `undefined`（不凭空多出字段，归一后的快照与输入同形），
 * 但**存在却不是数组**时必须变成空数组：领域层读这些字段时用的是 `.length`／`.some`／`.includes`，
 * 传字符串或对象会分别变成子串匹配、TypeError 或静默误判。
 */
function optionalArray<T>(value: unknown): T[] | undefined {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? (value as T[]) : [];
}

export function normalizePlanStop(stop: PlanStop): PlanStop {
  const place = getStopPlace(stop);
  const normalized: PlanStop = {
    ...stop,
    place,
    placeId: place.placeId,
    startMinutes: getStopStart(stop),
    endMinutes: getStopEnd(stop),
    departureMinutes: getStopDeparture(stop),
    plannedArrivalMinutes: getStopArrival(stop),
    minDurationMinutes: getStopMinDuration(stop),
    plannedDurationMinutes: getStopDuration(stop),
    openingIntervals: optionalArray(stop.openingIntervals),
    evidenceRefs: optionalArray(stop.evidenceRefs),
    status: stop.status ?? 'planned',
  };
  // 内存对象可能被执行锁定等逻辑赋上显式 undefined 属性；JSON 往返后这些键会消失，
  // 不清洗会让 isDeepStrictEqual 误判「改写进度」，所有携带事实的计划编辑都会被拒绝。
  for (const key of Object.keys(normalized)) {
    const bag = normalized as unknown as Record<string, unknown>;
    if (bag[key] === undefined) delete bag[key];
  }
  return normalized;
}

export function normalizeRouteLeg(route: RouteLeg): RouteLeg {
  const durationMinutes = getRouteDurationMinutes(route);
  return {
    ...route,
    durationMinutes: durationMinutes ?? 0,
    walkingMinutes: route.walkingMinutes ?? 0,
    distanceMeters: route.distanceMeters ?? 0,
    bufferMinutes: route.bufferMinutes ?? 0,
  };
}
