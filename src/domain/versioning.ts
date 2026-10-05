/**
 * 版本的创建、冲突检查与原子应用。
 *
 * 只修改纯内存对象；持久化事务由适配层负责。
 * 语义对应 docs/02 §7 与 docs/03 §5。
 */

import type { Proposal, ProposalCandidate, TripSnapshot } from './types.js';
import type { InMemoryEvidenceRegistry } from './evidence.js';
import { normalizeTripSnapshot } from './normalize.js';
import { checkPlanBoundary, preserveExecutedStops } from './plan-boundaries.js';

export interface PlanVersion {
  tripId: string;
  revision: number;
  snapshot: TripSnapshot;
  reason: string;
  createdAt: string;
  mutationId?: string;
  beforeRevision?: number;
  afterRevision?: number;
  action?: string;
  reversesId?: string | null;
}

export type ApplyResult =
  | { ok: true; version: PlanVersion }
  | { ok: false; code: string; message: string };

function isIsoLike(value: string | undefined): boolean {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isNaN(Date.parse(value));
}

/** 兼容两种调用：createInitialVersion(tripId, snapshot, createdAt, reason) 与 (tripId, snapshot, reason)。 */
export function createInitialVersion(
  tripId: string,
  snapshot: TripSnapshot,
  createdAtOrReason = 'initialize',
  maybeReason?: string,
): PlanVersion {
  const createdAt = isIsoLike(createdAtOrReason)
    ? createdAtOrReason
    : new Date().toISOString();
  const reason = maybeReason ?? (isIsoLike(createdAtOrReason) ? 'initialize' : createdAtOrReason);
  const normalized = normalizeTripSnapshot(snapshot);
  return {
    tripId,
    revision: 0,
    snapshot: { ...normalized, version: 0 },
    reason,
    createdAt,
    mutationId: `initial:${tripId}`,
    afterRevision: 0,
  };
}

function comparableTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function isActiveProposal(proposal: Proposal, now: string): boolean {
  if (proposal.status !== 'ready') return false;
  const expiresAt = comparableTime(proposal.expiresAt);
  const current = comparableTime(now);
  if (expiresAt === null || current === null) return false;
  return current < expiresAt;
}

export interface ApplyOptions {
  candidateId?: string;
  /** 允许调用方显式放宽“多个候选必须指定”的检查，用于单测旧接口。 */
  allowFirstCandidate?: boolean;
  actorId?: string;
  sessionId?: string;
  /** 检查情境快照是否与旅行 latestContextId 一致。 */
  requireContextMatch?: boolean;
  /** 应用前校验候选引用的关键证据。 */
  evidenceRegistry?: InMemoryEvidenceRegistry;
}

export function selectCandidate(
  proposal: Proposal,
  candidateId?: string,
): { ok: true; candidate: ProposalCandidate } | { ok: false; code: string; message: string } {
  const candidates = proposal.candidates ?? [];
  if (candidates.length === 0) {
    return { ok: false, code: 'INVALID_PROPOSAL', message: '提案没有候选方案。' };
  }
  if (candidateId) {
    const candidate = candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) {
      return { ok: false, code: 'CANDIDATE_NOT_FOUND', message: '候选方案不存在或不属于该提案。' };
    }
    return { ok: true, candidate };
  }
  if (candidates.length === 1) {
    return { ok: true, candidate: candidates[0] };
  }
  return { ok: false, code: 'CANDIDATE_REQUIRED', message: '请明确选择要采用的候选方案。' };
}

function candidateHasBlockingCheck(candidate: ProposalCandidate): string | null {
  if (candidate.applicability === 'needs_verification') {
    return 'candidate_needs_verification';
  }
  for (const check of candidate.checks ?? []) {
    if (check.status === 'fail') return check.reasonCode ?? 'hard_constraint_failure';
    if (check.status === 'unknown') {
      return check.reasonCode ?? 'evidence_insufficient';
    }
  }
  return null;
}

export function assertCanApply(
  proposal: Proposal,
  currentInput: TripSnapshot,
  now: string,
  options: ApplyOptions = {},
): { ok: true; candidate: ProposalCandidate } | { ok: false; code: string; message: string } {
  const current = normalizeTripSnapshot(currentInput);

  if (!isActiveProposal(proposal, now)) {
    return { ok: false, code: 'PROPOSAL_EXPIRED', message: '提案已过期，需要重新检查。' };
  }
  if (proposal.tripId !== current.tripId) {
    return { ok: false, code: 'TRIP_MISMATCH', message: '提案不属于当前行程。' };
  }
  if (proposal.baseRevision !== current.version) {
    return { ok: false, code: 'REVISION_CONFLICT', message: '行程已有更新，请查看最新安排。' };
  }
  if ((proposal.contextSnapshotId ?? null) !== (current.contextSnapshotId ?? null)) {
    return { ok: false, code: 'CONTEXT_CHANGED', message: '出发位置或现场情况已变化，请重新检查。' };
  }

  const candidateIds = (proposal.candidates ?? []).map((candidate) => candidate.candidateId);
  if (candidateIds.length === 0 || new Set(candidateIds).size !== candidateIds.length) {
    return { ok: false, code: 'INVALID_PROPOSAL', message: '提案候选为空或候选 ID 重复。' };
  }
  if (proposal.candidates.some((candidate) => candidate.snapshot.tripId !== proposal.tripId || candidate.snapshot.tripId !== current.tripId)) {
    return { ok: false, code: 'TRIP_MISMATCH', message: '候选方案不属于当前行程。' };
  }
  if (proposal.candidates.some((candidate) => normalizeTripSnapshot(candidate.snapshot).dataMode !== current.dataMode)) {
    return { ok: false, code: 'DATA_MODE_MISMATCH', message: '在线与演示数据不能混用。' };
  }

  const selected = selectCandidate(proposal, options.candidateId);
  if (!selected.ok) return selected;
  const candidate = selected.candidate;

  if (options.evidenceRegistry && (candidate.evidenceRefs ?? []).length > 0) {
    const evidence = options.evidenceRegistry.validateRefs(candidate.evidenceRefs!, now);
    if (!evidence.ok) {
      return {
        ok: false,
        code: evidence.code ?? 'EVIDENCE_INSUFFICIENT',
        message: evidence.message ?? '关键证据已失效，需要重新检查。',
      };
    }
  }

  const normalizedCandidate = normalizeTripSnapshot(candidate.snapshot);
  const boundary = checkPlanBoundary(currentInput, {
    ...normalizedCandidate,
    stops: preserveExecutedStops(normalizedCandidate.stops, current.stops),
  }, now);
  if (boundary) return { ok: false, code: 'PLAN_TIME_OR_PROGRESS_CONFLICT', message: boundary };
  const plannedDeparture = comparableTime(candidate.plannedDepartureAt);
  const currentTime = comparableTime(now);
  if (plannedDeparture !== null && currentTime !== null && currentTime > plannedDeparture) {
    return {
      ok: false,
      code: 'PROPOSAL_EXPIRED',
      message: '已超过该方案核验时使用的出发时刻，需要重新检查。',
    };
  }

  const blocking = candidateHasBlockingCheck(candidate);
  if (blocking) {
    const unknown =
      candidate.applicability === 'needs_verification' ||
      (candidate.checks ?? []).some((check) => check.status === 'unknown');
    return {
      ok: false,
      code: unknown ? 'EVIDENCE_INSUFFICIENT' : 'HARD_CONSTRAINT_VIOLATION',
      message: unknown
        ? '方案仍有待核实的关键信息，不能直接采用。'
        : '方案违反硬约束。',
    };
  }

  return { ok: true, candidate };
}

function statusAfterChecks(candidate: ProposalCandidate): TripSnapshot['planningStatus'] {
  const checks = candidate.checks ?? [];
  if (checks.some((check) => check.status === 'fail' || check.status === 'unknown')) {
    return 'needs_review';
  }
  return 'validated';
}

/**
 * 候选方案**无权改动**的字段：已发生的事实与用户确认过的设定。
 *
 * 候选快照是重新生成的（见 demo/demo-data.ts 的 buildDemoPlanSnapshot），
 * 天然不含这些字段，而且会带上自己的样例值（预算 20000、constraints 为空、lifecycle draft）。
 * 应用时若整体替换，就会：
 *   - 抹掉 executionEvents／spendEvents／walkingEvents 与累计花费、累计步行；
 *   - 把用户确认过的约束和预算上限换回样例值；
 *   - 把进行中的旅行（active）打回 draft。
 * 这直接违反"执行事实不能被覆盖"这条不变量，所以这些键一律以当前快照为准。
 */
const INHERITED_FIELDS = [
  'lifecycle',
  'constraints',
  'budget',
  'partyNeeds',
  'executionEvents',
  'spendEvents',
  'walkingEvents',
  'actualSpendMinor',
  'actualSpendComplete',
  'spendRef',
  'actualWalkingMeters',
  'actualWalkingComplete',
  'walkingRef',
] as const satisfies readonly (keyof TripSnapshot)[];

/** 只继承当前快照确实存在的键，避免把候选快照的字段抹成 undefined。 */
function inheritedFromCurrent(current: TripSnapshot): Partial<TripSnapshot> {
  const inherited: Record<string, unknown> = {};
  for (const field of INHERITED_FIELDS) {
    if (current[field] !== undefined) inherited[field] = current[field];
  }
  return inherited as Partial<TripSnapshot>;
}

/**
 * 应用提案。第三个参数之后支持 reason、candidateId 以及 options 对象。
 * 为兼容早期调用：applyProposal(proposal, current, now)。
 */
export function applyProposal(
  proposal: Proposal,
  currentInput: TripSnapshot,
  now: string,
  reason = 'apply',
  candidateOrOptions?: string | ApplyOptions,
): ApplyResult {
  const options: ApplyOptions =
    typeof candidateOrOptions === 'string'
      ? { candidateId: candidateOrOptions }
      : candidateOrOptions ?? {};
  const check = assertCanApply(proposal, currentInput, now, options);
  if (!check.ok) {
    return { ok: false, code: check.code, message: check.message };
  }

  const current = normalizeTripSnapshot(currentInput);
  const candidate = check.candidate;
  const nextRevision = current.version + 1;
  // 计划内容（节点、路线、时间线）来自候选；事实与用户设定来自当前快照。
  // 顺序不能反：先展开候选，再让当前快照里那些"候选无权改动"的键覆盖回去。
  const nextSnapshot = normalizeTripSnapshot({
    ...candidate.snapshot,
    ...inheritedFromCurrent(current),
    stops: preserveExecutedStops(candidate.snapshot.stops, current.stops),
    tripId: current.tripId,
    version: nextRevision,
    planningStatus: statusAfterChecks(candidate),
    contextSnapshotId:
      candidate.contextSnapshotId ?? proposal.contextSnapshotId ?? current.contextSnapshotId,
  });

  const nextVersion: PlanVersion = {
    tripId: current.tripId,
    revision: nextRevision,
    snapshot: nextSnapshot,
    reason,
    createdAt: now,
    mutationId: `mutation:${proposal.tripId}:${proposal.proposalId}:${candidate.candidateId}:${nextRevision}`,
    beforeRevision: current.version,
    afterRevision: nextRevision,
    action: 'plan.apply',
  };
  return { ok: true, version: nextVersion };
}

export interface UndoOptions {
  /** 当前版本必须等于最近一次 replan apply 的 afterRevision。 */
  expectedRevision?: number;
  /** 自那次应用之后有执行/费用/偏好事实时传 true。 */
  hasFactsChanged?: boolean;
  /** 重新核验后的恢复快照；若不提供则使用被撤销的 before 快照。 */
  restoredSnapshot?: TripSnapshot;
  actorId?: string;
  mutationId?: string;
}

export interface UndoResult {
  ok: boolean;
  code?: string;
  message?: string;
  version?: PlanVersion;
}

/**
 * 撤销最近一次 replan apply。只恢复计划，不删除执行事实；
 * 恢复也产生新版本，版本号单调递增。
 */
export function undoLastPlanApply(
  currentInput: TripSnapshot,
  versionToUndo: PlanVersion,
  now: string,
  options: UndoOptions = {},
): UndoResult {
  const current = normalizeTripSnapshot(currentInput);
  if (versionToUndo.action !== 'plan.apply') {
    return { ok: false, code: 'UNDO_CONFLICT', message: '只能撤销最近一次调整应用。' };
  }
  const afterRevision = versionToUndo.afterRevision ?? versionToUndo.revision;
  if (current.version !== afterRevision) {
    return { ok: false, code: 'UNDO_CONFLICT', message: '此后行程已变化，请按当前事实重新调整。' };
  }
  if (options.expectedRevision !== undefined && current.version !== options.expectedRevision) {
    return { ok: false, code: 'REVISION_CONFLICT', message: '行程已有更新，请查看最新安排。' };
  }
  if (options.hasFactsChanged) {
    return { ok: false, code: 'UNDO_CONFLICT', message: '应用后已有真实执行或费用记录，不能直接撤销。' };
  }

  const restored = normalizeTripSnapshot(
    options.restoredSnapshot ?? versionToUndo.snapshot,
  );
  const nextRevision = current.version + 1;
  const version: PlanVersion = {
    tripId: current.tripId,
    revision: nextRevision,
    snapshot: {
      ...restored,
      tripId: current.tripId,
      version: nextRevision,
      planningStatus: restored.planningStatus === 'empty' ? 'needs_review' : restored.planningStatus,
      contextSnapshotId: current.contextSnapshotId,
    },
    reason: 'plan.undo',
    createdAt: now,
    mutationId: `undo:${versionToUndo.mutationId ?? versionToUndo.revision}:${nextRevision}`,
    beforeRevision: current.version,
    afterRevision: nextRevision,
    action: 'plan.undo',
    reversesId: versionToUndo.mutationId ?? null,
  };
  return { ok: true, version };
}

export function isProposalApplicable(
  proposal: Proposal,
  current: TripSnapshot,
  now: string,
  candidateId?: string,
): boolean {
  return assertCanApply(proposal, current, now, { candidateId }).ok;
}
