import type { PlanChange, PlanStop, TripSnapshot } from './types.js';
import {
  getStopArrival,
  getStopDeparture,
  getStopDuration,
  getStopEnd,
  getStopPlace,
  getStopStart,
  normalizeTripSnapshot,
} from './normalize.js';
import { totalWalkingMeters } from './itinerary.js';
import { remainingPlannedChargeRange } from './cost.js';

export interface PlanMetrics {
  walkingMeters: number | null;
  durationMinutes: number | null;
  completionMinutes: number | null;
  arrivalAtLastStopMinutes: number | null;
  remainingCostUpperMinor: number | null;
}

export function computePlanMetrics(snapshotInput: TripSnapshot): PlanMetrics {
  const snapshot = normalizeTripSnapshot(snapshotInput);
  const walking = totalWalkingMeters(snapshot.routeLegs);
  const completion =
    snapshot.stops.length === 0
      ? 0
      : Math.max(...snapshot.stops.map((stop) => getStopEnd(stop)));
  const duration =
    snapshot.stops.length === 0
      ? 0
      : Math.max(
          0,
          completion - Math.min(...snapshot.stops.map((stop) => getStopStart(stop))),
        );
  const arrival =
    snapshot.stops.length === 0
      ? null
      : getStopArrival(snapshot.stops[snapshot.stops.length - 1]);
  const cost = remainingPlannedChargeRange(
    snapshot.plannedCharges ?? [],
    snapshot.spendRef && snapshot.actualSpendMinor !== undefined
      ? {
          spendEventId: snapshot.spendRef,
          tripId: snapshot.tripId,
          amountMinor: snapshot.actualSpendMinor ?? 0,
          currency: snapshot.budget?.currency ?? 'CNY',
          basis: 'party',
          occurredAt: '',
          recordedAt: '',
          completenessConfirmed: snapshot.actualSpendComplete === true,
          includedChargeIds: [],
        }
      : null,
    snapshot.tripSettings?.partySize,
  );
  return {
    walkingMeters: walking,
    durationMinutes: duration,
    completionMinutes: completion,
    arrivalAtLastStopMinutes: arrival,
    remainingCostUpperMinor: cost.upperMinor,
  };
}

function stopPlaceId(stop: PlanStop): string {
  return getStopPlace(stop).placeId;
}

function sameStopTime(a: PlanStop, b: PlanStop): boolean {
  return (
    Math.abs(getStopStart(a) - getStopStart(b)) < 1e-6 &&
    Math.abs(getStopEnd(a) - getStopEnd(b)) < 1e-6 &&
    Math.abs(getStopDeparture(a) - getStopDeparture(b)) < 1e-6
  );
}

function sameStopFlags(a: PlanStop, b: PlanStop): boolean {
  return (
    Math.abs(getStopDuration(a) - getStopDuration(b)) < 1e-6 &&
    Boolean(a.retain ?? a.retainStop) === Boolean(b.retain ?? b.retainStop) &&
    Boolean(a.lockTime ?? a.timeLocked) === Boolean(b.lockTime ?? b.timeLocked) &&
    (a.status ?? 'planned') === (b.status ?? 'planned')
  );
}

/**
 * 以同一当前情境、同一剩余范围比较两个计划；返回“新减旧”的结构化差异。
 * 地点替换会同时产生 remove 与 insert，避免把已有到访事实的 stopId 指向新地点。
 */
export function diffPlans(
  baselineInput: TripSnapshot,
  candidateInput: TripSnapshot,
): PlanChange[] {
  const baseline = normalizeTripSnapshot(baselineInput);
  const candidate = normalizeTripSnapshot(candidateInput);
  const changes: PlanChange[] = [];
  const baselineById = new Map(baseline.stops.map((stop) => [stop.stopId, stop]));
  const candidateById = new Map(candidate.stops.map((stop) => [stop.stopId, stop]));

  const removedIds = new Set<string>();
  for (const oldStop of baseline.stops) {
    const newStop = candidateById.get(oldStop.stopId);
    if (!newStop) {
      removedIds.add(oldStop.stopId);
      changes.push({
        type: 'remove',
        stopId: oldStop.stopId,
        summary: `移除 ${getStopPlace(oldStop).name}`,
        before: oldStop,
      });
      continue;
    }
    if (stopPlaceId(oldStop) !== stopPlaceId(newStop)) {
      changes.push({
        type: 'replace',
        stopId: oldStop.stopId,
        summary: `将 ${getStopPlace(oldStop).name} 替换为 ${getStopPlace(newStop).name}`,
        before: oldStop,
        after: newStop,
      });
      continue;
    }
    if (!sameStopTime(oldStop, newStop)) {
      changes.push({
        type: 'move',
        stopId: oldStop.stopId,
        summary: `调整 ${getStopPlace(newStop).name} 的时间`,
        before: oldStop,
        after: newStop,
      });
    } else if (!sameStopFlags(oldStop, newStop)) {
      changes.push({
        type: 'update',
        stopId: oldStop.stopId,
        summary: `更新 ${getStopPlace(newStop).name} 的设置`,
        before: oldStop,
        after: newStop,
      });
    }
  }

  // 保持新计划的顺序生成 insert / ordering move。
  const baselineOrder = baseline.stops.map((stop) => stop.stopId);
  const candidateOrder = candidate.stops.map((stop) => stop.stopId);
  candidate.stops.forEach((newStop, index) => {
    if (!baselineById.has(newStop.stopId)) {
      changes.push({
        type: 'insert',
        stopId: newStop.stopId,
        summary: `新增 ${getStopPlace(newStop).name}`,
        after: newStop,
      });
      return;
    }
    const oldIndex = baselineOrder.indexOf(newStop.stopId);
    const newIndex = candidateOrder.indexOf(newStop.stopId);
    // 有插入/删除时，绝对索引会变化；这里只报告节点在双方有效顺序中的相对位移。
    const oldEffective = oldIndex - [...removedIds].filter((id) => baselineOrder.indexOf(id) < oldIndex).length;
    const newEffective = newIndex - candidate.stops
      .slice(0, newIndex)
      .filter((stop) => !baselineById.has(stop.stopId)).length;
    if (oldEffective !== newEffective && !changes.some((change) => change.stopId === newStop.stopId && change.type === 'move')) {
      changes.push({
        type: 'move',
        stopId: newStop.stopId,
        summary: `调整 ${getStopPlace(newStop).name} 的顺序`,
        before: baselineById.get(newStop.stopId),
        after: newStop,
      });
    }
  });

  // 稳定输出：按新计划顺序，同节点 remove 在前。
  const order = new Map<string, number>();
  candidate.stops.forEach((stop, index) => order.set(stop.stopId, index));
  baseline.stops.forEach((stop, index) => {
    if (!order.has(stop.stopId)) order.set(stop.stopId, candidate.stops.length + index);
  });
  changes.sort((a, b) => (order.get(a.stopId) ?? 0) - (order.get(b.stopId) ?? 0));
  return changes;
}

export interface PlanComparison {
  changes: PlanChange[];
  baseline: PlanMetrics;
  candidate: PlanMetrics;
  delta: {
    walkingMeters: number | null;
    durationMinutes: number | null;
    completionMinutes: number | null;
    arrivalAtLastStopMinutes: number | null;
    remainingCostUpperMinor: number | null;
  };
  /** 两个计划量纲不可比较时为 true，前端应显示 unknown。 */
  hasUnknownDelta: boolean;
}

function difference(newValue: number | null, oldValue: number | null): number | null {
  if (newValue === null || oldValue === null) return null;
  return newValue - oldValue;
}

/** 差异始终“新减旧”；任一基准值为未知则差值为 null，不能按 0 处理。 */
export function comparePlans(baseline: TripSnapshot, candidate: TripSnapshot): PlanComparison {
  const baselineMetrics = computePlanMetrics(baseline);
  const candidateMetrics = computePlanMetrics(candidate);
  return {
    changes: diffPlans(baseline, candidate),
    baseline: baselineMetrics,
    candidate: candidateMetrics,
    delta: {
      walkingMeters: difference(candidateMetrics.walkingMeters, baselineMetrics.walkingMeters),
      durationMinutes: difference(candidateMetrics.durationMinutes, baselineMetrics.durationMinutes),
      completionMinutes: difference(
        candidateMetrics.completionMinutes,
        baselineMetrics.completionMinutes,
      ),
      arrivalAtLastStopMinutes: difference(
        candidateMetrics.arrivalAtLastStopMinutes,
        baselineMetrics.arrivalAtLastStopMinutes,
      ),
      remainingCostUpperMinor: difference(
        candidateMetrics.remainingCostUpperMinor,
        baselineMetrics.remainingCostUpperMinor,
      ),
    },
    hasUnknownDelta:
      baselineMetrics.walkingMeters === null ||
      candidateMetrics.walkingMeters === null ||
      baselineMetrics.remainingCostUpperMinor === null ||
      candidateMetrics.remainingCostUpperMinor === null,
  };
}

export function describePlanChanges(changes: readonly PlanChange[]): string {
  if (changes.length === 0) return '计划没有变化';
  return changes.map((change) => change.summary).join('；');
}
