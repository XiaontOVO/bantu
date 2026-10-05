/**
 * 旅行的建立、读取与手动编辑。
 *
 * 手动编辑（`patchTrip`）不经过提案与许可——它是用户改自己的行程——
 * 但仍然必须带 `expectedRevision`，且**不能**推进内容版本之外的语义：
 * 计划版本变了，已写的回忆不会因此失效（contentRevision 不动）。
 */
import { evaluateSnapshot } from '../../domain/constraints.js';
import { checkPlanBoundary } from '../../domain/plan-boundaries.js';
import { normalizeTripSnapshot } from '../../domain/normalize.js';
import { createInitialVersion, type PlanVersion } from '../../domain/versioning.js';
import type { ContextSnapshot, TripSnapshot } from '../../domain/types.js';
import { activePrincipal } from './identity.js';
import { ownedTrip, purgePastProgress, toView } from './access.js';
import { commitPlanSnapshot } from './commit.js';
import { emptyFreshSnapshot, id, serviceError } from './helpers.js';
import { isValidBudgetMinor, isValidBudgetSetting, isValidPartySize, isValidRevision } from './validation.js';
import type {
  CreateTripInput,
  FeedbackRecord,
  MutationView,
  PatchTripInput,
  ServiceResult,
  TripRecord,
  TripView,
} from './contracts.js';
import type { TripState } from './state.js';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export interface CaptureContextInput {
  capturedAt: string;
  clockRef: string;
  locationRef?: string | null;
  event?: Record<string, unknown>;
  expiresAt?: string | null;
  contextSnapshotId?: string;
}

export interface RecordFeedbackInput {
  rating?: number | null;
  reasonCode?: string | null;
  note?: string | null;
  operationId?: string | null;
}

export function createTrip(
  state: TripState,
  actorId: string,
  input: CreateTripInput,
): ServiceResult<TripView> {
  const auth = activePrincipal(state, actorId);
  if (!auth.ok) return auth;
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  if (
    !input.cityCode ||
    (input.localDate !== undefined && !isValidLocalDate(input.localDate)) ||
    !isValidTimeZone(timezone)
  ) {
    return { ok: false, error: serviceError('INVALID_INPUT', '城市、日期或时区格式无效；日期可留空表示待定，填写时需为合法日期。') };
  }
  if (!isValidPartySize(input.partySize)) {
    return { ok: false, error: serviceError('INVALID_INPUT', 'partySize 必须是正整数。') };
  }
  if (!isValidBudgetMinor(input.budgetMinor)) {
    return { ok: false, error: serviceError('INVALID_INPUT', 'budgetMinor 必须是非负有限数值或 null。') };
  }
  const tripId = id('trip');
  const now = state.now();
  const snapshot = emptyFreshSnapshot({
    tripId,
    dataMode: input.dataMode,
    timezone,
    localDate: input.localDate,
    cityCode: input.cityCode,
    partySize: input.partySize ?? 1,
    budgetMinor: input.budgetMinor,
    budgetStrength: input.budgetStrength,
  });
  const initialVersion = createInitialVersion(tripId, snapshot, now, 'initialize');
  const record: TripRecord = {
    tripId,
    ownerId: actorId,
    dataMode: input.dataMode,
    lifecycle: 'draft',
    revision: 0,
    contentRevision: 0,
    timezone,
    localDate: input.localDate,
    cityCode: input.cityCode,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    latestContextId: null,
    snapshot: initialVersion.snapshot,
    versions: [initialVersion],
    proposals: new Map(),
    mutations: [],
    memories: { tripId, contentRevision: 0, entries: [] },
    shortlist: [],
    feedback: [],
  };
  state.trips.set(tripId, record);
  return { ok: true, value: toView(state, record) };
}

export function getTrip(
  state: TripState,
  actorId: string,
  tripId: string,
): ServiceResult<TripView> {
  const trip = ownedTrip(state, actorId, tripId);
  if (!trip.ok) return trip;
  return { ok: true, value: toView(state, trip.value) };
}

/** 列表按最近更新排序：用户最可能关心刚动过的那一趟。 */
export function listTrips(state: TripState, actorId: string): ServiceResult<TripView[]> {
  const auth = activePrincipal(state, actorId);
  if (!auth.ok) return auth;
  const owned = [...state.trips.values()]
    .filter((trip) => trip.ownerId === actorId && !trip.deletedAt);
  for (const trip of owned) purgePastProgress(state, trip);
  const trips = owned
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((trip) => toView(state, trip));
  return { ok: true, value: trips };
}

/** Background maintenance entry point: expire dated plans and progress in every trip. */
export function purgePastProgressForAll(state: TripState): number {
  let changed = 0;
  for (const trip of state.trips.values()) {
    if (trip.deletedAt) continue;
    if (purgePastProgress(state, trip)) changed += 1;
  }
  return changed;
}

export interface VersionSummary {
  revision: number;
  reason: string;
  createdAt: string;
  mutationId: string | null;
  action: string | null;
  /** 该版本的计划预览：非跳过站点的地点名（按顺序）。 */
  placeNames: string[];
}

export function listVersions(
  state: TripState,
  actorId: string,
  tripId: string,
): ServiceResult<VersionSummary[]> {
  const trip = ownedTrip(state, actorId, tripId);
  if (!trip.ok) return trip;
  return {
    ok: true,
    value: trip.value.versions.map((version) => ({
      revision: version.revision,
      reason: version.reason,
      createdAt: version.createdAt,
      mutationId: version.mutationId ?? null,
      action: version.action ?? null,
      placeNames: (version.snapshot.stops ?? [])
        .filter((stop) => stop.status !== 'skipped')
        .map((stop) => stop.place?.name || stop.placeId || '')
        .filter(Boolean),
    })),
  };
}

export function getVersion(state: TripState, actorId: string, tripId: string, revision: number): ServiceResult<PlanVersion> {
  const trip = ownedTrip(state, actorId, tripId);
  if (!trip.ok) return trip;
  const version = trip.value.versions.find((item) => item.revision === revision);
  return version ? { ok: true, value: structuredClone(version) }
    : { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '该计划快照不存在。') };
}

export function listShortlist(
  state: TripState,
  actorId: string,
  tripId: string,
): ServiceResult<string[]> {
  const trip = ownedTrip(state, actorId, tripId);
  if (!trip.ok) return trip;
  return { ok: true, value: [...trip.value.shortlist] };
}

export function addShortlist(
  state: TripState,
  actorId: string,
  tripId: string,
  placeId: string,
): ServiceResult<string[]> {
  const trip = ownedTrip(state, actorId, tripId);
  if (!trip.ok) return trip;
  if (!placeId) return { ok: false, error: serviceError('INVALID_INPUT', '地点 ID 不能为空。') };
  // 收藏是独立清单：增删都不碰正式计划，所以不生成版本。
  if (!trip.value.shortlist.includes(placeId)) trip.value.shortlist.push(placeId);
  state.trips.set(tripId, trip.value);
  return { ok: true, value: [...trip.value.shortlist] };
}

export function removeShortlist(
  state: TripState,
  actorId: string,
  tripId: string,
  placeId: string,
): ServiceResult<string[]> {
  const trip = ownedTrip(state, actorId, tripId);
  if (!trip.ok) return trip;
  trip.value.shortlist = trip.value.shortlist.filter((item) => item !== placeId);
  state.trips.set(tripId, trip.value);
  return { ok: true, value: [...trip.value.shortlist] };
}

/** 自愿反馈不改变规划 revision，也不参与 Agent 授权。 */
export function recordFeedback(
  state: TripState,
  actorId: string,
  tripId: string,
  input: RecordFeedbackInput,
): ServiceResult<FeedbackRecord> {
  const trip = ownedTrip(state, actorId, tripId);
  if (!trip.ok) return trip;
  const record: FeedbackRecord = {
    feedbackId: `feedback_${Math.random().toString(36).slice(2, 10)}`,
    tripId,
    rating:
      typeof input.rating === 'number' && input.rating >= 1 && input.rating <= 5
        ? input.rating
        : null,
    reasonCode: input.reasonCode ?? null,
    note: input.note ?? null,
    operationId: input.operationId ?? null,
    createdAt: state.now(),
  };
  trip.value.feedback.push(record);
  trip.value.updatedAt = record.createdAt;
  state.trips.set(tripId, trip.value);
  return { ok: true, value: record };
}

export function patchTrip(
  state: TripState,
  actorId: string,
  tripId: string,
  input: PatchTripInput,
): ServiceResult<TripView> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  if (!isValidRevision(input.expectedRevision)) {
    return { ok: false, error: serviceError('INVALID_INPUT', 'expectedRevision 必须是非负整数。') };
  }
  if (!isValidPartySize(input.partySize) || !isValidBudgetSetting(input.budget)) {
    return { ok: false, error: serviceError('INVALID_INPUT', '同行人数或预算金额无效。') };
  }
  if (record.revision !== input.expectedRevision) {
    return {
      ok: false,
      error: serviceError('REVISION_CONFLICT', '行程已有更新，请查看最新安排。', {
        currentRevision: record.revision,
      }),
    };
  }
  if (record.lifecycle === 'archived') {
    return { ok: false, error: serviceError('INVALID_TRIP_STATE', '归档旅行不能修改计划。') };
  }

  if (input.localDate !== undefined && !isValidLocalDate(input.localDate)) {
    return { ok: false, error: serviceError('INVALID_INPUT', '旅行日期必须是有效的 YYYY-MM-DD 日期。') };
  }

  // expectedRevision 只用于并发控制；不把它写进快照。
  const { expectedRevision: _expectedRevision, allowPast: _allowPast, ...patch } = input;
  const current = normalizeTripSnapshot(record.snapshot);
  if (
    record.lifecycle === 'active' &&
    patch.cityCode !== undefined && patch.cityCode !== record.cityCode &&
    (current.executionEvents?.length || 0) > 0
  ) {
    return { ok: false, error: serviceError('INVALID_TRIP_STATE', '已经记录旅行进度后不能更改旅行城市。') };
  }
  // 同一 stopId 只保留首条：跨日挂载会把「进度事实 + 方案站点」合并提交，
  // 客户端旧版本或竞态可能送入重复 ID；事实在前，首条即事实，重复条目会让执行动作全部失效。
  const rawStops = patch.stops ?? current.stops;
  const seenStopIds = new Set<string>();
  const nextStops = rawStops.filter((stop) => {
    const id = String(stop.stopId ?? '');
    if (seenStopIds.has(id)) return false;
    seenStopIds.add(id);
    return true;
  });
  if (patch.stops) {
    const protectedStop = current.stops.find((stop) => stop.status !== 'planned' &&
      JSON.stringify(nextStops.find((item) => item.stopId === stop.stopId)) !== JSON.stringify(stop));
    if (protectedStop) return { ok: false, error: serviceError('EXECUTION_FACT_PROTECTED', '已发生的进度不能通过改计划覆盖，请只调整尚未出发的节点。') };
  }
  const nextConstraints = patch.constraints ?? current.constraints ?? [];
  const nextSnapshot: TripSnapshot = normalizeTripSnapshot({
    ...current,
    ...patch,
    travelDate: patch.localDate ?? current.travelDate,
    stops: nextStops,
    routeLegs: patch.routeLegs ?? current.routeLegs,
    constraints: nextConstraints,
    tripSettings: {
      ...(current.tripSettings ?? {}),
      cityCode: patch.cityCode ?? record.cityCode,
      localDate: patch.localDate ?? record.localDate,
      partySize: patch.partySize ?? current.tripSettings?.partySize ?? 1,
    },
    budget: patch.budget === undefined ? current.budget : patch.budget,
    lifecycle: record.lifecycle,
    planningStatus: current.stops.length === 0 ? 'empty' : 'needs_review',
    version: record.revision + 1,
  });
  const validation = evaluateSnapshot(nextSnapshot, nextConstraints);
  const boundary = checkPlanBoundary(current, nextSnapshot, state.now(), { allowPast: input.allowPast === true });
  if (boundary) return { ok: false, error: serviceError('PLAN_TIME_OR_PROGRESS_CONFLICT', boundary) };
  const version: PlanVersion = {
    tripId,
    revision: record.revision + 1,
    snapshot: { ...nextSnapshot, planningStatus: validation.planningStatus },
    reason: 'trip.patch',
    createdAt: state.now(),
    beforeRevision: record.revision,
    afterRevision: record.revision + 1,
    action: 'trip.patch',
  };
  const mutation: MutationView = {
    mutationId: id('mutation'),
    tripId,
    actorId,
    action: 'trip.patch',
    beforeRevision: record.revision,
    afterRevision: version.revision,
    reversesId: null,
    createdAt: version.createdAt,
  };
  record.localDate = nextSnapshot.travelDate ?? record.localDate;
  record.cityCode = patch.cityCode ?? record.cityCode;
  commitPlanSnapshot(state, record, version, mutation);
  return { ok: true, value: toView(state, record) };
}

/** 位置/现场更新 latestContextId，不改变 revision。 */
export function captureContext(
  state: TripState,
  actorId: string,
  tripId: string,
  input: CaptureContextInput,
): ServiceResult<ContextSnapshot> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  const context: ContextSnapshot = {
    contextSnapshotId: input.contextSnapshotId ?? id('ctx'),
    tripId,
    dataMode: record.dataMode,
    capturedAt: input.capturedAt,
    clockRef: input.clockRef,
    locationRef: input.locationRef ?? null,
    event: input.event ?? {},
    executionRevision: record.revision,
    expiresAt: input.expiresAt ?? null,
  };
  record.latestContextId = context.contextSnapshotId;
  record.snapshot = normalizeTripSnapshot({
    ...record.snapshot,
    contextSnapshotId: context.contextSnapshotId,
  });
  record.updatedAt = input.capturedAt;
  state.trips.set(tripId, record);
  return { ok: true, value: context };
}
