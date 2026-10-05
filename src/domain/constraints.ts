import type {
  Constraint,
  ConstraintStrength,
  FacilityRequiredConstraint,
  LockTimeConstraint,
  PlanCheck,
  PlanStop,
  RetainStopConstraint,
  TripSnapshot,
  ValidationSummary,
  VisitWindowConstraint,
  WalkingLimitConstraint,
} from './types.js';
import { budgetEvaluationToCheck, evaluateBudget } from './cost.js';
import {
  getStopArrival,
  getStopEnd,
  getStopPlace,
  getStopStart,
  isRetainStop,
  isTimeLocked,
  normalizeTripSnapshot,
  getRouteWalkingMeters,
} from './normalize.js';
import { isWithinRange, parseClockValue } from './time.js';

const EPSILON = 1e-6;

function baseCheck(constraint: Constraint) {
  return {
    constraintId: constraint.constraintId,
    status: 'unknown' as const,
    affectedStopIds: [] as string[],
  };
}

function strengthOf(constraint: Constraint): ConstraintStrength {
  return constraint.strength ?? 'soft';
}

function findStopInSnapshot(snapshot: TripSnapshot, stopId: string | undefined): PlanStop | undefined {
  if (!stopId) return undefined;
  return (snapshot.stops ?? []).find((stop) => stop.stopId === stopId);
}

function visitWindowValues(constraint: VisitWindowConstraint) {
  const payload = constraint.payload;
  return {
    earliest: parseClockValue(payload.earliestStartMinutes ?? payload.earliestStartAt),
    latestStart: parseClockValue(payload.latestStartMinutes),
    latestArrival: parseClockValue(payload.latestArrivalMinutes ?? payload.latestArrivalAt),
    earliestEnd: parseClockValue(payload.earliestEndMinutes),
    latestEnd: parseClockValue(payload.latestEndMinutes),
    requiredDuration:
      payload.durationSeconds !== undefined && Number.isFinite(payload.durationSeconds)
        ? payload.durationSeconds / 60
        : null,
  };
}

function checkVisitWindow(
  constraint: VisitWindowConstraint,
  snapshot: TripSnapshot,
): PlanCheck {
  const base = baseCheck(constraint);
  const stop = findStopInSnapshot(snapshot, constraint.payload.stopId);
  if (!stop) {
    return { ...base, status: 'fail', reasonCode: 'stop_missing' };
  }

  const arrival = getStopArrival(stop);
  const start = getStopStart(stop);
  const end = getStopEnd(stop);
  const window = visitWindowValues(constraint);
  const hasWindow =
    window.earliest !== null ||
    window.latestStart !== null ||
    window.latestArrival !== null ||
    window.earliestEnd !== null ||
    window.latestEnd !== null ||
    window.requiredDuration !== null ||
    Boolean(stop.openingIntervals && stop.openingIntervals.length > 0);

  if (!hasWindow) {
    return { ...base, status: 'unknown', reasonCode: 'invalid_constraint' };
  }

  if (window.earliest !== null && start + EPSILON < window.earliest) {
    return {
      ...base,
      status: 'fail',
      reasonCode: 'starts_too_early',
      affectedStopIds: [stop.stopId],
    };
  }
  if (window.latestStart !== null && start - EPSILON > window.latestStart) {
    return {
      ...base,
      status: 'fail',
      reasonCode: 'starts_too_late',
      affectedStopIds: [stop.stopId],
    };
  }
  if (window.latestArrival !== null && arrival - EPSILON > window.latestArrival) {
    return {
      ...base,
      status: 'fail',
      reasonCode: 'arrives_too_late',
      affectedStopIds: [stop.stopId],
    };
  }
  if (window.latestEnd !== null && end - EPSILON > window.latestEnd) {
    return {
      ...base,
      status: 'fail',
      reasonCode: 'ends_too_late',
      affectedStopIds: [stop.stopId],
    };
  }
  if (window.earliestEnd !== null && end + EPSILON < window.earliestEnd) {
    return {
      ...base,
      status: 'fail',
      reasonCode: 'ends_too_early',
      affectedStopIds: [stop.stopId],
    };
  }
  if (
    window.requiredDuration !== null &&
    end - start + EPSILON < window.requiredDuration
  ) {
    return {
      ...base,
      status: 'fail',
      reasonCode: 'duration_too_short',
      affectedStopIds: [stop.stopId],
    };
  }

  if (stop.openingIntervals && stop.openingIntervals.length > 0) {
    const fits = stop.openingIntervals.some((interval) =>
      isWithinRange({ startMinutes: start, endMinutes: end }, interval),
    );
    if (!fits) {
      return {
        ...base,
        status: 'fail',
        reasonCode: 'outside_opening_hours',
        affectedStopIds: [stop.stopId],
      };
    }
  }

  return { ...base, status: 'pass', affectedStopIds: [stop.stopId] };
}

function checkRetainStop(
  constraint: RetainStopConstraint,
  snapshot: TripSnapshot,
): PlanCheck {
  const base = baseCheck(constraint);
  const stop = findStopInSnapshot(snapshot, constraint.payload.stopId);
  if (!stop) {
    return { ...base, status: 'fail', reasonCode: 'stop_missing' };
  }
  if (!isRetainStop(stop)) {
    return {
      ...base,
      status: 'fail',
      reasonCode: 'retain_flag_cleared',
      affectedStopIds: [stop.stopId],
    };
  }
  return { ...base, status: 'pass', affectedStopIds: [stop.stopId] };
}

function checkLockTime(constraint: LockTimeConstraint, snapshot: TripSnapshot): PlanCheck {
  const base = baseCheck(constraint);
  const stop = findStopInSnapshot(snapshot, constraint.payload.stopId);
  if (!stop) {
    return { ...base, status: 'fail', reasonCode: 'stop_missing' };
  }
  const payload = constraint.payload;
  const expectedStart = parseClockValue(
    payload.startMinutes ?? payload.originalStartMinutes ?? payload.visitWindow?.startMinutes,
  );
  const expectedEnd = parseClockValue(
    payload.endMinutes ?? payload.originalEndMinutes ?? payload.visitWindow?.endMinutes,
  );
  if (expectedStart === null || expectedEnd === null) {
    return { ...base, status: 'unknown', reasonCode: 'invalid_constraint' };
  }
  const currentStart = getStopStart(stop);
  const currentEnd = getStopEnd(stop);
  if (
    isTimeLocked(stop) &&
    Math.abs(currentStart - expectedStart) < EPSILON &&
    Math.abs(currentEnd - expectedEnd) < EPSILON
  ) {
    return { ...base, status: 'pass', affectedStopIds: [stop.stopId] };
  }
  if (
    Math.abs(currentStart - expectedStart) >= EPSILON ||
    Math.abs(currentEnd - expectedEnd) >= EPSILON
  ) {
    return {
      ...base,
      status: 'fail',
      reasonCode: 'time_window_changed',
      affectedStopIds: [stop.stopId],
    };
  }
  return { ...base, status: 'pass', affectedStopIds: [stop.stopId] };
}

function walkingLimitValues(constraint: WalkingLimitConstraint): {
  maxMeters: number | null;
  maxMinutes: number | null;
} {
  const payload = constraint.payload;
  const maxMeters = payload.maxWalkingMeters ?? payload.meters ?? payload.maxMeters ?? null;
  const maxMinutes = payload.maxWalkingMinutes ?? null;
  return {
    maxMeters: maxMeters !== null && Number.isFinite(maxMeters) ? maxMeters : null,
    maxMinutes: maxMinutes !== null && Number.isFinite(maxMinutes) ? maxMinutes : null,
  };
}

function checkWalkingLimit(
  constraint: WalkingLimitConstraint,
  snapshot: TripSnapshot,
): PlanCheck {
  const base = baseCheck(constraint);
  const { maxMeters, maxMinutes } = walkingLimitValues(constraint);
  if (maxMeters === null && maxMinutes === null) {
    return { ...base, status: 'unknown', reasonCode: 'invalid_constraint' };
  }

  const routes = snapshot.routeLegs ?? [];
  if (constraint.payload.scope === 'leg') {
    let hasUnknown = false;
    for (const route of routes) {
      if (maxMeters !== null) {
        const meters = getRouteWalkingMeters(route);
        if (meters === null) {
          hasUnknown = true;
          continue;
        }
        if (meters - EPSILON > maxMeters) {
          return {
            ...base,
            status: 'fail',
            reasonCode: 'walking_leg_limit_exceeded',
            affectedStopIds: [route.toStopId],
          };
        }
      } else if (maxMinutes !== null) {
        const minutes = route.walkingMinutes;
        if (minutes === undefined || minutes === null) {
          hasUnknown = true;
          continue;
        }
        if (minutes - EPSILON > maxMinutes) {
          return {
            ...base,
            status: 'fail',
            reasonCode: 'walking_leg_limit_exceeded',
            affectedStopIds: [route.toStopId],
          };
        }
      }
    }
    return hasUnknown
      ? { ...base, status: 'unknown', reasonCode: 'walking_data_unknown' }
      : { ...base, status: 'pass' };
  }

  // 全天上限：先确认路线步行量；硬条件还必须包含用户确认完整的累计实际步行。
  const isHard = strengthOf(constraint) === 'hard';
  const explicitActual = snapshot.actualWalkingMeters;
  const completenessKnown = snapshot.actualWalkingComplete === true;

  if (maxMeters !== null) {
    let plannedWalking = 0;
    for (const route of routes) {
      const meters = getRouteWalkingMeters(route);
      if (meters === null) {
        return { ...base, status: 'unknown', reasonCode: 'walking_data_unknown' };
      }
      plannedWalking += meters;
    }
    if (
      isHard &&
      (explicitActual === undefined || explicitActual === null || !completenessKnown)
    ) {
      return { ...base, status: 'unknown', reasonCode: 'actual_walking_unknown' };
    }
    const actual = explicitActual ?? 0;
    if (plannedWalking + actual - EPSILON > maxMeters) {
      return { ...base, status: 'fail', reasonCode: 'walking_day_limit_exceeded' };
    }
    return { ...base, status: 'pass' };
  }

  // 分钟口径（早期字段 maxWalkingMinutes，docs/03 的正式口径是米）。
  let plannedWalkingMinutes = 0;
  for (const route of routes) {
    if (route.walkingMinutes === undefined || route.walkingMinutes === null) {
      return { ...base, status: 'unknown', reasonCode: 'walking_data_unknown' };
    }
    plannedWalkingMinutes += route.walkingMinutes;
  }
  if (isHard && (explicitActual === undefined || explicitActual === null || !completenessKnown)) {
    return { ...base, status: 'unknown', reasonCode: 'actual_walking_unknown' };
  }
  // 已记录的实际步行只有**米**这一个口径（walking_events.walking_meters）。
  // 首版不按某个假定步速换算成分钟（见 normalize.ts 对旧字段的同一条判断），
  // 所以只要有非零实测步行，当天的分钟总量就无法核定——如实返回 unknown，
  // 而不是把米当成分钟相加（那会把 2 公里的实测步行算成 2000 分钟，让合规方案误判为超限）。
  if (explicitActual !== undefined && explicitActual !== null && explicitActual > 0) {
    return { ...base, status: 'unknown', reasonCode: 'walking_units_incomparable' };
  }
  if (plannedWalkingMinutes - EPSILON > maxMinutes!) {
    return { ...base, status: 'fail', reasonCode: 'walking_day_limit_exceeded' };
  }
  return { ...base, status: 'pass' };
}

function checkFacilityRequired(
  constraint: FacilityRequiredConstraint,
  snapshot: TripSnapshot,
): PlanCheck {
  const base = baseCheck(constraint);
  const stopIds =
    constraint.payload.stopId !== undefined
      ? [constraint.payload.stopId]
      : constraint.payload.scopeStopIds ?? [];
  if (stopIds.length === 0) {
    return { ...base, status: 'unknown', reasonCode: 'invalid_constraint' };
  }
  const affected: string[] = [];
  for (const stopId of stopIds) {
    const stop = findStopInSnapshot(snapshot, stopId);
    if (!stop) {
      return { ...base, status: 'fail', reasonCode: 'stop_missing' };
    }
    affected.push(stop.stopId);
    const place = getStopPlace(stop);
    const hasFacility = place.facilityCodes.includes(constraint.payload.facilityCode);
    if (hasFacility) continue;
    if (place.facilityCodes.length === 0 && (stop.evidenceRefs ?? []).length === 0) {
      return {
        ...base,
        status: 'unknown',
        reasonCode: 'facility_evidence_missing',
        affectedStopIds: affected,
      };
    }
    return {
      ...base,
      status: 'fail',
      reasonCode: 'facility_missing',
      affectedStopIds: affected,
    };
  }
  return { ...base, status: 'pass', affectedStopIds: affected };
}

function checkPreference(constraint: Constraint & { kind: 'preference' }, snapshot: TripSnapshot): PlanCheck {
  const base = baseCheck(constraint);
  const partyNeeds = snapshot.partyNeeds ?? {};
  for (const needs of Object.values(partyNeeds)) {
    const value = needs[constraint.payload.key];
    if (value === constraint.payload.value) {
      return { ...base, status: 'pass' };
    }
    if (value !== undefined && value !== null) {
      return { ...base, status: 'fail', reasonCode: 'preference_conflict' };
    }
  }
  return { ...base, status: 'unknown', reasonCode: 'preference_not_verified' };
}

function checkBudget(constraint: Constraint & { kind: 'budget_limit' }, snapshot: TripSnapshot): PlanCheck {
  const spendEvents = snapshot.spendEvents ?? [];
  const referencedEvent =
    snapshot.spendRef !== undefined && snapshot.spendRef !== null
      ? spendEvents.find((event) => event.spendEventId === snapshot.spendRef)
      : undefined;
  const latestEvent = [...spendEvents].sort((a, b) =>
    b.recordedAt.localeCompare(a.recordedAt),
  )[0];
  const spendEvent =
    referencedEvent ??
    latestEvent ??
    (snapshot.actualSpendMinor !== undefined || snapshot.actualSpendComplete !== undefined
      ? {
          spendEventId: snapshot.spendRef ?? 'synthetic_spend',
          tripId: snapshot.tripId,
          amountMinor: snapshot.actualSpendMinor ?? 0,
          currency: snapshot.budget?.currency ?? 'CNY',
          basis: 'party' as const,
          occurredAt: '',
          recordedAt: '',
          completenessConfirmed: snapshot.actualSpendComplete === true,
          includedChargeIds: [],
        }
      : null);
  const evaluation = evaluateBudget({
    constraint,
    budget: snapshot.budget,
    charges: snapshot.plannedCharges,
    spendEvent,
    participantCount: snapshot.tripSettings?.partySize,
  });
  return budgetEvaluationToCheck(constraint, evaluation);
}

/** 单个约束检查；返回 pass / fail / unknown，未知与失败严格分开。 */
export function checkConstraint(constraint: Constraint, snapshot: TripSnapshot): PlanCheck {
  switch (constraint.kind) {
    case 'visit_window':
      return checkVisitWindow(constraint, snapshot);
    case 'retain_stop':
      return checkRetainStop(constraint, snapshot);
    case 'lock_time':
      return checkLockTime(constraint, snapshot);
    case 'walking_limit':
      return checkWalkingLimit(constraint, snapshot);
    case 'budget_limit':
      return checkBudget(constraint, snapshot);
    case 'facility_required':
      return checkFacilityRequired(constraint, snapshot);
    case 'preference':
      return checkPreference(constraint, snapshot);
    default: {
      const exhaustive: never = constraint;
      return {
        constraintId: (exhaustive as Constraint).constraintId,
        status: 'unknown',
        reasonCode: 'unsupported_constraint',
        affectedStopIds: [],
      };
    }
  }
}

function findConstraintStrength(
  constraints: readonly Constraint[],
  constraintId: string,
): ConstraintStrength {
  return constraints.find((item) => item.constraintId === constraintId)?.strength ?? 'soft';
}

/**
 * 汇总检查。
 * - 空计划：empty；
 * - 全部 hard 约束 pass：validated；
 * - 任一 hard fail/unknown：needs_review。
 * soft 偏好参与展示与排序，但不把 unknown 变成硬通过。
 */
export function evaluateSnapshot(
  snapshot: TripSnapshot,
  constraints: readonly Constraint[] = snapshot.constraints ?? [],
): ValidationSummary {
  const normalized = normalizeTripSnapshot(snapshot);
  const checks = constraints.map((constraint) => checkConstraint(constraint, normalized));
  const hardChecks = checks.filter(
    (check) => findConstraintStrength(constraints, check.constraintId) === 'hard',
  );
  const planningStatus =
    normalized.stops.length === 0
      ? 'empty'
      : hardChecks.every((check) => check.status === 'pass')
        ? 'validated'
        : 'needs_review';

  return {
    planningStatus,
    checks,
    checkedAt: new Date().toISOString(),
    contextSnapshotId: normalized.contextSnapshotId ?? null,
  };
}

/** 判断某计划在当前快照中是否仍被保留。 */
export function findStop(
  stops: readonly PlanStop[],
  stopId: string,
): PlanStop | undefined {
  return stops.find((stop) => stop.stopId === stopId);
}

export function affectedStopIdsFromChecks(checks: readonly PlanCheck[]): string[] {
  return [...new Set(checks.flatMap((check) => check.affectedStopIds ?? []))];
}

