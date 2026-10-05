/**
 * 执行事实与旅行阶段：进度、纠正、花费、步行，以及 start／finish／archive。
 *
 * 全模块最重要的一条不变量：**计划版本与执行事实分开**。
 * 用户报告"我到下一站了"不会推进计划 revision 的语义，
 * 而计划调整也永远不会抹掉已经发生的进度。
 *
 * 例外只有一处，且是刻意的：`start/finish/archive` 会写版本（阶段是计划的一部分），
 * 但它们**不推进内容版本**（`contentChanged = false`）——阶段变化不该让已写的回忆失效。
 */
import {
  applyExecutionCorrection,
  applyExecutionEvent,
  archiveTrip as archiveTripDomain,
  finishTrip as finishTripDomain,
  recordSpendEvent,
  recordWalkingEvent,
  startTrip as startTripDomain,
  type ExecutionMutationResult,
  type FactRecordResult,
} from '../../domain/execution.js';
import { invalidateJourneyMemoryForEvent } from '../../domain/memory.js';
import { normalizeTripSnapshot } from '../../domain/normalize.js';
import type { PlanVersion } from '../../domain/versioning.js';
import type { ExecutionEventType, PlanStop, StopStatus, TripSnapshot } from '../../domain/types.js';
import { activePrincipal } from './identity.js';
import { ownedTrip, toView } from './access.js';
import { commitPlanSnapshot } from './commit.js';
import { id, serviceError } from './helpers.js';
import { isValidRevision } from './validation.js';
import type {
  ExecutionCommand,
  MutationView,
  ServiceResult,
  SpendCommand,
  TripRecord,
  TripView,
} from './contracts.js';
import type { TripState } from './state.js';

export interface ExecutionCorrectionCommand {
  actorId: string;
  tripId: string;
  eventIdToCorrect: string;
  statusOverride?: StopStatus;
  correctionReason?: string;
  type: ExecutionEventType;
  occurredAt?: string;
  expectedRevision?: number;
  now?: string;
}

export interface WalkingCommand {
  actorId: string;
  tripId: string;
  walkingMeters: number;
  completenessConfirmed: boolean;
  occurredAt: string;
  expectedRevision?: number;
  now?: string;
}

/** 记录版本冲突；所有执行类入口共用同一条错误文案。 */
function revisionConflict(): ServiceResult<TripView> {
  return { ok: false, error: serviceError('REVISION_CONFLICT', '行程已有更新，请查看最新安排。') };
}

/** 已结束的行程允许修正历史事实，但不能再增加新的执行事实。 */
function executionAllowed(record: TripRecord): boolean {
  return record.lifecycle === 'active' || record.lifecycle === 'completed';
}

/** 按旅行时区取得日期；发生时间无效或时区无效时返回 null。 */
function localDateAt(value: string, timezone: string): string | null {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(instant);
    const part = (name: string) => parts.find((item) => item.type === name)?.value;
    const year = part('year'); const month = part('month'); const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

function nextLocalDate(value: string): string | null {
  const day = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) return null;
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** 午夜后只允许继续前一天已经留下出发／到达事实的进行中节点。 */
function isOvernightContinuation(
  snapshot: TripSnapshot,
  stop: PlanStop,
  plannedDate: string,
  currentDate: string,
  occurredDate: string,
  timezone: string,
): boolean {
  const status = stop.status ?? 'planned';
  if (!['en_route', 'visiting'].includes(status) || nextLocalDate(plannedDate) !== currentDate || occurredDate !== currentDate) return false;
  const events = snapshot.executionEvents ?? [];
  const correctedIds = new Set(events.flatMap((event) => event.correctsEventId ? [event.correctsEventId] : []));
  const latest = [...events].reverse().find((event) => event.stopId === stop.stopId && !correctedIds.has(event.executionEventId));
  const expectedType = status === 'en_route' ? 'depart' : 'arrive';
  return latest?.type === expectedType && localDateAt(latest.occurredAt, timezone) === plannedDate;
}

function executionDateError(message: string): ServiceResult<TripView> {
  return { ok: false, error: serviceError('EXECUTION_DATE_CONFLICT', message) };
}

function rejectFutureFact(occurredAt: string, now: string): ServiceResult<TripView> | null {
  const occurredInstant = Date.parse(occurredAt);
  const nowInstant = Date.parse(now);
  if (!Number.isFinite(nowInstant)) return executionDateError('无法确认当前时间，请同步后重试。');
  if (Number.isFinite(occurredInstant) && occurredInstant > nowInstant) {
    return executionDateError('不能记录尚未发生的旅行事实。');
  }
  return null;
}

/**
 * 把领域层算出的新快照落成版本，并按需推进内容版本。
 *
 * `contentChanged=false` 用于阶段切换：它改计划，但不改"旅行记录基于的内容"。
 */
function commitExecutionResult(
  state: TripState,
  record: TripRecord,
  result: ExecutionMutationResult | FactRecordResult,
  action: string,
  actorId: string,
  contentChanged = true,
): ServiceResult<TripView> {
  if (!result.ok || !result.snapshot) {
    return {
      ok: false,
      error: serviceError(
        result.error?.code ?? 'INVALID_INPUT',
        result.error?.message ?? '执行事实写入失败。',
      ),
    };
  }
  const before = record.revision;
  const snapshot = normalizeTripSnapshot(result.snapshot);
  const version: PlanVersion = {
    tripId: record.tripId,
    revision: snapshot.version,
    snapshot,
    reason: action,
    createdAt: state.now(),
    beforeRevision: before,
    afterRevision: snapshot.version,
    action,
  };
  const mutation: MutationView = {
    mutationId: id('mutation'),
    tripId: record.tripId,
    actorId,
    action,
    beforeRevision: before,
    afterRevision: snapshot.version,
    reversesId: null,
    createdAt: version.createdAt,
  };
  commitPlanSnapshot(state, record, version, mutation);
  if (contentChanged) {
    record.contentRevision += 1;
    record.memories.contentRevision = record.contentRevision;
  }
  return { ok: true, value: toView(state, record) };
}

export function recordExecution(
  state: TripState,
  command: ExecutionCommand,
): ServiceResult<TripView> {
  // 执行事实按会话鉴权：它是"我此刻在现场"的记录，不是可离线补的编辑。
  const auth = activePrincipal(state, command.actorId, command.sessionId);
  if (!auth.ok) return auth;
  const tripResult = ownedTrip(state, command.actorId, command.tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  if (command.expectedRevision !== undefined && record.revision !== command.expectedRevision) {
    return revisionConflict();
  }
  if (record.lifecycle !== 'draft' && record.lifecycle !== 'active') {
    return { ok: false, error: serviceError('INVALID_TRIP_STATE', '当前阶段不能记录执行事实。') };
  }
  const snapshot = record.snapshot;
  const stop = (snapshot.stops ?? []).find((item) => item.stopId === command.stopId);
  const plannedDate = stop?.date ?? snapshot.travelDate ?? snapshot.localDate ?? snapshot.tripSettings?.localDate ?? record.localDate;
  const now = command.now ?? state.now();
  const futureExecution = rejectFutureFact(command.occurredAt, now);
  if (futureExecution) return futureExecution;
  if (stop && plannedDate) {
    const timezone = snapshot.timezone || record.timezone || 'Asia/Shanghai';
    const currentDate = localDateAt(now, timezone);
    const occurredDate = localDateAt(command.occurredAt, timezone);
    if (!currentDate || !occurredDate) {
      return executionDateError('无法确认旅行当地日期，请检查计划时区和进度时间。');
    }
    const overnightContinuation = record.lifecycle === 'active' && isOvernightContinuation(
      snapshot, stop, plannedDate, currentDate, occurredDate, timezone,
    );
    // 进行中的旅行只接受当天节点；午夜后仅可继续前一天已经开始的节点。
    if (plannedDate !== currentDate && !overnightContinuation) {
      return executionDateError(plannedDate < currentDate
        ? '计划日期已过，不能继续执行；请调整旅行日期，或结束旅行后补记真实发生的进度。'
        : '还没到这站的计划日期，请在当天记录进度。');
    }
    if (occurredDate !== plannedDate && !overnightContinuation) {
      return executionDateError(`这站安排在 ${plannedDate}，只能记录该日真实发生的进度。`);
    }
    if (occurredDate > currentDate) {
      return executionDateError('不能提前记录未来日期的进度。');
    }
  }
  const result = applyExecutionEvent(record.snapshot, {
    stopId: command.stopId,
    type: command.type,
    occurredAt: command.occurredAt,
    recordedAt: command.now ?? state.now(),
    userReported: true,
  });
  // 首次有效进度与阶段变化一次提交；失败不启动旅行，也不产生多余快照。
  if (result.ok && result.snapshot && record.lifecycle === 'draft') result.snapshot.lifecycle = 'active';
  return commitExecutionResult(state, record, result, `execution.${command.type}`, command.actorId);
}

export function recordExecutionCorrection(
  state: TripState,
  command: ExecutionCorrectionCommand,
): ServiceResult<TripView> {
  const tripResult = ownedTrip(state, command.actorId, command.tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  if (command.expectedRevision !== undefined && record.revision !== command.expectedRevision) {
    return revisionConflict();
  }
  if (!executionAllowed(record)) {
    return { ok: false, error: serviceError('INVALID_TRIP_STATE', '当前阶段不能记录执行事实。') };
  }
  const correctionTarget = (record.snapshot.executionEvents || []).find(event => event.executionEventId === command.eventIdToCorrect);
  const correctionTime = command.occurredAt ?? correctionTarget?.occurredAt;
  if (correctionTime) {
    const futureCorrection = rejectFutureFact(correctionTime, command.now ?? state.now());
    if (futureCorrection) return futureCorrection;
  }
  const result = applyExecutionCorrection(record.snapshot, {
    eventIdToCorrect: command.eventIdToCorrect,
    statusOverride: command.statusOverride,
    correctionReason: command.correctionReason,
    type: command.type,
    occurredAt: command.occurredAt,
    recordedAt: command.now ?? state.now(),
  });
  if (record.lifecycle === 'completed' && result.ok && (result.snapshot?.stops ?? []).some(stop =>
    !['completed', 'skipped'].includes(stop.status ?? 'planned'),
  )) {
    return { ok: false, error: serviceError('INVALID_TRIP_STATE', '已结束的行程只能修正为已完成或已跳过的进度。') };
  }
  if (result.ok && correctionTarget) {
    record.memories = invalidateJourneyMemoryForEvent(
      record.memories,
      correctionTarget.executionEventId,
      command.now ?? state.now(),
    );
  }
  return commitExecutionResult(state, record, result, 'execution.correct', command.actorId);
}

/** start／finish／archive：校验版本后切阶段，不推进内容版本。 */
function transition(
  state: TripState,
  actorId: string,
  tripId: string,
  expectedRevision: number,
  apply: (snapshot: TripRecord['snapshot']) => ExecutionMutationResult,
  action: string,
): ServiceResult<TripView> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  if (!isValidRevision(expectedRevision)) {
    return { ok: false, error: serviceError('INVALID_INPUT', 'expectedRevision 必须是非负整数。') };
  }
  if (record.revision !== expectedRevision) {
    return { ok: false, error: serviceError('REVISION_CONFLICT', '行程已有更新。') };
  }
  return commitExecutionResult(state, record, apply(record.snapshot), action, actorId, false);
}

export function startTrip(
  state: TripState,
  actorId: string,
  tripId: string,
  expectedRevision: number,
): ServiceResult<TripView> {
  return transition(state, actorId, tripId, expectedRevision, startTripDomain, 'trip.start');
}

export function finishTrip(
  state: TripState,
  actorId: string,
  tripId: string,
  expectedRevision: number,
): ServiceResult<TripView> {
  return transition(state, actorId, tripId, expectedRevision, finishTripDomain, 'trip.finish');
}

export function archiveTrip(
  state: TripState,
  actorId: string,
  tripId: string,
  expectedRevision: number,
): ServiceResult<TripView> {
  return transition(state, actorId, tripId, expectedRevision, archiveTripDomain, 'trip.archive');
}

export function recordSpend(
  state: TripState,
  command: SpendCommand,
): ServiceResult<TripView> {
  const tripResult = ownedTrip(state, command.actorId, command.tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  if (command.expectedRevision !== undefined && record.revision !== command.expectedRevision) {
    return { ok: false, error: serviceError('REVISION_CONFLICT', '行程已有更新。') };
  }
  const futureSpend = rejectFutureFact(command.occurredAt, command.now ?? state.now());
  if (futureSpend) return futureSpend;
  const result = recordSpendEvent(record.snapshot, {
    amountMinor: command.amountMinor,
    completenessConfirmed: command.completenessConfirmed,
    includedChargeIds: command.includedChargeIds,
    occurredAt: command.occurredAt,
    recordedAt: command.now ?? state.now(),
  });
  return commitExecutionResult(state, record, result, 'spend.record', command.actorId);
}

export function recordWalking(
  state: TripState,
  command: WalkingCommand,
): ServiceResult<TripView> {
  const tripResult = ownedTrip(state, command.actorId, command.tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  if (command.expectedRevision !== undefined && record.revision !== command.expectedRevision) {
    return { ok: false, error: serviceError('REVISION_CONFLICT', '行程已有更新。') };
  }
  const futureWalking = rejectFutureFact(command.occurredAt, command.now ?? state.now());
  if (futureWalking) return futureWalking;
  const result = recordWalkingEvent(record.snapshot, {
    walkingMeters: command.walkingMeters,
    completenessConfirmed: command.completenessConfirmed,
    occurredAt: command.occurredAt,
    recordedAt: command.now ?? state.now(),
  });
  return commitExecutionResult(state, record, result, 'walking.record', command.actorId);
}
