import type {
  Constraint,
  PlanCheck,
  ProposalCandidate,
  TripSnapshot,
  VisitWindowConstraint,
} from './types.js';
import { checkConstraint } from './constraints.js';
import { comparePlans, describePlanChanges } from './diff.js';
import { normalizeTripSnapshot } from './normalize.js';

export interface CandidateEvaluation {
  candidateId: string;
  checks: PlanCheck[];
  applicability: 'applicable' | 'needs_verification';
  reasons: string[];
}

export function evaluateCandidate(
  candidate: ProposalCandidate,
  constraints: readonly Constraint[] = candidate.snapshot.constraints ?? [],
): CandidateEvaluation {
  const checks =
    candidate.checks && candidate.checks.length > 0
      ? candidate.checks
      : constraints.map((constraint) =>
          checkConstraint(constraint, normalizeTripSnapshot(candidate.snapshot)),
        );
  const hardFail = checks.some((check) => check.status === 'fail');
  const unknown = checks.some((check) => check.status === 'unknown');
  return {
    candidateId: candidate.candidateId,
    checks,
    applicability: hardFail ? 'needs_verification' : unknown ? 'needs_verification' : 'applicable',
    reasons: checks
      .filter((check) => check.status !== 'pass')
      .map((check) => `${check.status}:${check.reasonCode ?? check.constraintId}`),
  };
}

/** 可行候选才进入排序；hard fail 的候选只用于冲突解释。 */
export function isCandidateApplicable(candidate: ProposalCandidate): boolean {
  const checks = candidate.checks ?? [];
  if (candidate.applicability === 'applicable') {
    return !checks.some((check) => check.status === 'fail');
  }
  return !checks.some((check) => check.status !== 'pass');
}

export interface CandidateScore {
  candidateId: string;
  changesCount: number;
  walkingMeters: number | null;
  durationMinutes: number | null;
  costUpperMinor: number | null;
  stableTieBreaker: string;
}

export function scoreCandidate(
  candidate: ProposalCandidate,
  baseline?: TripSnapshot,
): CandidateScore {
  const comparison = baseline ? comparePlans(baseline, candidate.snapshot) : null;
  return {
    candidateId: candidate.candidateId,
    changesCount: candidate.changes?.length ?? comparison?.changes.length ?? 0,
    walkingMeters: comparison?.candidate.walkingMeters ?? null,
    durationMinutes: comparison?.candidate.durationMinutes ?? null,
    costUpperMinor: comparison?.candidate.remainingCostUpperMinor ?? null,
    stableTieBreaker: candidate.candidateId,
  };
}

function compareNullableNumber(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * docs/02 §8.4 的稳定排序：少改动 → 少步行 → 少时间压力 → 低费用 → 稳定 ID。
 * 真实实现还应在前面加入“保留用户重要体验”和软偏好优先级；scoreCandidate 已保留扩展点。
 */
export function rankCandidates(
  candidates: readonly ProposalCandidate[],
  baseline?: TripSnapshot,
): ProposalCandidate[] {
  return [...candidates]
    .filter(isCandidateApplicable)
    .sort((a, b) => {
      const scoreA = scoreCandidate(a, baseline);
      const scoreB = scoreCandidate(b, baseline);
      const changes = scoreA.changesCount - scoreB.changesCount;
      if (changes !== 0) return changes;
      const walking = compareNullableNumber(scoreA.walkingMeters, scoreB.walkingMeters);
      if (walking !== 0) return walking;
      const duration = compareNullableNumber(scoreA.durationMinutes, scoreB.durationMinutes);
      if (duration !== 0) return duration;
      const cost = compareNullableNumber(scoreA.costUpperMinor, scoreB.costUpperMinor);
      if (cost !== 0) return cost;
      return scoreA.stableTieBreaker.localeCompare(scoreB.stableTieBreaker);
    });
}

export interface ConstraintConflict {
  code: string;
  constraintIds: string[];
  message: string;
}

/** 只指出已明确的直接矛盾；有限检索无结果不能声称全城无解。 */
export function detectConstraintConflicts(
  constraints: readonly Constraint[],
): ConstraintConflict[] {
  const conflicts: ConstraintConflict[] = [];
  const visitWindows = constraints.filter(
    (constraint): constraint is VisitWindowConstraint => constraint.kind === 'visit_window',
  );
  for (let i = 0; i < visitWindows.length; i += 1) {
    for (let j = i + 1; j < visitWindows.length; j += 1) {
      const a = visitWindows[i];
      const b = visitWindows[j];
      if (!a.payload.stopId || a.payload.stopId !== b.payload.stopId) continue;
      const aEarliest =
        a.payload.earliestStartMinutes ?? Number(a.payload.earliestStartAt ?? -Infinity);
      const aLatest =
        a.payload.latestStartMinutes ??
        a.payload.latestEndMinutes ??
        Number(a.payload.latestArrivalAt ?? Infinity);
      const bEarliest =
        b.payload.earliestStartMinutes ?? Number(b.payload.earliestStartAt ?? -Infinity);
      const bLatest =
        b.payload.latestStartMinutes ??
        b.payload.latestEndMinutes ??
        Number(b.payload.latestArrivalAt ?? Infinity);
      if (
        Number.isFinite(aLatest) &&
        Number.isFinite(bEarliest) &&
        bEarliest > aLatest
      ) {
        conflicts.push({
          code: 'CONTRADICTORY_VISIT_WINDOWS',
          constraintIds: [a.constraintId, b.constraintId],
          message: `节点 ${a.payload.stopId} 的两个时间窗无法同时满足。`,
        });
      } else if (
        Number.isFinite(bLatest) &&
        Number.isFinite(aEarliest) &&
        aEarliest > bLatest
      ) {
        conflicts.push({
          code: 'CONTRADICTORY_VISIT_WINDOWS',
          constraintIds: [a.constraintId, b.constraintId],
          message: `节点 ${a.payload.stopId} 的两个时间窗无法同时满足。`,
        });
      }
    }
  }

  const locks = constraints.filter((constraint) => constraint.kind === 'lock_time');
  for (const lock of locks) {
    for (const visit of visitWindows) {
      if (!visit.payload.stopId || lock.payload.stopId !== visit.payload.stopId) continue;
      const lockStart =
        lock.payload.startMinutes ??
        lock.payload.originalStartMinutes ??
        lock.payload.visitWindow?.startMinutes;
      const lockEnd =
        lock.payload.endMinutes ??
        lock.payload.originalEndMinutes ??
        lock.payload.visitWindow?.endMinutes;
      const earliest =
        visit.payload.earliestStartMinutes ?? Number(visit.payload.earliestStartAt ?? -Infinity);
      const latest =
        visit.payload.latestStartMinutes ??
        visit.payload.latestEndMinutes ??
        Number(visit.payload.latestArrivalAt ?? Infinity);
      if (
        lockStart !== undefined &&
        Number.isFinite(earliest) &&
        lockStart < earliest
      ) {
        conflicts.push({
          code: 'LOCK_OUTSIDE_VISIT_WINDOW',
          constraintIds: [lock.constraintId, visit.constraintId],
          message: `锁定时间早于节点 ${lock.payload.stopId} 的最早开始时间。`,
        });
      }
      if (lockEnd !== undefined && Number.isFinite(latest) && lockEnd > latest) {
        conflicts.push({
          code: 'LOCK_OUTSIDE_VISIT_WINDOW',
          constraintIds: [lock.constraintId, visit.constraintId],
          message: `锁定时间晚于节点 ${lock.payload.stopId} 的最晚结束时间。`,
        });
      }
    }
  }

  return conflicts;
}

export function noFeasiblePlanMessage(constraints: readonly Constraint[]): string {
  const conflicts = detectConstraintConflicts(constraints);
  if (conflicts.length > 0) {
    return conflicts.map((conflict) => conflict.message).join('；');
  }
  return '在当前检索范围与条件下未找到可行方案；这不表示全城无解。';
}

/** 计算差异摘要；由程序生成，不依赖模型散文。 */
export function summarizeCandidateChanges(
  baseline: TripSnapshot,
  candidate: ProposalCandidate,
): string {
  return describePlanChanges(candidate.changes ?? comparePlans(baseline, candidate.snapshot).changes);
}
