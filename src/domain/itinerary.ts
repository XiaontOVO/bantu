/**
 * 时间传播与计划快照计算。
 *
 * 对应 docs/02 §8.2 的时间模型：
 *   arrival[i] = departure[i-1] + routeDuration + transferBuffer
 *   start[i]   = earliestFeasibleStart(arrival, visitWindow, openingIntervals, duration)
 *   departure[i] = start[i] + duration[i]
 *
 * 路线耗时缺失或营业资料无法容纳完整停留时保留 warning，计划状态由约束引擎决定。
 */

import type { GeoPoint, PlanStop, RouteLeg, StopStatus, TimeRange, TransportMode } from './types.js';
import {
  findEarliestFeasibleStart,
  parseClockValue,
  waitingBefore,
} from './time.js';
import {
  getRouteDurationMinutes,
  getStopDuration,
  getStopEnd,
  getStopStart,
  normalizePlanStop,
} from './normalize.js';

export interface ScheduleSegment {
  stopId: string;
  placeId: string;
  placeName?: string;
  coordinates?: GeoPoint | null;
  facilityCodes?: string[];
  status?: StopStatus;
  /** 建议停留时长（分钟） */
  durationMinutes?: number;
  /** 建议停留时长（秒，docs/03 口径） */
  durationSeconds?: number;
  /** 最短停留时长（分钟） */
  minDurationMinutes?: number;
  minDurationSeconds?: number;
  /** 可选：最早可开始时间（分钟） */
  earliestStartMinutes?: number;
  latestStartMinutes?: number;
  latestArrivalMinutes?: number;
  /** 可选：开放区间；缺失表示未知，不能当作全天开放 */
  openingIntervals?: TimeRange[];
  visitWindow?: TimeRange;
  retain?: boolean;
  retainStop?: boolean;
  lockTime?: boolean;
  timeLocked?: boolean;
  /** 锁定节点使用的时间窗。 */
  lockedStartMinutes?: number;
  lockedEndMinutes?: number;
}

export interface ScheduleRoute {
  legId: string;
  fromStopId: string;
  toStopId: string;
  transportMode: TransportMode;
  /** 兼容分钟口径。 */
  durationMinutes?: number;
  /** docs/03 秒口径。 */
  durationSeconds?: number;
  walkingMinutes?: number;
  walkingMeters?: number;
  distanceMeters?: number;
  bufferMinutes?: number;
  /** 供应商只返回当前估计时，不能冒充未来预测。 */
  departureSupport?: 'scheduled' | 'live' | 'current_only' | 'demo';
  costEstimate?: RouteLeg['costEstimate'];
}

export interface ScheduleInput {
  departureMinutes: number;
  segments: ScheduleSegment[];
  routes: ScheduleRoute[];
}

export interface ScheduleOutput {
  stops: PlanStop[];
  routeLegs: RouteLeg[];
  warnings: string[];
  /** 节点 → 计划等待分钟，便于卡片解释“等待多久”。 */
  waitingMinutesByStop: Record<string, number>;
}

function segmentDuration(segment: ScheduleSegment): number | null {
  if (segment.durationMinutes !== undefined) return segment.durationMinutes;
  if (segment.durationSeconds !== undefined) return segment.durationSeconds / 60;
  return null;
}

function segmentMinDuration(segment: ScheduleSegment): number {
  if (segment.minDurationMinutes !== undefined) return segment.minDurationMinutes;
  if (segment.minDurationSeconds !== undefined) return segment.minDurationSeconds / 60;
  return segmentDuration(segment) ?? 0;
}

function findRoute(
  routes: readonly ScheduleRoute[],
  fromStopId: string,
  toStopId: string,
  index: number,
): ScheduleRoute | undefined {
  return (
    routes.find(
      (route) => route.fromStopId === fromStopId && route.toStopId === toStopId,
    ) ??
    routes.find((route) => route.toStopId === toStopId) ??
    (index === 0 ? undefined : routes.find((route) => route.fromStopId === fromStopId))
  );
}

/**
 * 从起点出发时间开始，按顺序计算每个节点的到达、开始、结束与离开时间。
 * 缺失路线、非法耗时、营业区间无法容纳完整停留时返回明确 warning。
 */
export function propagateSchedule(input: ScheduleInput): ScheduleOutput {
  const warnings: string[] = [];
  const stops: PlanStop[] = [];
  const routeLegs: RouteLeg[] = [];
  const waitingMinutesByStop: Record<string, number> = {};
  let cursorMinutes = input.departureMinutes;
  let previousStopId = 'origin';

  for (let i = 0; i < input.segments.length; i += 1) {
    const segment = input.segments[i];
    const routeToHere = findRoute(input.routes, previousStopId, segment.stopId, i);
    let arrivalMinutes = cursorMinutes;
    let routeDurationKnown = true;

    if (routeToHere) {
      const duration = getRouteDurationMinutes({
        legId: routeToHere.legId,
        fromStopId: routeToHere.fromStopId,
        toStopId: routeToHere.toStopId,
        transportMode: routeToHere.transportMode,
        durationMinutes: routeToHere.durationMinutes,
        durationSeconds: routeToHere.durationSeconds,
        walkingMinutes: routeToHere.walkingMinutes,
        walkingMeters: routeToHere.walkingMeters,
        distanceMeters: routeToHere.distanceMeters,
        bufferMinutes: routeToHere.bufferMinutes,
        departureSupport: routeToHere.departureSupport,
        costEstimate: routeToHere.costEstimate,
      });
      if (duration === null) {
        warnings.push(`route ${routeToHere.legId} has unknown duration`);
        routeDurationKnown = false;
      } else {
        const buffer = routeToHere.bufferMinutes ?? 0;
        arrivalMinutes = cursorMinutes + duration + buffer;
      }
      routeLegs.push({
        legId: routeToHere.legId,
        fromStopId: routeToHere.fromStopId,
        toStopId: routeToHere.toStopId,
        transportMode: routeToHere.transportMode,
        durationMinutes: routeToHere.durationMinutes,
        durationSeconds: routeToHere.durationSeconds,
        walkingMinutes: routeToHere.walkingMinutes ?? 0,
        walkingMeters: routeToHere.walkingMeters,
        distanceMeters: routeToHere.distanceMeters ?? 0,
        bufferMinutes: routeToHere.bufferMinutes ?? 0,
        departureSupport: routeToHere.departureSupport,
        costEstimate: routeToHere.costEstimate,
      });
    } else if (i > 0) {
      warnings.push(`missing route to stop ${segment.stopId}`);
      routeDurationKnown = false;
    } else {
      // 第一站从用户确认的出发点开始，视为已经到达/位于该点，不计交通。
      arrivalMinutes = cursorMinutes;
    }

    const duration = segmentDuration(segment);
    if (duration === null) {
      warnings.push(`stop ${segment.stopId} has unknown duration`);
    }
    const safeDuration = duration ?? 0;

    const earliestStart =
      parseClockValue(segment.earliestStartMinutes) ??
      parseClockValue(segment.visitWindow?.startMinutes);
    const latestStart = parseClockValue(segment.latestStartMinutes);
    const latestArrival =
      parseClockValue(segment.latestArrivalMinutes) ??
      parseClockValue(segment.visitWindow?.endMinutes);

    let startMinutes: number;
    let endMinutes: number;
    let waitingMinutes = 0;

    if (segment.lockTime && segment.lockedStartMinutes !== undefined) {
      startMinutes = segment.lockedStartMinutes;
      endMinutes =
        segment.lockedEndMinutes ?? startMinutes + Math.max(safeDuration, segmentMinDuration(segment));
      waitingMinutes = waitingBefore(startMinutes, arrivalMinutes);
      if (endMinutes < startMinutes) {
        warnings.push(`locked stop ${segment.stopId} has invalid locked window`);
      }
    } else {
      const feasible = findEarliestFeasibleStart(arrivalMinutes, safeDuration, {
        earliestStartMinutes: earliestStart,
        latestStartMinutes: latestStart,
        latestArrivalMinutes: latestArrival,
        openingIntervals: segment.openingIntervals,
      });
      if (feasible) {
        startMinutes = feasible.startMinutes;
        endMinutes = feasible.endMinutes;
        waitingMinutes = feasible.waitingMinutes;
      } else {
        startMinutes = Math.max(arrivalMinutes, earliestStart ?? arrivalMinutes);
        endMinutes = startMinutes + safeDuration;
        waitingMinutes = waitingBefore(startMinutes, arrivalMinutes);
        if (segment.openingIntervals && segment.openingIntervals.length > 0) {
          warnings.push(`stop ${segment.stopId} cannot fit opening intervals`);
        } else if (latestArrival !== undefined && latestArrival !== null && arrivalMinutes > latestArrival) {
          warnings.push(`stop ${segment.stopId} arrives after latest arrival`);
        } else if (latestStart !== undefined && latestStart !== null && startMinutes > latestStart) {
          warnings.push(`stop ${segment.stopId} starts after latest start`);
        }
      }
    }

    const departureMinutes = endMinutes;
    const placeId = segment.placeId;
    const stop = normalizePlanStop({
      stopId: segment.stopId,
      placeId,
      place: {
        placeId,
        name: segment.placeName ?? placeId,
        coordinates: segment.coordinates ?? null,
        facilityCodes: segment.facilityCodes ?? [],
      },
      plannedArrivalMinutes: arrivalMinutes,
      startMinutes,
      plannedStartMinutes: startMinutes,
      endMinutes,
      departureMinutes,
      plannedDepartureMinutes: departureMinutes,
      minDurationMinutes: segmentMinDuration(segment),
      plannedDurationMinutes: safeDuration,
      retain: segment.retain ?? segment.retainStop,
      retainStop: segment.retainStop ?? segment.retain,
      lockTime: segment.lockTime ?? segment.timeLocked,
      timeLocked: segment.timeLocked ?? segment.lockTime,
      openingIntervals: segment.openingIntervals,
      visitWindow: segment.visitWindow,
      status: segment.status ?? 'planned',
    }) as PlanStop;

    // 便于界面解释，但不要把等待算进活动时长。
    (stop as PlanStop & { arrivalUnknown?: boolean }).arrivalUnknown = !routeDurationKnown;
    waitingMinutesByStop[segment.stopId] = waitingMinutes;
    stops.push(stop);
    cursorMinutes = departureMinutes;
    previousStopId = segment.stopId;
  }

  return { stops, routeLegs, warnings, waitingMinutesByStop };
}

/** 返回计划中未完成节点的最早一个；无未完成节点时返回 undefined。 */
export function nextUnexecutedStop(stops: readonly PlanStop[]): PlanStop | undefined {
  return stops.find((stop) => (stop.status ?? 'planned') === 'planned' || stop.status === 'en_route');
}

/** 返回仍会出现在未来时间轴上的节点（不包含 completed/skipped 事实）。 */
export function remainingStops(stops: readonly PlanStop[]): PlanStop[] {
  return stops.filter(
    (stop) =>
      stop.status !== 'completed' && stop.status !== 'skipped' && stop.status !== 'visiting',
  );
}

/** 计划总步行米数；存在未知路线步行量时返回 null，避免把未知当零。 */
export function totalWalkingMeters(routeLegs: readonly RouteLeg[]): number | null {
  let total = 0;
  for (const route of routeLegs) {
    if (route.walkingMeters === undefined || route.walkingMeters === null) return null;
    total += route.walkingMeters;
  }
  return total;
}

/** 计划总时长，单位为分钟。 */
export function planDurationMinutes(stops: readonly PlanStop[]): number | null {
  if (stops.length === 0) return 0;
  const start = Math.min(...stops.map((stop) => getStopStart(stop)));
  const end = Math.max(...stops.map((stop) => getStopEnd(stop)));
  return Math.max(0, end - start);
}

export function cloneStopForPlan(stop: PlanStop, overrides: Partial<PlanStop> = {}): PlanStop {
  return normalizePlanStop({
    ...stop,
    ...overrides,
    place: overrides.place ?? stop.place,
    stopId: overrides.stopId ?? stop.stopId,
  });
}

export function stopDurationMinutes(stop: PlanStop): number {
  return getStopDuration(stop);
}

export function routeWalkingIsKnown(route: RouteLeg): boolean {
  return route.walkingMeters !== undefined && route.walkingMeters !== null;
}
