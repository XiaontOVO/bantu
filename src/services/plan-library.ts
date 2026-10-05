/**
 * 我的方案库：计划（某一天）与方案（多天集合）的全局库。
 *
 * - 计划（kind='plan'）：单一天的安排；
 * - 方案（kind='scheme'）：多天计划的集合（days[0]=第 1 天…），装入旅行时确定起始日期；
 * - 方案是"计划的设计稿"——保存/删除不影响任何旅行的当前计划与实际进度。
 */
import { createHash, randomUUID } from 'node:crypto';
import { normalizeSchemeDays } from '../../public/lib/scheme-days.js';
import { isDeepStrictEqual } from 'node:util';
import { applyExecutionCorrection, applyExecutionEvent, replayExecutionEvents } from '../domain/execution.js';
import { getStopEnd, getStopStart, normalizePlanStop, normalizeRouteLeg } from '../domain/normalize.js';
import { projectExecutionSchedule } from '../domain/execution-schedule.js';
import { addPlanDate, daytimePlanPreview } from './plan-daytime.js';
import type { ExecutionEvent, ExecutionEventType, JourneyMemoryPlace, PlanStop, RouteLeg, StopStatus, TransportMode, TripSnapshot } from '../domain/types.js';

export interface SavedPlanDay {
  dayIndex: number;
  /** 组成这一天的计划（如来自方案库引用，仅记录）。 */
  planId?: string;
  stops: unknown[];
  routeLegs: unknown[];
  plannedCharges?: unknown[];
}

/** A prior content revision of a single-day saved plan. */
export interface SavedPlanVersion {
  revision: number;
  createdAt: string;
  name: string;
  cityCode: string;
  localDate?: string;
  timezone?: string;
  stops: unknown[];
  routeLegs: unknown[];
  plannedCharges: unknown[];
}

export interface SavedPlan {
  id: string;
  ownerId: string;
  /** 来源旅行（如有）；仅作记录，方案本身不归属任何旅行。 */
  tripId?: string;
  kind: 'plan' | 'scheme';
  name: string;
  cityCode: string;
  /** 出行日期；未定日期的方案没有此字段。 */
  localDate?: string;
  /** 日期所属时区；旧数据缺失时按 Asia/Shanghai 处理。 */
  timezone?: string;
  savedAt: string;
  source: 'current' | 'candidate' | 'draft' | 'imported';
  /** 载入来源方案（展开成每日计划时记录，用于幂等重载）。 */
  sourceSchemeId?: string;
  /** 内部幂等键：自动归档的过期日计划只生成一次。 */
  archiveKey?: string;
  archiveDate?: string;
  /** 展开来源方案中的第几天（从 0 开始），用于方案改期时稳定顺延。 */
  sourceDayIndex?: number;
  /** kind='plan'：单日内容。 */
  stops: unknown[];
  routeLegs: unknown[];
  plannedCharges: unknown[];
  /** kind='scheme'：多天计划集合（dayIndex 0 = 第 1 天）。 */
  days?: SavedPlanDay[];
  /** kind='plan'：最近最多 5 份旧内容；不随普通方案列表返回。 */
  versions?: SavedPlanVersion[];
  /** 独立于 Trip 的当日日程进度；scheme 不使用这两个字段。 */
  revision?: number;
  executionEvents?: ExecutionEvent[];
  /** 仅出现在执行响应的视图拷贝上：本次记录把多少站点顺延迁入了次日的计划（T7）。不持久化。 */
  migratedNextDayStops?: number;
  /** Internal linkage for the current departure; never used to undo later edits. */
  departureCarry?: { stopId: string; movedStopIds: string[] };
  /** Abort response only: pending visits carried into another date by this departure. */
  interruptedArrangements?: Array<{ planId: string; localDate: string; stopId: string; names: string[]; canMoveToDaytime: boolean }>;
  needsReview?: boolean;
  /** 随行确认回执随计划持久化；查询预览不产生业务写入。 */
  companionReceipts?: Array<{ actionKey: string; previewId: string; requestDigest: string; appliedRevision: number; appliedAt: string }>;
  /** 原日计划转入往日记录的时间；保留原始内容、版本与完整执行事件。 */
  historyArchivedAt?: string;
  /** 历史详情的计算字段，不写回原始记录。 */
  canEditHistory?: boolean;
  historyEditUntilDate?: string;
}

interface JourneyMemoryDetails {
  places: JourneyMemoryPlace[];
  firstEventAt: string | null;
  completedAt: string | null;
  elapsedMinutes: number | null;
}

type JourneyMemoryWriter = (actorId: string, plan: SavedPlan, generatedBy: 'manual' | 'expiry', details: JourneyMemoryDetails) => void;

export interface ExpiredTripPlanDay {
  ownerId: string;
  tripId: string;
  cityCode: string;
  timezone: string;
  date: string;
  stops: unknown[];
  routeLegs: unknown[];
  plannedCharges?: unknown[];
}

interface LegacyTripViewForMigration {
  trip: {
    tripId: string;
    lifecycle: string;
    timezone?: string;
    localDate?: string;
    cityCode?: string;
  };
  snapshot: TripSnapshot;
  clock?: { date?: string };
}

function unexecutedStops(stops: unknown[]): unknown[] {
  if (!Array.isArray(stops)) return [];
  return stops.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const stop = value as Record<string, unknown>;
    if (stop.status !== undefined && stop.status !== null && stop.status !== 'planned') return [];
    const copy: Record<string, unknown> = { ...stop, status: 'planned' };
    delete copy.date;
    return [copy];
  });
}

function routesForStops(routeLegs: unknown[], stops: unknown[]): unknown[] {
  if (!Array.isArray(routeLegs)) return [];
  const stopIds = new Set(stops.flatMap(stop => {
    if (!stop || typeof stop !== 'object') return [];
    const id = (stop as Record<string, unknown>).stopId;
    return typeof id === 'string' ? [id] : [];
  }));
  return routeLegs.filter(value => {
    if (!value || typeof value !== 'object') return false;
    const leg = value as Record<string, unknown>;
    return typeof leg.toStopId === 'string' && stopIds.has(leg.toStopId) &&
      (leg.fromStopId === 'origin' || leg.fromStopId === 'my-location' ||
        (typeof leg.fromStopId === 'string' && stopIds.has(leg.fromStopId)));
  });
}

function chargesForDay(charges: unknown[], stops: unknown[], routeLegs: unknown[], date?: string): unknown[] {
  if (!Array.isArray(charges)) return [];
  const stopIds = new Set(stops.flatMap(stop => {
    if (!stop || typeof stop !== 'object') return [];
    const id = (stop as Record<string, unknown>).stopId;
    return typeof id === 'string' ? [id] : [];
  }));
  const routeIds = new Set(routeLegs.flatMap(route => {
    if (!route || typeof route !== 'object') return [];
    const id = (route as Record<string, unknown>).legId;
    return typeof id === 'string' ? [id] : [];
  }));
  const seenStandalone = new Set<string>();
  return charges.filter(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const charge = value as Record<string, unknown>;
    const chargeDate = charge.date ?? charge.localDate;
    if (typeof chargeDate === 'string' && date && chargeDate !== date) return false;
    if (typeof charge.stopId === 'string' && !stopIds.has(charge.stopId)) return false;
    if (typeof charge.routeLegRef === 'string' && !routeIds.has(charge.routeLegRef)) return false;
    const key = standaloneChargeKey(charge);
    if (key) {
      if (seenStandalone.has(key)) return false;
      seenStandalone.add(key);
    }
    return true;
  });
}

/** Fingerprint a fee that is not attached to a date, stop, or route. */
function standaloneChargeKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const charge = value as Record<string, unknown>;
  const isSet = (item: unknown) => item !== undefined && item !== null && item !== '';
  if (isSet(charge.date) || isSet(charge.localDate) || isSet(charge.stopId) || isSet(charge.routeLegRef)) return null;
  const chargeId = typeof charge.chargeId === 'string' ? charge.chargeId.trim() : '';
  // chargeId is the stable identity; execution metadata may differ between copied
  // day plans even though they represent the same trip-level fee.
  return chargeId ? `id:${chargeId}` : `value:${JSON.stringify(charge)}`;
}

function planStopsCityCodes(stops: unknown[]): string[] {
  const codes = new Set<string>();
  for (const value of stops) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const stop = value as Record<string, unknown>;
    if (stop.status === 'skipped' || !stop.place || typeof stop.place !== 'object' || Array.isArray(stop.place)) continue;
    const code = (stop.place as Record<string, unknown>).cityCode;
    if (typeof code === 'string' && /^\d{6}$/.test(code) && code !== '000000') codes.add(code);
  }
  return [...codes];
}

function resolvePlanCityCode(stops: unknown[], preferred?: unknown): string {
  const placeCities = planStopsCityCodes(stops);
  if (placeCities.length) return placeCities[0];
  const candidate = typeof preferred === 'string' ? preferred.trim() : '';
  return /^\d{6}$/.test(candidate) ? candidate : '000000';
}

function planStopsFromDays(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(day => day && typeof day === 'object' && !Array.isArray(day) && Array.isArray((day as Record<string, unknown>).stops)
    ? (day as Record<string, unknown>).stops as unknown[]
    : []);
}

function normalizedArchiveStops(stops: unknown[]) {
  return stops.map(stop => stop && typeof stop === 'object' && !Array.isArray(stop)
    ? normalizePlanStop(stop as PlanStop)
    : stop);
}

function normalizedArchiveRoutes(routeLegs: unknown[]) {
  return routeLegs.map(route => route && typeof route === 'object' && !Array.isArray(route)
    ? normalizeRouteLeg(route as RouteLeg)
    : route);
}

function samePlanContent(left: Pick<SavedPlanDay, 'stops' | 'routeLegs' | 'plannedCharges'>, stops: unknown[], routeLegs: unknown[], plannedCharges: unknown[]) {
  return isDeepStrictEqual(normalizedArchiveStops(Array.isArray(left.stops) ? left.stops : []), normalizedArchiveStops(stops)) &&
    isDeepStrictEqual(normalizedArchiveRoutes(Array.isArray(left.routeLegs) ? left.routeLegs : []), normalizedArchiveRoutes(routeLegs)) &&
    isDeepStrictEqual(left.plannedCharges || [], plannedCharges);
}

/**
 * Execution facts are replayed from the event log.  Editing a dated plan may
 * change pending stops, but it must not rewrite the place or schedule that an
 * already executed stop records.  Compare normalized scheduling fields so
 * legacy aliases (for example arrival + duration) do not create a false
 * difference.
 */
function executedStopSignature(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stop = normalizePlanStop(value as PlanStop) as PlanStop & Record<string, unknown>;
  return {
    stopId: stop.stopId,
    placeId: stop.placeId,
    startMinutes: stop.startMinutes,
    endMinutes: stop.endMinutes,
    departureMinutes: stop.departureMinutes,
    plannedArrivalMinutes: stop.plannedArrivalMinutes,
    plannedStartMinutes: stop.plannedStartMinutes,
    plannedDepartureMinutes: stop.plannedDepartureMinutes,
    plannedDurationMinutes: stop.plannedDurationMinutes,
    minDurationMinutes: stop.minDurationMinutes,
    durationSeconds: stop.durationSeconds,
    minDurationSeconds: stop.minDurationSeconds,
  };
}

/** 方案只保存安排意图，不把执行历史带进可复用模板。skipped 保留为用户主动排除该地点的选择。 */
const stripStopDate = (stop: unknown, preserveExecution = false): unknown => {
  if (!stop || typeof stop !== 'object') return stop;
  const copy = { ...(stop as Record<string, unknown>) };
  delete copy.date;
  if (!preserveExecution) for (const field of ['originalPlanOrder', 'propagatedDepartureDelayMinutes', 'travelStartMinutes',
    'estimatedTravelMinutes', 'estimatedTransportMode']) delete copy[field];
  for (const field of ['forecastStartMinutes', 'forecastEndMinutes',
    'actualArrivalMinutes', 'actualCompletionMinutes', 'transferTimeUnknown', 'executionOverdue', 'forecastConflict']) delete copy[field];
  if (copy.status !== 'skipped') copy.status = 'planned';
  return copy;
};
const stripStopDates = (stops: unknown[], preserveExecution = false): unknown[] => stops.map(stop => stripStopDate(stop, preserveExecution));

/** Sort stops by an explicitly supplied planned start, without manufacturing a default time. */
function explicitStopStart(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stop = value as Record<string, unknown>;
  for (const field of [
    'startMinutes', 'plannedStartMinutes', 'plannedArrivalMinutes', 'plannedDepartureMinutes', 'departureMinutes',
  ]) {
    const minutes = stop[field];
    if (typeof minutes === 'number' && Number.isFinite(minutes)) return minutes;
  }
  return null;
}

/** Stable ordering keeps untimed legacy stops together at the end in their original order. */
function sortStopsByStartTime(stops: unknown[]): unknown[] {
  return stops
    .map((stop, index) => ({ stop, index, start: explicitStopStart(stop) }))
    .sort((left, right) => {
      if (left.start === null) return right.start === null ? left.index - right.index : 1;
      if (right.start === null) return -1;
      return left.start - right.start || left.index - right.index;
    })
    .map(item => item.stop);
}

function planStopRange(value: unknown): { start: number; end: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Apply the same aliases and duration fallbacks as snapshot normalization.
  // Older saved plans may contain only arrival + duration, so checking only
  // explicit end fields lets them overlap progress and fail later on mount.
  const stop = normalizePlanStop(value as PlanStop);
  const start = getStopStart(stop);
  const end = getStopEnd(stop);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function progressStopRange(value: PlanStop): { start: number; end: number } | null {
  const range = planStopRange(value);
  const actualEnd = (value as PlanStop & { progressEndMinutes?: number }).progressEndMinutes;
  if (typeof actualEnd !== 'number' || !Number.isFinite(actualEnd)) return range;
  if (!range) return { start: actualEnd, end: actualEnd };

  // Active stops are dated to the current local day by the load route, while
  // their scheduled minute fields remain relative to the trip's original day.
  // Project an overnight interval onto that current day before comparing it to
  // the incoming plan (e.g. 23:50–00:50 becomes -10–50 at 00:10).
  if ((value.status === 'en_route' || value.status === 'visiting') && actualEnd < range.start) {
    const dayOffset = Math.ceil((range.start - actualEnd) / 1440);
    return {
      start: range.start - dayOffset * 1440,
      end: Math.max(range.end - dayOffset * 1440, actualEnd),
    };
  }
  return { ...range, end: Math.max(range.end, actualEnd) };
}

function stopPlaceId(stop: PlanStop): string {
  return stop.placeId || stop.place?.placeId || '';
}

function addDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

const MIDNIGHT_MINUTE_FIELDS = [
  'travelStartMinutes', 'plannedArrivalMinutes', 'startMinutes', 'plannedStartMinutes',
  'endMinutes', 'departureMinutes', 'plannedDepartureMinutes',
];

/**
 * T7 编辑路径：起始时间被推过午夜（≥1440 分钟）的「计划」站点标记为次日归属，
 * 分钟数归一化到 [0, 1440)，随后交给 migrateNextDayStops 迁入次日的计划对象。
 * 已执行 / 已跳过的站点是当天事实，保持原样（跨午夜延续由展示层按「次日 HH:mm」处理）。
 */
function markStopsPastMidnight(stops: unknown[], localDate: string, excludeStopIds?: Set<string>): { stops: unknown[]; crossed: number } {
  let crossed = 0;
  const marked = stops.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const stop = value as Record<string, unknown>;
    const status = typeof stop.status === 'string' ? stop.status : 'planned';
    if (status !== 'planned') return stop;
    if (excludeStopIds?.has(String(stop.stopId))) return stop;
    const start = Number(stop.startMinutes ?? stop.plannedStartMinutes ?? stop.plannedArrivalMinutes ?? NaN);
    if (!Number.isFinite(start) || start < 1440) return stop;
    const dayOffset = Math.floor(start / 1440);
    const date = addDays(localDate, dayOffset);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return stop;
    const copy: Record<string, unknown> = { ...stop, date };
    for (const field of MIDNIGHT_MINUTE_FIELDS) {
      const fieldValue = copy[field];
      if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
        copy[field] = Math.max(0, fieldValue - dayOffset * 1440);
      }
    }
    crossed += 1;
    return copy;
  });
  return { stops: marked, crossed };
}

function planLoadConfirmationToken(input: {
  scheme: SavedPlan;
  startDate: string;
  targetDates: readonly string[];
  datedPlans: readonly SavedPlan[];
  progressRevision?: number;
  progressStops: readonly PlanStop[];
}): string {
  const datedPlans = input.datedPlans
    .filter(plan => (plan.localDate && input.targetDates.includes(plan.localDate)) || plan.sourceSchemeId === input.scheme.id)
    .map(plan => ({
      id: plan.id,
      localDate: plan.localDate,
      sourceSchemeId: plan.sourceSchemeId || '',
      savedAt: plan.savedAt,
      name: plan.name,
      stops: plan.stops,
      routeLegs: plan.routeLegs,
      plannedCharges: plan.plannedCharges,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const content = JSON.stringify({
    scheme: { id: input.scheme.id, name: input.scheme.name, savedAt: input.scheme.savedAt, days: input.scheme.days },
    startDate: input.startDate,
    targetDates: [...input.targetDates].sort(),
    datedPlans,
    progressRevision: input.progressRevision ?? null,
    progressStops: input.progressStops,
  });
  return createHash('sha256').update(content).digest('hex');
}

function shiftPlanStops(stops: unknown[], minutes: number): unknown[] {
  if (minutes === 0) return stops;
  const fields = ['travelStartMinutes', 'plannedArrivalMinutes', 'startMinutes', 'plannedStartMinutes',
    'endMinutes', 'departureMinutes', 'plannedDepartureMinutes'];
  return stops.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const stop = { ...(value as Record<string, unknown>) };
    for (const field of fields) if (typeof stop[field] === 'number' && Number.isFinite(stop[field])) {
      stop[field] = (stop[field] as number) + minutes;
    }
    return stop;
  });
}

/**
 * 日计划是用户实际执行的队列。编辑一个时间后，后面的待进行地点应由
 * 服务端顺延，不能只依赖编辑页的本地修正。方案模板仍由
 * assertPlanContent 保持严格的重叠校验。
 */
function autoShiftDatedPlanStops(stops: unknown[]): unknown[] {
  const ordered = sortStopsByStartTime(stops.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return { ...(value as Record<string, unknown>) };
  }));
  let previousEnd: number | null = null;
  let previousStop: Record<string, unknown> | null = null;
  for (const value of ordered) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const stop = value as Record<string, unknown>;
    if (stop.status === 'skipped') continue;
    let range = planStopRange(stop);
    if (!range) continue;
    if (previousEnd !== null && range.start < previousEnd) {
      const status = typeof stop.status === 'string' ? stop.status : 'planned';
      if (status !== 'planned') {
        const currentName = (stop.place as Record<string, unknown> | undefined)?.name || stop.stopId || '该地点';
        const previousName = (previousStop?.place as Record<string, unknown> | undefined)?.name || previousStop?.stopId || '前一地点';
        throw new Error(`「${currentName}」与「${previousName}」存在已执行时间冲突，请先纠正进度，再保存。`);
      }
      const shift = previousEnd - range.start;
      for (const field of [
        'travelStartMinutes', 'plannedArrivalMinutes', 'startMinutes', 'plannedStartMinutes',
        'endMinutes', 'departureMinutes', 'plannedDepartureMinutes',
      ]) {
        if (typeof stop[field] === 'number' && Number.isFinite(stop[field])) {
          stop[field] = (stop[field] as number) + shift;
        }
      }
      range = planStopRange(stop);
    }
    if (range) {
      previousEnd = range.end;
      previousStop = stop;
    }
  }
  return ordered;
}

function scheduleStopsAfterProgress(
  stops: unknown[],
  initialDate: string,
  progressStops: readonly PlanStop[],
): { date: string; stops: unknown[]; conflicts: Array<{ date: string; names: string[]; timeOverlap: boolean }>; adjusted: boolean } {
  let date = initialDate;
  const conflicts: Array<{ date: string; names: string[]; timeOverlap: boolean }> = [];
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const facts = progressStops.filter(stop => stop.date === date && stop.status !== 'planned');
    const candidates = stops.filter(stop =>
      stop && typeof stop === 'object' && !Array.isArray(stop) && (stop as Record<string, unknown>).status !== 'skipped',
    ) as PlanStop[];
    const collidingFacts = facts.filter(fact => candidates.some(candidate => {
      const sameNode = candidate.stopId === fact.stopId || Boolean(stopPlaceId(candidate) && stopPlaceId(candidate) === stopPlaceId(fact));
      const candidateRange = planStopRange(candidate);
      const factRange = fact.status === 'skipped' ? null : progressStopRange(fact);
      return sameNode || Boolean(candidateRange && factRange &&
        candidateRange.start < factRange.end && factRange.start < candidateRange.end);
    }));
    if (collidingFacts.length) {
      const names = new Set<string>();
      for (const fact of collidingFacts) names.add(fact.place?.name || fact.stopId);
      for (const candidate of candidates) {
        if (collidingFacts.some(fact => candidate.stopId === fact.stopId ||
          Boolean(stopPlaceId(candidate) && stopPlaceId(candidate) === stopPlaceId(fact)) ||
          (() => {
            const candidateRange = planStopRange(candidate);
            const factRange = progressStopRange(fact);
            return Boolean(candidateRange && factRange &&
              candidateRange.start < factRange.end && factRange.start < candidateRange.end);
          })())) names.add(candidate.place?.name || candidate.stopId);
      }
      const timeOverlap = collidingFacts.some(fact => candidates.some(candidate => {
        const candidateRange = planStopRange(candidate);
        const factRange = progressStopRange(fact);
        return candidateRange && factRange &&
          candidateRange.start < factRange.end && factRange.start < candidateRange.end;
      }));
      conflicts.push({ date, names: [...names], timeOverlap });
    }

    const timedConflicts = collidingFacts.filter(fact => {
      const range = progressStopRange(fact);
      return range && candidates.some(candidate => {
        const candidateRange = planStopRange(candidate);
        return candidateRange && candidateRange.start < range.end && range.start < candidateRange.end;
      });
    });
    if (!timedConflicts.length) return { date, stops, conflicts, adjusted: date !== initialDate };

    const latestProgressEnd = Math.max(...facts.filter(fact => fact.status !== 'skipped').flatMap(fact => {
      const range = progressStopRange(fact);
      return range ? [range.end] : [];
    }));
    const starts = candidates.flatMap(candidate => {
      const range = planStopRange(candidate);
      return range ? [range.start] : [];
    });
    if (!Number.isFinite(latestProgressEnd) || !starts.length) return { date, stops, conflicts, adjusted: date !== initialDate };
    const firstStart = Math.min(...starts);
    const shifted = shiftPlanStops(stops, Math.max(0, latestProgressEnd - firstStart));
    const shiftedRanges = shifted.flatMap(value => {
      const range = planStopRange(value);
      return range ? [range] : [];
    });
    // A day plan may continue after midnight. Keep its original date and carry
    // the absolute minute values forward; the UI formats them as “次日 HH:mm”
    // and cross-day overlap checks still use absolute calendar minutes.
    if (shiftedRanges.length && shiftedRanges.every(range => range.start >= 0 && range.end > range.start)) {
      return { date, stops: shifted, conflicts, adjusted: true };
    }
    const carryDays = Math.max(1, Math.ceil((latestProgressEnd - firstStart) / 1440));
    date = addDays(date, carryDays);
  }
  throw new Error('进度冲突跨越了太多日期，暂时无法安全载入。请调整方案起始日期后重试。');
}

function sortSavedPlanStops(plan: SavedPlan) {
  if (Array.isArray(plan.stops)) plan.stops = sortStopsByStartTime(plan.stops);
  if (Array.isArray(plan.days)) {
    plan.days = plan.days.map(day => ({
      ...day,
      stops: Array.isArray(day.stops) ? sortStopsByStartTime(day.stops) : [],
    }));
  }
}

function assertPlanContent(
  stops: unknown[],
  routeLegs: unknown[],
  plannedCharges: unknown[],
  label = '方案',
  globalStopIds = new Set<string>(),
) {
  const stopIds = new Set<string>();
  const stopsById = new Map<string, Record<string, unknown>>();
  const references = new Set<string>();
  for (const [index, value] of stops.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}第 ${index + 1} 个地点无效。`);
    const stop = value as Record<string, unknown>;
    const stopId = typeof stop.stopId === 'string' ? stop.stopId : '';
    if (stop.preferredTransportMode !== undefined && !['walking', 'transit', 'driving'].includes(String(stop.preferredTransportMode))) throw new Error(`${label}交通方式无效。`);
    if (!stopId.trim() || stopId !== stopId.trim() || stopId.length > 200 || stopId === 'origin' || stopId === 'my-location') {
      throw new Error(`${label}地点 ID 无效。`);
    }
    if (stopIds.has(stopId) || globalStopIds.has(stopId)) throw new Error(`${label}存在重复的到访记录 ID：${stopId}。每次到访需要独立标识，同一地点可以多次安排。`);
    stopIds.add(stopId);
    globalStopIds.add(stopId);
    stopsById.set(stopId, stop);
    references.add(stopId);
    if (stop.placeId !== undefined) {
      if (typeof stop.placeId !== 'string' || !stop.placeId.trim()) throw new Error(`${label}地点引用无效。`);
      references.add(stop.placeId);
    }
    if (stop.place !== undefined) {
      if (!stop.place || typeof stop.place !== 'object' || Array.isArray(stop.place) ||
        typeof (stop.place as Record<string, unknown>).placeId !== 'string' || !(stop.place as Record<string, unknown>).placeId) {
        throw new Error(`${label}地点信息无效。`);
      }
      const place = stop.place as Record<string, unknown>;
      references.add(place.placeId as string);
      if (place.coordinates !== undefined && place.coordinates !== null) {
        const coordinates = place.coordinates as Record<string, unknown>;
        if (!coordinates || typeof coordinates !== 'object' || Array.isArray(coordinates) ||
          typeof coordinates.lat !== 'number' || !Number.isFinite(coordinates.lat) || coordinates.lat < -90 || coordinates.lat > 90 ||
          typeof coordinates.lng !== 'number' || !Number.isFinite(coordinates.lng) || coordinates.lng < -180 || coordinates.lng > 180) {
          throw new Error(`${label}地点坐标超出有效范围。`);
        }
      }
    }
  }

  const timedStops = stops
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    .map(value => normalizePlanStop(value as unknown as PlanStop))
    .filter(stop => stop.status !== 'skipped');
  const suppliedTimeFields = [
    'startMinutes', 'plannedStartMinutes', 'plannedArrivalMinutes', 'plannedDepartureMinutes', 'departureMinutes',
    'endMinutes', 'plannedDurationMinutes', 'minDurationMinutes', 'durationSeconds', 'minDurationSeconds',
  ];
  for (const stop of timedStops) {
    const original = stopsById.get(stop.stopId);
    if (!original || !suppliedTimeFields.some(field => original[field] !== undefined)) continue;
    if (!Number.isFinite(stop.startMinutes) || stop.startMinutes! < 0 ||
      !Number.isFinite(stop.endMinutes) || stop.endMinutes! < stop.startMinutes! ||
      (stop.endMinutes === stop.startMinutes && stop.status !== 'completed')) {
      throw new Error(`${label}地点「${stop.place?.name || stop.stopId}」的开始或结束时间无效，请调整时间安排。`);
    }
  }
  const overlappingStops = timedStops.filter(stop => Number.isFinite(stop.startMinutes) &&
    Number.isFinite(stop.endMinutes) && (stop.endMinutes as number) > (stop.startMinutes as number));
  for (let left = 0; left < overlappingStops.length; left += 1) {
    for (let right = left + 1; right < overlappingStops.length; right += 1) {
      const first = overlappingStops[left];
      const second = overlappingStops[right];
      if ((first.startMinutes as number) < (second.endMinutes as number) &&
        (second.startMinutes as number) < (first.endMinutes as number)) {
        const firstName = first.place?.name || first.stopId;
        const secondName = second.place?.name || second.stopId;
        throw new Error(`${label}地点「${firstName}」与「${secondName}」的游览时间重叠，请调整时间安排。`);
      }
    }
  }

  const legIds = new Set<string>();
  for (const [index, value] of routeLegs.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}第 ${index + 1} 条路线无效。`);
    const leg = value as Record<string, unknown>;
    const legId = typeof leg.legId === 'string' ? leg.legId : '';
    const fromStopId = typeof leg.fromStopId === 'string' ? leg.fromStopId : '';
    const toStopId = typeof leg.toStopId === 'string' ? leg.toStopId : '';
    if (!legId.trim() || legId !== legId.trim() || legId.length > 200 || legIds.has(legId)) throw new Error(`${label}路线 ID 无效或重复。`);
    if (!toStopId || !references.has(toStopId) || !fromStopId ||
      (!['origin', 'my-location'].includes(fromStopId) && !references.has(fromStopId))) {
      throw new Error(`${label}路线引用了不存在的地点。`);
    }
    legIds.add(legId);
  }

  for (const [index, value] of plannedCharges.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}第 ${index + 1} 项费用无效。`);
    const charge = value as Record<string, unknown>;
    if (charge.stopId !== undefined && (typeof charge.stopId !== 'string' || !references.has(charge.stopId))) {
      throw new Error(`${label}费用引用了不存在的地点。`);
    }
    if (charge.routeLegRef !== undefined && (typeof charge.routeLegRef !== 'string' || !legIds.has(charge.routeLegRef))) {
      throw new Error(`${label}费用引用了不存在的路线。`);
    }
  }
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组。`);
  return value;
}

/** Check actual time across neighboring scheme days when an earlier visit ends after midnight. */
function assertNoCrossDayOverlap(days: Array<{
  dayIndex: number;
  stops: unknown[];
  groupId?: string;
  label?: string;
}>) {
  const timeFields = [
    'startMinutes', 'plannedStartMinutes', 'plannedArrivalMinutes', 'plannedDepartureMinutes', 'departureMinutes',
    'endMinutes', 'plannedDurationMinutes', 'minDurationMinutes', 'durationSeconds', 'minDurationSeconds',
  ];
  const visits = days.flatMap(day => day.stops.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const source = value as Record<string, unknown>;
    if (source.status === 'skipped' || !timeFields.some(field => source[field] !== undefined)) return [];
    const stop = normalizePlanStop(source as unknown as PlanStop);
    if (!Number.isFinite(stop.startMinutes) || !Number.isFinite(stop.endMinutes)) return [];
    return [{
      dayIndex: day.dayIndex,
      start: day.dayIndex * 1440 + stop.startMinutes!,
      end: day.dayIndex * 1440 + stop.endMinutes!,
      groupId: day.groupId ?? `day:${day.dayIndex}`,
      label: day.label ?? `第 ${day.dayIndex + 1} 天`,
      name: stop.place?.name || stop.stopId,
    }];
  })).sort((left, right) => left.start - right.start);

  for (let left = 0; left < visits.length; left += 1) {
    for (let right = left + 1; right < visits.length; right += 1) {
      const first = visits[left];
      const second = visits[right];
      if (second.start >= first.end) break;
      if (first.groupId !== second.groupId && first.start < second.end && second.start < first.end) {
        throw new Error(`${first.label}「${first.name}」与${second.label}「${second.name}」的游览时间重叠，请调整时间安排。`);
      }
    }
  }
}

const requiredText = (value: unknown, label: string, max: number) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new Error(`${label}需填写 1–${max} 个字。`);
  return text;
};

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function expiredPlanName(original: string, date: string) {
  const suffix = ` · 未完成 · ${date}`;
  const base = original.trim() || '未完成计划';
  return `${base.slice(0, Math.max(1, 40 - suffix.length)).trimEnd()}${suffix}`;
}

/** A scheme expansion has no execution facts of its own, so its planned statuses cannot prove it was unfinished. */
function expiredPlanCopyName(original: string, date: string) {
  const suffix = ` · 日计划 · ${date}`;
  const base = original.trim() || '日计划';
  return `${base.slice(0, Math.max(1, 40 - suffix.length)).trimEnd()}${suffix}`;
}

const isValidTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
};

const dateKeyInTimeZone = (date: Date, timeZone = DEFAULT_TIMEZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const isValidDateKey = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
};

function sourceDayIndexOf(plan: SavedPlan, scheme: SavedPlan) {
  if (Number.isInteger(plan.sourceDayIndex) && (plan.sourceDayIndex as number) >= 0) return plan.sourceDayIndex as number;
  // 兼容旧版本展开的计划：旧数据没有 sourceDayIndex，但名称保留“第 N 天”。
  const namedDay = /第\s*(\d+)\s*天/.exec(plan.name);
  if (namedDay) return Math.max(0, Number(namedDay[1]) - 1);
  // 最后回退旧方案日期与每日计划日期的差值。
  if (scheme.localDate && plan.localDate && isValidDateKey(scheme.localDate) && isValidDateKey(plan.localDate)) {
    const diff = (Date.parse(`${plan.localDate}T00:00:00.000Z`) - Date.parse(`${scheme.localDate}T00:00:00.000Z`)) / 86400000;
    if (Number.isInteger(diff) && diff >= 0) return diff;
  }
  throw new Error(`无法确认「${plan.name}」对应方案的第几天，请先检查这份每日计划。`);
}

export class DatedPlanConflictError extends Error {
  constructor(date: string, existingName: string) {
    super(`${date} 已有日计划「${existingName}」，请编辑现有计划或先处理这份计划，再保存到同一天。`);
    this.name = 'DatedPlanConflictError';
  }
}

export class SavedPlanRevisionConflictError extends Error {
  constructor(message = '这份计划刚刚有变化，请重新核对后重试。') {
    super(message);
    this.name = 'SavedPlanRevisionConflictError';
  }
}

export class PlanExecutionConflictError extends Error {
  /** 领域错误码（ACTIVE_STOP_CONFLICT / INVALID_EXECUTION_TRANSITION 等），路由按 ERROR_STATUS 映射状态。 */
  readonly code: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'PlanExecutionConflictError';
    this.code = code || 'PLAN_TIME_OR_PROGRESS_CONFLICT';
  }
}

export function companionPlanSignature(plan: SavedPlan) {
  return createHash('sha256').update(JSON.stringify({ localDate: plan.localDate, timezone: plan.timezone,
    stops: plan.stops, routeLegs: plan.routeLegs, plannedCharges: plan.plannedCharges, events: plan.executionEvents || [] })).digest('hex');
}

export class PlanLibraryService {
  private plans: SavedPlan[] = [];
  private historyPlans: SavedPlan[] = [];
  constructor(
    private readonly now = () => new Date().toISOString(),
    private readonly journeyMemoryWriter?: JourneyMemoryWriter,
    private readonly historyChanged?: (actorId: string, planId: string) => void,
  ) {}

  private maybeCreateJourneyMemory(actorId: string, plan: SavedPlan, generatedBy: 'manual' | 'expiry') {
    if (!this.journeyMemoryWriter || plan.kind !== 'plan' || !plan.localDate) return;
    const view = plan.historyArchivedAt ? this.historyView(plan) : this.planView(plan);
    const completedStops = (view.stops as PlanStop[] || [])
      .filter(stop => stop.status === 'completed')
      .sort((left, right) => (getStopStart(left) ?? Number.MAX_SAFE_INTEGER) - (getStopStart(right) ?? Number.MAX_SAFE_INTEGER));
    if (!completedStops.length) return;
    const executableStops = (view.stops as PlanStop[] || []).filter(stop => stop.status !== 'skipped');
    if (generatedBy === 'manual' && (!executableStops.length || executableStops.some(stop => stop.status !== 'completed'))) return;

    const events = Array.isArray(view.executionEvents) ? view.executionEvents : [];
    const corrected = new Set(events.flatMap(event => event.correctsEventId ? [event.correctsEventId] : []));
    const effective = events
      .filter(event => !corrected.has(event.executionEventId))
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
    const places: JourneyMemoryPlace[] = completedStops.map((stop, index) => {
      const stopEvents = effective.filter(event => event.stopId === stop.stopId);
      const arrivedAt = stopEvents.find(event => event.type === 'arrive')?.occurredAt || null;
      const completedAt = stopEvents.find(event => event.type === 'complete')?.occurredAt || null;
      const elapsed = arrivedAt && completedAt ? Math.round((Date.parse(completedAt) - Date.parse(arrivedAt)) / 60000) : null;
      const next = completedStops[index + 1];
      const leg = next ? (view.routeLegs as RouteLeg[] || []).find(item => item.fromStopId === stop.stopId && item.toStopId === next.stopId) : undefined;
      return {
        stopId: stop.stopId,
        ...(stop.place?.placeId ? { placeId: stop.place.placeId } : {}),
        name: stop.place?.name || stop.stopId,
        arrivedAt,
        completedAt,
        visitMinutes: elapsed !== null && elapsed >= 0 ? elapsed : null,
        ...(leg?.transportMode ? { transferMode: leg.transportMode } : {}),
        ...(Number.isFinite(leg?.durationMinutes) ? { transferMinutes: leg!.durationMinutes } : {}),
      };
    });
    const timestamps = effective.map(event => Date.parse(event.occurredAt)).filter(Number.isFinite);
    const completionTimes = effective.filter(event => event.type === 'complete').map(event => Date.parse(event.occurredAt)).filter(Number.isFinite);
    const firstEventAt = timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null;
    const completedAt = completionTimes.length ? new Date(Math.max(...completionTimes)).toISOString() : null;
    const elapsedMinutes = firstEventAt && completedAt
      ? Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(firstEventAt)) / 60000))
      : null;
    this.journeyMemoryWriter(actorId, view, generatedBy, { places, firstEventAt, completedAt, elapsedMinutes });
  }

  private progressBaseStops(plan: SavedPlan): PlanStop[] {
    return (Array.isArray(plan.stops) ? plan.stops : [])
      .filter((value): value is PlanStop => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
      .map(value => ({ ...value }));
  }

  private planView(plan: SavedPlan): SavedPlan {
    const copy = structuredClone(plan);
    delete copy.companionReceipts;
    delete copy.departureCarry;
    if (copy.kind !== 'plan') return copy;
    // Persisted plans created before execution events were introduced may omit
    // `stops`, or may carry the current status without an event history.  Treat
    // those records as valid legacy snapshots instead of throwing during the
    // startup expiry sweep, and retain their explicit status for archiving.
    const originalStops = Array.isArray(copy.stops) ? copy.stops : [];
    copy.stops = originalStops;
    const excluded = (originalStops as PlanStop[]).filter(stop => stop.status === 'skipped');
    const hasExecutionHistory = Array.isArray(copy.executionEvents) && copy.executionEvents.length > 0;
    const baseStops = this.progressBaseStops(copy).filter(stop => stop.status !== 'skipped')
      .map(stop => hasExecutionHistory ? ({ ...stop, status: 'planned' as const }) : ({ ...stop }));
    const replay = hasExecutionHistory
      ? replayExecutionEvents(baseStops, copy.executionEvents || [])
      : { stops: baseStops, effectiveEvents: [], errors: [] };
    copy.stops = projectExecutionSchedule(this.executionSnapshot(copy, [...replay.stops, ...excluded]), this.now());
    copy.needsReview = Boolean(copy.needsReview || (copy.stops as PlanStop[]).some(stop => stop.forecastConflict));
    copy.revision = Number.isInteger(copy.revision) ? copy.revision : 0;
    copy.executionEvents = structuredClone(copy.executionEvents || []);
    return copy;
  }

  /** Keep a dated plan available while a cross-midnight stop is still active. */
  private isOvernightActive(plan: SavedPlan, now = new Date(this.now())) {
    if (plan.kind !== 'plan' || !plan.localDate || !isValidDateKey(plan.localDate)) return false;
    const timezone = plan.timezone || DEFAULT_TIMEZONE;
    const today = dateKeyInTimeZone(now, timezone);
    if (today <= plan.localDate) return false;
    const dayOffset = Math.round(
      (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${plan.localDate}T00:00:00.000Z`)) / 86400000,
    );
    if (!Number.isFinite(dayOffset) || dayOffset <= 0) return false;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE,
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find(item => item.type === 'hour')?.value);
    const minute = Number(parts.find(item => item.type === 'minute')?.value);
    const absoluteNow = dayOffset * 1440 + hour * 60 + minute;
    if (!Number.isFinite(absoluteNow)) return false;
    return (this.planView(plan).stops as PlanStop[]).some(stop => {
      if (stop.status === 'completed' || stop.status === 'skipped') return false;
      // 预计窗口结束不是实际访问结束；未结束的访问一直保留，超时仅提示待核对。
      if (stop.status === 'en_route' || stop.status === 'visiting') return true;
      const range = planStopRange(stop);
      return Boolean(range && range.start <= absoluteNow && absoluteNow <= range.end);
    });
  }

  private executionSnapshot(plan: SavedPlan, stops: PlanStop[]): TripSnapshot {
    const timezone = plan.timezone || DEFAULT_TIMEZONE;
    return {
      schemaVersion: 1,
      tripId: plan.id,
      lifecycle: 'active',
      planningStatus: 'validated',
      timezone,
      travelDate: plan.localDate,
      localDate: plan.localDate,
      tripSettings: { localDate: plan.localDate, timezone, cityCode: plan.cityCode },
      stops,
      routeLegs: plan.routeLegs as RouteLeg[],
      plannedCharges: [],
      executionEvents: plan.executionEvents || [],
      version: plan.revision || 0,
    };
  }

  private assertTodayPlan(plan: SavedPlan) {
    if (plan.kind !== 'plan' || !plan.localDate) throw new Error('进度只能记录在带日期的日计划中。');
    const today = dateKeyInTimeZone(new Date(this.now()), plan.timezone || DEFAULT_TIMEZONE);
    if (plan.localDate !== today && !this.isOvernightActive(plan)) throw new Error('只能记录今天计划的进度。');
  }

  private assertExecutionDate(plan: SavedPlan, occurredAt: string, stopId?: string) {
    // The domain validator still owns the full timestamp format check. This
    // guard adds the daily-plan boundary while allowing an active stop to
    // continue into the following local day.
    const instant = new Date(occurredAt);
    if (!Number.isFinite(instant.getTime()) || !plan.localDate) return;
    const occurredDate = dateKeyInTimeZone(instant, plan.timezone || DEFAULT_TIMEZONE);
    if (occurredDate === plan.localDate) return;
    const stop = stopId ? (this.planView(plan).stops as PlanStop[]).find(item => item.stopId === stopId) : undefined;
    const dayOffset = Math.round(
      (Date.parse(`${occurredDate}T00:00:00.000Z`) - Date.parse(`${plan.localDate}T00:00:00.000Z`)) / 86400000,
    );
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: isValidTimeZone(plan.timezone || DEFAULT_TIMEZONE) ? plan.timezone || DEFAULT_TIMEZONE : DEFAULT_TIMEZONE,
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant);
    const hour = Number(parts.find(item => item.type === 'hour')?.value);
    const minute = Number(parts.find(item => item.type === 'minute')?.value);
    const absoluteMinute = dayOffset * 1440 + hour * 60 + minute;
    const range = stop ? planStopRange(stop) : null;
    if (stop && (stop.status === 'en_route' || stop.status === 'visiting')) {
      const start = stop.status === 'en_route' ? stop.travelStartMinutes : stop.actualArrivalMinutes ?? stop.startMinutes;
      if (Number.isFinite(start) && Number.isFinite(absoluteMinute) && absoluteMinute >= start!) return;
    }
    if (range && Number.isFinite(absoluteMinute) && range.start <= absoluteMinute && absoluteMinute <= range.end) return;
    throw new Error(`进度时间必须属于 ${plan.localDate}，或处于该节点跨日延续的时间范围内。`);
  }

  private assertPlanRevision(plan: SavedPlan, expectedRevision?: number) {
    if (expectedRevision !== undefined && expectedRevision !== (plan.revision || 0)) {
      throw new SavedPlanRevisionConflictError();
    }
  }

  /** Checked synchronously before either source or destination can be mutated. */
  private assertCarryTargets(actorId: string, input: Record<string, unknown>) {
    if (input.expectedCarryTargets === undefined) return;
    if (!Array.isArray(input.expectedCarryTargets) || !input.expectedCarryTargets.length) throw new Error('接续日期确认资料无效，请重新预览。');
    const dates = new Set<string>();
    for (const value of input.expectedCarryTargets) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('接续日期确认资料无效，请重新预览。');
      const expected = value as Record<string, unknown>;
      const date = expected.localDate;
      if (typeof date !== 'string' || !isValidDateKey(date) || dates.has(date) ||
        !(expected.planId === null || typeof expected.planId === 'string' && expected.planId.length>0) ||
        !(expected.planId === null ? expected.expectedRevision === null : typeof expected.expectedRevision === 'number' && Number.isSafeInteger(expected.expectedRevision) && expected.expectedRevision>=0)) {
        throw new Error('接续日期确认资料无效，请重新预览。');
      }
      dates.add(date);
      const targets = this.plans.filter(plan=>plan.ownerId===actorId&&plan.kind==='plan'&&plan.localDate===date);
      if (targets.length>1 || (targets[0]?.id??null)!==expected.planId || (targets[0]?(targets[0].revision||0):null)!==expected.expectedRevision) {
        throw new SavedPlanRevisionConflictError('接续日期的计划已有变化，请重新预览后再添加；本次地点尚未保存。');
      }
    }
  }

  private assertNoOtherActivePlan(actorId: string, planId: string) {
    for (const candidate of this.plans) {
      if (candidate.ownerId !== actorId || candidate.kind !== 'plan' || candidate.id === planId) continue;
      const running = (this.planView(candidate).stops as PlanStop[]).find(stop => ['en_route', 'visiting'].includes(stop.status || ''));
      if (running) throw new PlanExecutionConflictError(`「${running.place?.name || running.stopId}」仍在进行中（${candidate.localDate}），请先完成或中止该地点。`, 'ACTIVE_STOP_CONFLICT');
    }
  }

  private assertUniqueDatedPlanDate(actorId: string, date: string | undefined, exceptPlanId?: string) {
    if (!date) return;
    const existing = this.plans.find(plan => plan.ownerId === actorId && plan.kind === 'plan' &&
      plan.localDate === date && plan.id !== exceptPlanId);
    if (existing) throw new DatedPlanConflictError(date, existing.name);
  }

  private uniqueArchiveName(ownerId: string, preferred: string) {
    const base = preferred.trim().slice(0, 40) || '未完成计划';
    let name = base;
    let suffix = 2;
    while (this.plans.some(plan => plan.ownerId === ownerId && plan.name === name)) {
      const number = `（${suffix++}）`;
      const datedName = /^(.*) · (\d{4}-\d{2}-\d{2})$/.exec(base);
      if (datedName) {
        const datePart = ` · ${datedName[2]}`;
        const prefix = `${datedName[1]}${number}`;
        name = `${prefix.slice(0, 40 - datePart.length).trimEnd()}${datePart}`;
      } else {
        name = `${base.slice(0, 40 - number.length).trimEnd()}${number}`;
      }
    }
    return name;
  }

  private saveExpiredDay(input: ExpiredTripPlanDay, archiveKey: string, preferredName: string) {
    if (this.plans.some(plan => plan.ownerId === input.ownerId && plan.archiveKey === archiveKey)) return false;
    const stops = sortStopsByStartTime(unexecutedStops(input.stops));
    const cityCode = resolvePlanCityCode(stops, input.cityCode);
    const routeLegs = routesForStops(input.routeLegs, stops);
    const plannedCharges = chargesForDay(input.plannedCharges || [], stops, routeLegs, input.date);
    if (!stops.length && !plannedCharges.length) return false;
    const days = normalizeSchemeDays([{ dayIndex: 0, stops, routeLegs, plannedCharges }]);
    const duplicate = this.plans.some(plan => {
      if (plan.ownerId !== input.ownerId || plan.kind !== 'scheme' || plan.days?.length !== days.length ||
        plan.cityCode !== cityCode) return false;
      const legacyArchiveDate = plan.archiveKey ? /(\d{4}-\d{2}-\d{2})$/.exec(plan.name)?.[1] : undefined;
      if (plan.archiveDate !== input.date && legacyArchiveDate !== input.date) return false;
      return days.every((day, index) => samePlanContent(plan.days![index], day.stops, day.routeLegs, day.plannedCharges));
    });
    if (duplicate) return false;
    this.plans.push({
      id: `plan_${randomUUID()}`,
      ownerId: input.ownerId,
      ...(input.tripId ? { tripId: input.tripId } : {}),
      kind: 'scheme',
      name: this.uniqueArchiveName(input.ownerId, preferredName),
      cityCode,
      timezone: input.timezone || DEFAULT_TIMEZONE,
      savedAt: this.now(),
      source: 'current',
      archiveKey,
      archiveDate: input.date,
      days,
      stops: [],
      routeLegs: [],
      plannedCharges: [],
    });
    return true;
  }

  /** TripService 在移除过期节点前调用；仅保存还未执行的站点。 */
  archiveExpiredTripDay(input: ExpiredTripPlanDay) {
    const seenStandalone = new Set<string>();
    const keyPrefix = `trip:${input.tripId}:`;
    for (const plan of this.plans) {
      if (plan.ownerId !== input.ownerId || plan.tripId !== input.tripId || !plan.archiveKey?.startsWith(keyPrefix)) continue;
      for (const day of plan.days || []) {
        for (const charge of day.plannedCharges || []) {
          const key = standaloneChargeKey(charge);
          if (key) seenStandalone.add(key);
        }
      }
    }
    const plannedCharges = (input.plannedCharges || []).filter(charge => {
      const key = standaloneChargeKey(charge);
      if (!key) return true;
      if (seenStandalone.has(key)) return false;
      seenStandalone.add(key);
      return true;
    });
    return this.saveExpiredDay({ ...input, plannedCharges }, keyPrefix + input.date, `未完成计划 · ${input.date}`);
  }

  private assertStartDate(date: string, timezone = DEFAULT_TIMEZONE) {
    if (!isValidDateKey(date)) throw new Error('请选择有效的起始日期。');
    const today = dateKeyInTimeZone(new Date(this.now()), timezone);
    if (date < today) throw new Error('方案起始日期不能早于今天。');
  }

  /**
   * T8：编辑当天日计划时，被改动或新增的「计划」站点起始不能早于当前时刻。
   * 未改动的过期站点不拦截（它们只是待处理，用户仍可编辑其它站点）；
   * 已有执行事实的站点由签名校验保护，不在此处管辖。
   */
  private assertEditedStopsNotInPast(submitted: unknown[], current: PlanStop[], localDate: string | undefined, timezone?: string) {
    if (!localDate) return;
    const tz = timezone || DEFAULT_TIMEZONE;
    const now = new Date(this.now());
    if (localDate !== dateKeyInTimeZone(now, tz)) return;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const nowMinutes = Number(parts.find(part => part.type === 'hour')!.value) * 60 + Number(parts.find(part => part.type === 'minute')!.value);
    const currentById = new Map(current.map(stop => [stop.stopId, stop]));
    for (const value of submitted) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const stop = value as PlanStop;
      if (stop.status && stop.status !== 'planned') continue;
      const start = getStopStart(stop);
      if (!Number.isFinite(start) || start >= nowMinutes) continue;
      const before = stop.stopId ? currentById.get(stop.stopId) : undefined;
      if (before && (!before.status || before.status === 'planned') && getStopStart(before) === start) continue;
      throw new Error('新的安排不能早于当前时间，请把尚未开始的地点调整到之后的时间。');
    }
  }
  serialize() {
    this.plans.forEach(sortSavedPlanStops);
    return JSON.stringify([...this.plans, ...this.historyPlans]);
  }

  /** 同步更新及保存回执：重复确认先返回原回执，失败不留下半份修改。 */
  applyCompanion(actorId: string, planId: string, input: {
    actionKey: string; previewId: string; requestDigest: string; expectedRevision: number; signature: string;
    stops: unknown[]; routeLegs: unknown[]; plannedCharges: unknown[];
  }) {
    const plan = this.get(actorId, planId);
    const receipt = plan.companionReceipts?.find(item => item.actionKey === input.actionKey);
    if (receipt) {
      if (receipt.previewId !== input.previewId || receipt.requestDigest !== input.requestDigest) throw new Error('这个确认标识已用于另一份建议或参数，请重新预览。');
      return structuredClone(receipt);
    }
    this.assertPlanRevision(plan, input.expectedRevision);
    if (companionPlanSignature(plan) !== input.signature) throw new Error('执行记录或计划内容已变化，请重新预览。');
    const updated = this.update(actorId, planId, { name: plan.name, localDate: plan.localDate, timezone: plan.timezone, cityCode: plan.cityCode,
      snapshot: { stops: input.stops, routeLegs: input.routeLegs, plannedCharges: input.plannedCharges } });
    const result = { actionKey: input.actionKey, previewId: input.previewId, requestDigest: input.requestDigest, appliedRevision: updated.revision || 0, appliedAt: this.now() };
    plan.companionReceipts = [...(plan.companionReceipts || []), result].slice(-64);
    return structuredClone(result);
  }
  loadSerialized(value: string) {
    const data = JSON.parse(value);
    const entries: SavedPlan[] = Array.isArray(data) ? data : [];
    this.historyPlans = entries.filter(plan => plan.kind === 'plan' && Boolean(plan.historyArchivedAt));
    this.plans = entries.filter(plan => !this.historyPlans.includes(plan));
    for (const plan of this.plans) {
      if (plan.kind === 'scheme' && Array.isArray(plan.days)) plan.days = normalizeSchemeDays(plan.days);
      const stops = plan.kind === 'scheme' ? planStopsFromDays(plan.days) : Array.isArray(plan.stops) ? plan.stops : [];
      const placeCities = planStopsCityCodes(stops);
      if (placeCities.length) plan.cityCode = placeCities[0];
    }
    this.plans.forEach(sortSavedPlanStops);
  }

  /** 未完成安排另存为可复用方案；原日期计划及事实转入长期历史，不再作为今日安排。 */
  purgePastDatedPlans(actorId?: string) {
    const now = new Date(this.now());
    const expired = (plan: SavedPlan) => plan.kind === 'plan' && Boolean(plan.localDate) &&
      isValidDateKey(plan.localDate!) &&
      plan.localDate! < dateKeyInTimeZone(now, plan.timezone || DEFAULT_TIMEZONE) &&
      !this.isOvernightActive(plan, now);
    const pastPlans = this.plans
      .filter(plan => (!actorId || plan.ownerId === actorId) && expired(plan))
      .sort((a, b) => (a.localDate || '').localeCompare(b.localDate || ''));
    const archivedStandaloneCharges = new Map<string, Set<string>>();
    for (const plan of pastPlans) {
      this.maybeCreateJourneyMemory(plan.ownerId, plan, 'expiry');
      // A source scheme may have been edited independently of a trip. Preserve
      // that dated copy too; only trip-linked plans are archived from the trip snapshot.
      if (plan.tripId || !plan.localDate) continue;
      if (plan.sourceSchemeId) {
        const source = this.plans.find(item => item.id === plan.sourceSchemeId && item.ownerId === plan.ownerId && item.kind === 'scheme');
        let sourceStopIds = new Set<string>();
        if (source) {
          let sourceDayIndex: number | undefined;
          try { sourceDayIndex = sourceDayIndexOf(plan, source); } catch { /* legacy link may lack enough metadata */ }
          const sourceDay = sourceDayIndex === undefined ? undefined : source.days?.find(day => day.dayIndex === sourceDayIndex);
          if (sourceDay) {
            sourceStopIds = new Set([...sourceDay.stops, ...(plan.stops || [])].flatMap(value => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
              const stopId = (value as Record<string, unknown>).stopId;
              return typeof stopId === 'string' ? [stopId] : [];
            }));
            const sourceStops = unexecutedStops(sourceDay.stops);
            const sourceRoutes = routesForStops(sourceDay.routeLegs, sourceStops);
            const sourceCharges = chargesForDay(sourceDay.plannedCharges || [], sourceStops, sourceRoutes, plan.localDate);
            const planStops = unexecutedStops(plan.stops || []);
            const planRoutes = routesForStops(plan.routeLegs || [], planStops);
            const planCharges = chargesForDay(plan.plannedCharges || [], planStops, planRoutes, plan.localDate);
            const sourceContent = { ...sourceDay, stops: sourceStops, routeLegs: sourceRoutes, plannedCharges: sourceCharges };
            if (samePlanContent(sourceContent, planStops, planRoutes, planCharges)) continue;
          }
        }
        if (!sourceStopIds.size) {
          sourceStopIds = new Set((plan.stops || []).flatMap(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            const stopId = (value as Record<string, unknown>).stopId;
            return typeof stopId === 'string' ? [stopId] : [];
          }));
        }
        // The trip snapshot is the only source that knows which stations were
        // actually left unfinished. If it already archived part of this
        // expanded day, don't also archive the stale full library copy.
        const coveredByTripArchive = this.plans.some(candidate => {
          if (candidate.ownerId !== plan.ownerId || candidate.kind !== 'scheme' ||
            candidate.cityCode !== plan.cityCode || candidate.archiveDate !== plan.localDate ||
            !candidate.archiveKey?.startsWith('trip:')) return false;
          const archiveDay = candidate.days?.length === 1 ? candidate.days[0] : undefined;
          return Boolean(archiveDay?.stops.some(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const stopId = (value as Record<string, unknown>).stopId;
            return typeof stopId === 'string' && sourceStopIds.has(stopId);
          }));
        });
        if (coveredByTripArchive) continue;
      }
      const timezone = plan.timezone || DEFAULT_TIMEZONE;
      const sourceKey = plan.sourceSchemeId ? `${plan.ownerId}:${plan.sourceSchemeId}` : '';
      const seenStandalone = sourceKey
        ? archivedStandaloneCharges.get(sourceKey) ?? new Set<string>()
        : null;
      const charges = (plan.plannedCharges || []).filter(charge => {
        const key = standaloneChargeKey(charge);
        if (!key || !seenStandalone) return true;
        if (seenStandalone.has(key)) return false;
        seenStandalone.add(key);
        return true;
      });
      if (sourceKey && seenStandalone) archivedStandaloneCharges.set(sourceKey, seenStandalone);
      this.saveExpiredDay({
        ownerId: plan.ownerId,
        tripId: '',
        cityCode: plan.cityCode,
        timezone,
        date: plan.localDate,
        stops: plan.kind === 'plan'
          ? this.planView(plan).stops
          : plan.stops || [],
        routeLegs: plan.routeLegs || [],
        plannedCharges: charges,
      }, `plan:${plan.id}`, plan.sourceSchemeId
        ? expiredPlanCopyName(plan.name, plan.localDate)
        : expiredPlanName(plan.name, plan.localDate));
    }
    let removed = 0;
    this.plans = this.plans.filter(plan => {
      const remove = (!actorId || plan.ownerId === actorId) && expired(plan);
      if (remove) {
        if (!this.historyPlans.some(item => item.id === plan.id && item.ownerId === plan.ownerId)) {
          this.historyPlans.push({ ...structuredClone(plan), historyArchivedAt: this.now() });
        }
        removed += 1;
      }
      return !remove;
    });
    return removed;
  }

  private historyView(plan: SavedPlan): SavedPlan {
    const copy = structuredClone(plan);
    delete copy.companionReceipts;
    // 历史只投射各地点的实际事实，不把补记的延误传播到其它地点或今天的计划。
    copy.stops = this.progressBaseStops(plan).map(stop => {
      const events = (plan.executionEvents || []).filter(event => event.stopId === stop.stopId);
      if (!events.length) return stop;
      const replay = replayExecutionEvents([{ ...stop, status: 'planned' }], events);
      const snapshot = this.executionSnapshot({ ...plan, executionEvents: events, routeLegs: [] }, replay.stops);
      return projectExecutionSchedule(snapshot, this.now())[0] || stop;
    });
    copy.executionEvents = structuredClone(plan.executionEvents || []);
    copy.revision = plan.revision || 0;
    const age = (Date.parse(`${dateKeyInTimeZone(new Date(this.now()), plan.timezone || DEFAULT_TIMEZONE)}T00:00:00Z`) -
      Date.parse(`${plan.localDate}T00:00:00Z`)) / 86400000;
    copy.canEditHistory = Number.isFinite(age) && age > 0 && age <= 30;
    copy.historyEditUntilDate = new Date(Date.parse(`${plan.localDate}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
    return copy;
  }

  /** 一次真实到访由 planId + stopId 标识，同地点的不同站次分别计数。 */
  completedVisits(actorId: string) {
    this.purgePastDatedPlans(actorId);
    const seen = new Set<string>();
    return [...this.historyPlans, ...this.plans].filter(plan => plan.ownerId === actorId && plan.kind === 'plan')
      .flatMap(plan => {
        const view = plan.historyArchivedAt ? this.historyView(plan) : this.planView(plan);
        const replaced = new Set((view.executionEvents || []).map(event => event.correctsEventId).filter(Boolean));
        const effective = (view.executionEvents || []).filter(event => !replaced.has(event.executionEventId));
        return (view.stops as PlanStop[]).flatMap(stop => {
          const placeId = stop.place?.placeId || stop.placeId;
          const key = JSON.stringify([plan.id, stop.stopId]);
          if (stop.status !== 'completed' || !placeId || seen.has(key)) return [];
          const event = effective.filter(event => event.stopId === stop.stopId && (event.type === 'complete' || event.statusOverride === 'completed'))
            .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
          if (event && (!Number.isFinite(Date.parse(event.occurredAt)) || Date.parse(event.occurredAt) > Date.parse(this.now()))) return [];
          seen.add(key);
          return [{ placeId, name: stop.place?.name || placeId, cityCode: plan.cityCode, planId: plan.id, stopId: stop.stopId,
            planName: plan.name, localDate: plan.localDate || '', timezone: plan.timezone || DEFAULT_TIMEZONE,
            completedAt: event?.occurredAt || null, archived: Boolean(plan.historyArchivedAt) }];
        });
      }).sort((a, b) => (Date.parse(b.completedAt || b.localDate) || 0) - (Date.parse(a.completedAt || a.localDate) || 0) || b.planId.localeCompare(a.planId) || b.stopId.localeCompare(a.stopId));
  }

  history(actorId: string) {
    this.purgePastDatedPlans(actorId);
    return this.historyPlans.filter(plan => plan.ownerId === actorId)
      .sort((a, b) => (b.localDate || '').localeCompare(a.localDate || '') || b.savedAt.localeCompare(a.savedAt))
      .map(plan => {
        const view = this.historyView(plan), stops = view.stops as PlanStop[];
        return { id: plan.id, name: plan.name, localDate: plan.localDate, timezone: plan.timezone || DEFAULT_TIMEZONE, cityCode: plan.cityCode,
          historyArchivedAt: plan.historyArchivedAt, revision: view.revision, canEditHistory: view.canEditHistory, historyEditUntilDate: view.historyEditUntilDate,
          stopCount: stops.length, completedCount: stops.filter(stop => stop.status === 'completed').length,
          skippedCount: stops.filter(stop => stop.status === 'skipped').length, eventCount: view.executionEvents!.length,
          placeNames: stops.map(stop => stop.place?.name || '地点') };
      });
  }

  private storedHistory(actorId: string, planId: string) {
    this.purgePastDatedPlans(actorId);
    const plan = this.historyPlans.find(item => item.ownerId === actorId && item.id === planId);
    if (!plan) throw new Error('这份往日记录不存在，或不属于当前身份。');
    return plan;
  }

  historyDetail(actorId: string, planId: string) { return this.historyView(this.storedHistory(actorId, planId)); }

  removeHistory(actorId: string, planId: string, expectedRevision: number) {
    const plan = this.storedHistory(actorId, planId);
    this.assertPlanRevision(plan, expectedRevision);
    this.historyPlans = this.historyPlans.filter(item => item !== plan);
    return { deleted: true };
  }

  private assertHistoryEditable(plan: SavedPlan, expectedRevision: number) {
    this.assertPlanRevision(plan, expectedRevision);
    if (!this.historyView(plan).canEditHistory) throw new Error('已超过 30 天补记与纠正期限，往日记录仍可完整查看。');
  }

  private assertHistoryTime(plan: SavedPlan, occurredAt: string, stopId: string) {
    if (!Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt) > Date.parse(this.now())) throw new Error('请填写有效且不在未来的实际时间。');
    this.assertExecutionDate(plan, occurredAt, stopId);
  }

  private commitHistory(plan: SavedPlan, target: PlanStop, events: ExecutionEvent[]) {
    const baseline = this.progressBaseStops(plan).map(stop => ({ ...stop, status: 'planned' as const }));
    const oldErrors = new Set(replayExecutionEvents(baseline, plan.executionEvents || []).errors.map(error => JSON.stringify(error)));
    if (replayExecutionEvents(baseline, events).errors.some(error => !oldErrors.has(JSON.stringify(error)))) {
      throw new PlanExecutionConflictError('补记或纠正与其它实际记录冲突，请先核对发生时间。');
    }
    plan.stops = this.progressBaseStops(plan).map(stop => stop.stopId === target.stopId ? target : stop);
    plan.executionEvents = events;
    plan.revision = (plan.revision || 0) + 1;
    this.historyChanged?.(plan.ownerId, plan.id);
    this.maybeCreateJourneyMemory(plan.ownerId, plan, 'expiry');
    return this.historyView(plan);
  }

  backfillHistory(actorId: string, planId: string, input: { stopId: string; type: 'complete' | 'skip'; occurredAt: string; arrivedAt?: string; expectedRevision: number }) {
    const plan = this.storedHistory(actorId, planId);
    this.assertHistoryEditable(plan, input.expectedRevision);
    const target = (this.historyView(plan).stops as PlanStop[]).find(stop => stop.stopId === input.stopId);
    if (!target || (target.status || 'planned') !== 'planned') throw new Error('该地点已有实际记录，请使用纠正入口。');
    if (!['complete', 'skip'].includes(input.type) || (input.arrivedAt && input.type !== 'complete')) throw new Error('往日补记只记录完成或跳过，不启动实时行程。');
    const originalEvents = plan.executionEvents || [], targetEvents = originalEvents.filter(event => event.stopId === target.stopId);
    let snapshot = this.executionSnapshot({ ...plan, executionEvents: targetEvents, routeLegs: [] }, [target]);
    for (const item of [...(input.arrivedAt ? [{ type: 'arrive' as const, at: input.arrivedAt }] : []), { type: input.type, at: input.occurredAt }]) {
      if (input.arrivedAt && Date.parse(input.arrivedAt) > Date.parse(input.occurredAt)) throw new Error('完成时间不能早于到达时间。');
      this.assertHistoryTime({ ...plan, stops: snapshot.stops || [], executionEvents: snapshot.executionEvents }, item.at, target.stopId);
      const result = applyExecutionEvent(snapshot, { stopId: target.stopId, type: item.type, occurredAt: item.at, recordedAt: this.now(), planId });
      if (!result.ok || !result.snapshot) throw new PlanExecutionConflictError(result.error?.message || '无法补记。', result.error?.code);
      snapshot = result.snapshot;
    }
    const appended = (snapshot.executionEvents || []).slice(targetEvents.length);
    return this.commitHistory(plan, snapshot.stops![0], [...originalEvents, ...appended]);
  }

  correctHistory(actorId: string, planId: string, input: { eventId: string; status: 'planned' | 'completed' | 'skipped'; occurredAt?: string; reason?: string; expectedRevision: number }) {
    const plan = this.storedHistory(actorId, planId);
    this.assertHistoryEditable(plan, input.expectedRevision);
    if (!['planned', 'completed', 'skipped'].includes(input.status)) throw new Error('往日记录不能改为实时进行中。');
    const event = (plan.executionEvents || []).find(item => item.executionEventId === input.eventId);
    if (!event) throw new Error('这条实际记录不存在，请刷新。');
    const target = (this.historyView(plan).stops as PlanStop[]).find(stop => stop.stopId === event.stopId);
    if (!target) throw new Error('记录对应的地点不存在。');
    if (input.occurredAt) this.assertHistoryTime(plan, input.occurredAt, target.stopId);
    const originalEvents = plan.executionEvents || [], events = originalEvents.filter(item => item.stopId === target.stopId);
    const result = applyExecutionCorrection(this.executionSnapshot({ ...plan, executionEvents: events, routeLegs: [] }, [target]), {
      eventIdToCorrect: event.executionEventId, type: event.type, statusOverride: input.status, correctionReason: input.reason,
      occurredAt: input.occurredAt, recordedAt: this.now(), planId,
    });
    if (!result.ok || !result.snapshot) throw new PlanExecutionConflictError(result.error?.message || '无法纠正。', result.error?.code);
    return this.commitHistory(plan, result.snapshot.stops![0], [...originalEvents, ...(result.snapshot.executionEvents || []).slice(events.length)]);
  }

  list(actorId: string, tripId?: string) {
    this.purgePastDatedPlans(actorId);
    this.plans.forEach(sortSavedPlanStops);
    return this.plans
      .filter(plan => plan.ownerId === actorId && (!tripId || plan.tripId === tripId))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .map(plan => {
        const { versions: _versions, ...visible } = this.planView(plan);
        return visible;
      });
  }
  versions(actorId: string, planId: string): SavedPlanVersion[] {
    const plan = this.get(actorId, planId);
    if (plan.kind !== 'plan') throw new Error('只有单日计划有历史快照。');
    return [...(plan.versions || [])].reverse().map((version, index) => structuredClone({
      ...version,
      revision: Number.isInteger(version.revision) ? version.revision : index + 1,
    }));
  }
  restoreVersion(actorId: string, planId: string, versionRevision: number, expectedRevision: number) {
    const current = this.get(actorId, planId);
    this.assertPlanRevision(current, expectedRevision);
    const version = this.versions(actorId, planId).find(v => v.revision === versionRevision);
    if (!version) throw new Error('这个历史版本已不存在，请重新查看历史记录。');
    const view = this.planView(current);
    const eventIds = new Set((view.executionEvents || []).map(e => e.stopId));
    const preserved = (view.stops as PlanStop[]).filter(s => eventIds.has(s.stopId) || (s.status && s.status !== 'planned'));
    const preservedIds = new Set(preserved.map(s => s.stopId));
    const pending = structuredClone(version.stops).filter(s => !preservedIds.has((s as PlanStop).stopId)) as PlanStop[];
    pending.forEach(s => { s.status = 'planned'; });
    pending.sort((a, b) => getStopStart(a) - getStopStart(b));
    let cursor = Math.max(0, ...preserved.filter(s => s.status !== 'planned' && s.status !== 'skipped').map(s => getStopEnd(s)));
    const minuteAt = (instant: string) => {
      const timezone = current.timezone || DEFAULT_TIMEZONE;
      const now = new Date(instant);
      const today = dateKeyInTimeZone(now, timezone);
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      const minute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
      return (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${current.localDate}T00:00:00Z`)) / 86400000 * 1440 + minute;
    };
    const corrected = new Set((view.executionEvents || []).map(e => e.correctsEventId));
    const timedFacts = new Set(preserved.filter(s => s.status !== 'planned' && s.status !== 'skipped').map(s => s.stopId));
    for (const event of view.executionEvents || []) if (!corrected.has(event.executionEventId) && timedFacts.has(event.stopId)) cursor = Math.max(cursor, minuteAt(event.occurredAt));
    if (preserved.some(s => s.status === 'en_route' || s.status === 'visiting')) cursor = Math.max(cursor, minuteAt(this.now()));
    const scheduled = pending.map(s => {
      const shifted = shiftPlanStops([s], Math.max(0, cursor - getStopStart(s)))[0] as PlanStop;
      cursor = Math.max(cursor, getStopEnd(shifted));
      return shifted;
    });
    const stops = [...preserved, ...scheduled];
    const routes = new Map<string, unknown>();
    for (const leg of [...version.routeLegs, ...view.routeLegs.filter(l => preservedIds.has((l as RouteLeg).toStopId))]) routes.set((leg as RouteLeg).legId, leg);
    const routeLegs = routesForStops([...routes.values()], stops);
    const charges = new Map<string, unknown>();
    for (const charge of [...version.plannedCharges, ...view.plannedCharges.filter(c => {
      const value = c as { stopId?: string; paymentStatus?: string };
      return value.paymentStatus === 'paid' || Boolean(value.stopId && preservedIds.has(value.stopId));
    })]) charges.set((charge as { chargeId: string }).chargeId, charge);
    const plannedCharges = chargesForDay([...charges.values()], stops, routeLegs, current.localDate!);
    // 恢复历史版本时待进行站点按事实顺延（可能落在当前时刻之前），不适用 T8 编辑校验。
    return this.update(actorId, planId, { name: current.name, localDate: current.localDate, timezone: current.timezone, snapshot: { stops, routeLegs, plannedCharges } }, { allowPast: true });
  }
  get(actorId: string, planId: string) {
    this.purgePastDatedPlans(actorId);
    const plan = this.plans.find(item => item.id === planId && item.ownerId === actorId);
    if (!plan) throw new Error('找不到这个方案，或它不属于当前身份。');
    sortSavedPlanStops(plan);
    return plan;
  }

  /**
   * T7 跨天归日（docs/计划与进度三态转换逻辑.md）：执行顺延把站点推进到次日时，
   * 把它们连同执行事实、路线段与花费从当天日计划迁入次日的计划对象；次日没有
   * 计划时自动创建。迁入已有计划时按 T1 自动消解与次日安排的重叠。
   * 返回留在当天的站点/事件/路线/费用与迁移的站点数。
   */
  private migrateNextDayStops(
    actorId: string,
    plan: SavedPlan,
    stops: PlanStop[],
    events: ExecutionEvent[],
    content?: { routeLegs?: unknown[]; plannedCharges?: unknown[] },
  ): { stops: PlanStop[]; events: ExecutionEvent[]; keptLegs: RouteLeg[]; keptCharges: Array<{ stopId?: string }>; migrated: number } {
    const localDate = plan.localDate;
    const routeLegs = (content?.routeLegs ?? plan.routeLegs ?? []) as RouteLeg[];
    const plannedCharges = (content?.plannedCharges ?? plan.plannedCharges ?? []) as Array<{ stopId?: string }>;
    if (!localDate) return { stops, events, keptLegs: routeLegs, keptCharges: plannedCharges, migrated: 0 };
    const crossed = stops.filter(stop => typeof stop.date === 'string' && stop.date > localDate);
    if (!crossed.length) return { stops, events, keptLegs: routeLegs, keptCharges: plannedCharges, migrated: 0 };
    const crossedIds = new Set(crossed.map(stop => stop.stopId));
    const byDate = new Map<string, PlanStop[]>();
    for (const stop of crossed) {
      const date = stop.date as string;
      const list = byDate.get(date) || [];
      list.push(stop);
      byDate.set(date, list);
    }
    const remainingEvents: ExecutionEvent[] = [];
    const movedEvents: ExecutionEvent[] = [];
    for (const event of events || []) {
      if (event.stopId && crossedIds.has(event.stopId)) movedEvents.push(event);
      else remainingEvents.push(event);
    }
    const movedLegs: RouteLeg[] = [];
    const keptLegs: RouteLeg[] = [];
    for (const leg of routeLegs) {
      const toCrossed = Boolean(leg.toStopId && crossedIds.has(leg.toStopId));
      const fromCrossed = Boolean(leg.fromStopId && crossedIds.has(leg.fromStopId));
      if (toCrossed && (fromCrossed || leg.fromStopId === 'origin' || leg.fromStopId === 'my-location')) movedLegs.push(leg);
      else if (toCrossed || fromCrossed) continue; // 跨越日期边界的路线段已失效，丢弃。
      else keptLegs.push(leg);
    }
    const movedCharges: Array<{ stopId?: string; routeLegRef?: string }> = [];
    const keptCharges: Array<{ stopId?: string; routeLegRef?: string }> = [];
    const movedRouteTargets = new Map(movedLegs.map(leg => [leg.legId, leg.toStopId]));
    for (const charge of plannedCharges) {
      const routeTarget = movedRouteTargets.get((charge as { routeLegRef?: string }).routeLegRef || '');
      if ((charge.stopId && crossedIds.has(charge.stopId)) || routeTarget) movedCharges.push(charge);
      else keptCharges.push(charge);
    }
    const staged: Array<{ existing?: SavedPlan; next: SavedPlan }> = [];
    for (const [date, dayStops] of [...byDate].sort(([left], [right]) => left.localeCompare(right))) {
      const stopIds = new Set(dayStops.map(stop => stop.stopId));
      const dayEvents = movedEvents.filter(event => stopIds.has(event.stopId));
      const dayLegs = movedLegs.filter(leg => stopIds.has(leg.toStopId) || leg.toStopId === 'origin' || leg.toStopId === 'my-location');
      const dayCharges = movedCharges.filter(charge => charge.stopId ? stopIds.has(charge.stopId)
        : Boolean(charge.routeLegRef && dayLegs.some(leg => leg.legId === charge.routeLegRef)));
      const dayStopsForTarget = dayStops.map(stop => {
        const copy = { ...stop } as Record<string, unknown>;
        delete copy.date; // 日计划的站点跟随 plan.localDate，不自带日期。
        return copy as unknown as PlanStop;
      });
      const existing = this.plans.find(item =>
        item.ownerId === actorId && item.kind === 'plan' && item.localDate === date && !Array.isArray(item.days));
      if (existing) {
        // Replay factual status before scheduling: persisted base stops can still say planned.
        const statuses = new Map((this.planView(existing).stops as PlanStop[]).map(stop => [stop.stopId, stop.status]));
        const original = (existing.stops as PlanStop[]).map(stop => ({ ...stop, status: statuses.get(stop.stopId) || stop.status }));
        const merged = autoShiftDatedPlanStops([...original, ...dayStopsForTarget]) as PlanStop[];
        for (const stop of original) {
          const after = merged.find(item => item.stopId === stop.stopId)!;
          if ((stop.timeLocked || stop.lockTime || stop.visitWindow || (stop.status && stop.status !== 'planned')) &&
            (getStopStart(stop) !== getStopStart(after) || getStopEnd(stop) !== getStopEnd(after))) {
            throw new Error(`${date} 的「${stop.place?.name || stop.stopId}」有固定时段或进度，不能自动顺延；本次修改尚未保存。`);
          }
        }
        // Preserve original stored statuses; factual status is always derived from the event log.
        const originalStatuses = new Map((existing.stops as PlanStop[]).map(stop => [stop.stopId, stop.status]));
        const next = { ...structuredClone(existing), stops: merged.map(stop => originalStatuses.has(stop.stopId)
          ? { ...stop, status: originalStatuses.get(stop.stopId) } : stop),
          routeLegs: [...(existing.routeLegs || []), ...dayLegs], plannedCharges: [...(existing.plannedCharges || []), ...dayCharges],
          executionEvents: [...(existing.executionEvents || []), ...dayEvents], revision: (existing.revision || 0) + 1, savedAt: this.now() };
        assertPlanContent(next.stops, next.routeLegs, next.plannedCharges, `${date} 日计划`);
        staged.push({ existing, next });
      } else {
        const created: SavedPlan = {
          id: `plan_${randomUUID()}`, ownerId: actorId, kind: 'plan',
          name: `${date} 日计划`, cityCode: plan.cityCode, localDate: date,
          timezone: plan.timezone, savedAt: this.now(), source: 'current',
          stops: autoShiftDatedPlanStops(dayStopsForTarget as unknown[]) as PlanStop[], routeLegs: dayLegs,
          plannedCharges: dayCharges, revision: 0, executionEvents: dayEvents,
        };
        assertPlanContent(created.stops, created.routeLegs, created.plannedCharges, `${date} 日计划`);
        staged.push({ next: created });
      }
    }
    // Validate every destination first. A conflict on the last date leaves all dates untouched.
    for (const { existing, next } of staged) {
      if (existing) Object.assign(existing, next);
      else this.plans.push(next);
    }
    return {
      stops: stops.filter(stop => !(typeof stop.date === 'string' && stop.date > localDate)),
      events: remainingEvents,
      keptLegs,
      keptCharges,
      migrated: crossed.length,
    };
  }

  previewDaytime(actorId: string, planId: string, input: Record<string, unknown>) {
    const plan = this.get(actorId, planId);
    if (plan.kind !== 'plan' || !plan.localDate) throw new Error('请在带日期的日计划中调整白天安排。');
    if (typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('请提供当前计划版本。');
    this.assertPlanRevision(plan, input.expectedRevision);
    const firstDate = typeof input.firstDate === 'string' ? input.firstDate : addPlanDate(plan.localDate, 1);
    const today = dateKeyInTimeZone(new Date(this.now()), plan.timezone || DEFAULT_TIMEZONE);
    if (!isValidDateKey(firstDate) || firstDate < plan.localDate || firstDate < today) throw new Error('白天安排必须放在原日期或之后的有效日期。');
    let minimumStartMinutes = 540;
    if (firstDate === today) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: plan.timezone || DEFAULT_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(this.now()));
      const nowMinutes = Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
      minimumStartMinutes = Math.max(540, Math.ceil(nowMinutes / 30) * 30);
    }
    const preview = daytimePlanPreview(this.planView(plan), this.plans.filter(item => item.ownerId === actorId && item.kind === 'plan').map(item => this.planView(item)), String(input.stopId || ''), firstDate, minimumStartMinutes);
    const digest = { planId: plan.id, revision: plan.revision || 0, firstDate, stopId: preview.stopId,
      expectedCarryTargets: preview.expectedCarryTargets, destinations: preview.destinations.map(day => ({ date: day.date, stops: day.stops })),
      preserved: preview.preserved, routeLegs: preview.snapshot.routeLegs, plannedCharges: preview.snapshot.plannedCharges };
    return { ...preview, planId: plan.id, expectedRevision: plan.revision || 0,
      previewKey: createHash('sha256').update(JSON.stringify(digest)).digest('hex') };
  }

  applyDaytime(actorId: string, planId: string, input: Record<string, unknown>) {
    // Recompute the entire reviewed proposal; client-supplied stop content is never trusted.
    const preview = this.previewDaytime(actorId, planId, input);
    if (input.previewKey !== preview.previewKey) throw new SavedPlanRevisionConflictError('计划或接续日期已有变化，请重新预览白天安排；本次未保存。');
    const original = this.get(actorId, planId);
    const frozenNow = this.now();
    const working = new PlanLibraryService(() => frozenNow);
    working.plans = structuredClone(this.plans); working.historyPlans = structuredClone(this.historyPlans);
    working.update(actorId, planId, { name: original.name, localDate: original.localDate, timezone: original.timezone, cityCode: original.cityCode,
      expectedRevision: preview.expectedRevision,
      ...(preview.expectedCarryTargets.length ? { expectedCarryTargets: preview.expectedCarryTargets } : {}), snapshot: preview.snapshot });
    // Nothing in the live library changes until source, facts and every destination pass validation.
    this.plans = working.plans;
    return { planId, movedCount: preview.destinations.reduce((count, day) => count + day.stops.length, 0),
      dates: preview.destinations.map(day => day.date), plans: this.list(actorId) };
  }

  recordExecution(actorId: string, planId: string, input: {
    stopId: string;
    type: ExecutionEventType;
    occurredAt: string;
    expectedRevision?: number;
    estimatedTravelMinutes?: number;
    estimatedTransportMode?: TransportMode;
  }) {
    const plan = this.get(actorId, planId);
    this.assertTodayPlan(plan);
    this.assertPlanRevision(plan, input.expectedRevision);
    this.assertExecutionDate(plan, input.occurredAt, input.stopId);
    if (input.type === 'depart' || input.type === 'arrive') this.assertNoOtherActivePlan(actorId, planId);
    return this.applyRecordedExecution(actorId, plan, input);
  }

  /**
   * 记录执行事实的公共落点（不做今日/日期/版本断言），供今日进度记录与后续扩展复用。
   * 计划游览窗口最多 24h，实际完成时间不截断；未结束访问保留并提示超时待核对。
   */
  private applyRecordedExecution(actorId: string, plan: SavedPlan, input: {
    stopId: string;
    type: ExecutionEventType;
    occurredAt: string;
    estimatedTravelMinutes?: number;
    estimatedTransportMode?: TransportMode;
  }) {
    const baseline = this.progressBaseStops(plan).filter(stop => stop.status !== 'skipped')
      .map(stop => ({ ...stop, status: 'planned' as const }));
    const replay = replayExecutionEvents(baseline, plan.executionEvents || []);
    if (replay.errors.length) throw new Error('这份计划的进度记录有冲突，请先纠正相关记录。');
    const snapshot = this.executionSnapshot(plan, replay.stops);
    // 本次路线估算必须在应用出发事件前可用，作为正确的出发基准；失败清除旧估算。
    if (input.type === 'depart') {
      const target = snapshot.stops!.find(stop => stop.stopId === input.stopId);
      if (target) {
        delete target.estimatedTravelMinutes;
        delete target.estimatedTransportMode;
        if (Number.isFinite(input.estimatedTravelMinutes) && input.estimatedTravelMinutes! > 0) target.estimatedTravelMinutes = Math.ceil(input.estimatedTravelMinutes!);
        if (input.estimatedTransportMode) target.estimatedTransportMode = input.estimatedTransportMode;
      }
    }
    const result = applyExecutionEvent(snapshot, {
      stopId: input.stopId,
      type: input.type,
      planId: plan.id,
      occurredAt: input.occurredAt,
      recordedAt: this.now(),
    });
    if (!result.ok || !result.snapshot) throw new PlanExecutionConflictError(result.error?.message || '无法记录进度。', result.error?.code);
    // The domain aligns actual times and shifts remaining stops. Persist that
    // schedule together with the event; retaining only the event loses the shift.
    const excludedStops = (plan.stops as PlanStop[]).filter(stop => stop.status === 'skipped');
    const alignedStops = (result.snapshot.stops || []).map(stop => ({ ...stop, status: 'planned' as const }));
    // 出发时只写入有效路线估时；路线不可用时保留交通方式但不伪造耗时。中止后估算作废。
    if (input.type === 'depart' || input.type === 'abort') {
      for (const stop of alignedStops) {
        if (stop.stopId !== input.stopId) continue;
        if (input.type === 'abort') {
          delete stop.estimatedTravelMinutes;
          delete stop.estimatedTransportMode;
        } else {
          const minutes = Number(input.estimatedTravelMinutes);
          if (Number.isFinite(minutes) && minutes > 0) stop.estimatedTravelMinutes = Math.ceil(minutes);
          if (input.estimatedTransportMode) stop.estimatedTransportMode = input.estimatedTransportMode;
        }
      }
    }
    const carriedIds = alignedStops.filter(stop => stop.date && plan.localDate && stop.date > plan.localDate).map(stop => stop.stopId);
    const split = this.migrateNextDayStops(actorId, plan, alignedStops, result.snapshot.executionEvents || []);
    if (input.type === 'depart') plan.departureCarry = { stopId: input.stopId, movedStopIds: [...new Set([
      ...(plan.departureCarry?.stopId === input.stopId ? plan.departureCarry.movedStopIds : []), ...carriedIds,
    ])] };
    plan.stops = [...split.stops, ...excludedStops];
    plan.executionEvents = split.events;
    plan.routeLegs = split.keptLegs as typeof plan.routeLegs;
    plan.plannedCharges = split.keptCharges as typeof plan.plannedCharges;
    plan.revision = (plan.revision || 0) + 1;
    plan.needsReview = result.snapshot.planningStatus === 'needs_review';
    this.maybeCreateJourneyMemory(actorId, plan, 'manual');
    const interruptedArrangements = input.type === 'abort' && plan.departureCarry?.stopId === input.stopId
      ? this.plans.filter(candidate => candidate.ownerId === actorId && candidate.kind === 'plan' && candidate.id !== plan.id && !candidate.historyArchivedAt)
        .flatMap(candidate => {
          const view = this.planView(candidate);
          const carried = (view.stops as PlanStop[]).filter(stop => plan.departureCarry!.movedStopIds.includes(stop.stopId) && (stop.status || 'planned') === 'planned');
          if (!carried.length || carried.every(stop => getStopStart(stop) >= 540 && getStopEnd(stop) <= 1200)) return [];
          const eventIds = new Set((candidate.executionEvents || []).map(event => event.stopId));
          const movable = carried.find(stop => !eventIds.has(stop.stopId) && !stop.timeLocked && !stop.lockTime && !stop.visitWindow);
          return [{ planId: candidate.id, localDate: candidate.localDate!, stopId: movable?.stopId || carried[0].stopId,
            names: carried.map(stop => stop.place?.name || stop.stopId), canMoveToDaytime: Boolean(movable) }];
        }) : [];
    return { ...this.planView(plan), migratedNextDayStops: split.migrated, ...(input.type === 'abort' ? { interruptedArrangements } : {}) };
  }

  correctExecution(actorId: string, planId: string, input: {
    eventId: string;
    type: ExecutionEventType;
    status: StopStatus;
    reason?: string;
    occurredAt?: string;
    expectedRevision?: number;
  }) {
    const plan = this.get(actorId, planId);
    this.assertTodayPlan(plan);
    this.assertPlanRevision(plan, input.expectedRevision);
    if (input.status === 'en_route' || input.status === 'visiting') this.assertNoOtherActivePlan(actorId, planId);
    if (input.occurredAt) {
      const correctionTarget = (plan.executionEvents || []).find(event => event.executionEventId === input.eventId);
      this.assertExecutionDate(plan, input.occurredAt, correctionTarget?.stopId);
    }
    const baseline = this.progressBaseStops(plan).filter(stop => stop.status !== 'skipped')
      .map(stop => ({ ...stop, status: 'planned' as const }));
    const snapshot = this.executionSnapshot(plan, baseline);
    const result = applyExecutionCorrection(snapshot, {
      eventIdToCorrect: input.eventId,
      type: input.type,
      statusOverride: input.status,
      correctionReason: input.reason,
      occurredAt: input.occurredAt,
      recordedAt: this.now(),
      planId: plan.id,
    });
    if (!result.ok || !result.snapshot) throw new PlanExecutionConflictError(result.error?.message || '无法纠正进度。', result.error?.code);
    const excludedStops = (plan.stops as PlanStop[]).filter(stop => stop.status === 'skipped');
    const alignedStops = (result.snapshot.stops || []).map(stop => ({ ...stop, status: 'planned' as const }));
    const split = this.migrateNextDayStops(actorId, plan, alignedStops, result.snapshot.executionEvents || []);
    plan.stops = [...split.stops, ...excludedStops];
    plan.executionEvents = split.events;
    plan.routeLegs = split.keptLegs as typeof plan.routeLegs;
    plan.plannedCharges = split.keptCharges as typeof plan.plannedCharges;
    plan.revision = (plan.revision || 0) + 1;
    plan.needsReview = result.snapshot.planningStatus === 'needs_review';
    this.maybeCreateJourneyMemory(actorId, plan, 'manual');
    return { ...this.planView(plan), migratedNextDayStops: split.migrated };
  }

  /** Move the former active-Trip plan and its recorded progress into account-owned dated plans. */
  migrateLegacyTrip(actorId: string, view: LegacyTripViewForMigration) {
    const trip = view?.trip;
    const snapshot = view?.snapshot;
    if (!trip?.tripId || !snapshot || !['draft', 'active'].includes(trip.lifecycle)) return { plans: [], migratedEvents: 0 };

    const timezone = snapshot.timezone || trip.timezone || DEFAULT_TIMEZONE;
    const today = dateKeyInTimeZone(new Date(this.now()), timezone);
    const fallbackDate = snapshot.travelDate || snapshot.localDate || trip.localDate || view.clock?.date || today;
    const events = Array.isArray(snapshot.executionEvents) ? snapshot.executionEvents : [];
    const groups = new Map<string, PlanStop[]>();
    for (const value of snapshot.stops || []) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const stop = value as PlanStop;
      const running = stop.status === 'en_route' || stop.status === 'visiting';
      const date = running ? (view.clock?.date || stop.date || fallbackDate) : (stop.date || fallbackDate);
      if (!isValidDateKey(date) || date < today) continue;
      const day = groups.get(date) || [];
      day.push({ ...stop, date });
      groups.set(date, day);
    }

    const migrated: SavedPlan[] = [];
    let migratedEvents = 0;
    for (const [date, legacyStops] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      const stopIds = new Set(legacyStops.map(stop => stop.stopId));
      const dayEvents = events.filter(event => stopIds.has(event.stopId));
      const existing = this.plans.filter(plan => plan.ownerId === actorId && plan.kind === 'plan' && plan.localDate === date);
      if (existing.length > 1) continue;

      const plan = existing[0];
      const relevantEvents = dayEvents.filter(event => event.stopId && stopIds.has(event.stopId));
      let target: SavedPlan;
      if (!plan) {
        const eventStopIds = new Set(relevantEvents.map(event => event.stopId));
        const stops = legacyStops.map(stop => {
          const copy: Record<string, unknown> = { ...stop };
          delete copy.date;
          copy.status = eventStopIds.has(stop.stopId) ? 'planned' : stop.status === 'skipped' ? 'skipped' : 'planned';
          return copy;
        });
        const ids = new Set(stops.map(stop => (stop as Record<string, unknown>).stopId));
        const routeLegs = (snapshot.routeLegs || []).filter(leg => ids.has(leg.toStopId) &&
          (leg.fromStopId === 'origin' || leg.fromStopId === 'my-location' || ids.has(leg.fromStopId)));
        const routeIds = new Set(routeLegs.map(leg => leg.legId));
        const plannedCharges = (snapshot.plannedCharges || []).filter(charge =>
          (!charge.stopId || ids.has(charge.stopId)) && (!charge.routeLegRef || routeIds.has(charge.routeLegRef)));
        assertPlanContent(stops, routeLegs, plannedCharges, `${date} 日计划`);
        target = {
          id: `plan_${randomUUID()}`, ownerId: actorId, kind: 'plan',
          name: `${date} 日计划`, cityCode: resolvePlanCityCode(stops, trip.cityCode), localDate: date,
          timezone, savedAt: this.now(), source: 'current', stops: sortStopsByStartTime(stops), routeLegs,
          plannedCharges, revision: 0, executionEvents: [],
        };
        this.plans.push(target);
      } else {
        target = plan;
        const byId = new Map<string, Record<string, unknown>>();
        for (const value of plan.stops || []) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const stop = value as Record<string, unknown>;
          if (typeof stop.stopId === 'string') byId.set(stop.stopId, { ...stop });
        }
        const eventStopIds = new Set(relevantEvents.map(event => event.stopId));
        for (const stop of legacyStops) {
          if (byId.has(stop.stopId)) continue;
          const copy: Record<string, unknown> = { ...stop };
          delete copy.date;
          copy.status = eventStopIds.has(stop.stopId) ? 'planned' : stop.status === 'skipped' ? 'skipped' : 'planned';
          byId.set(stop.stopId, copy);
        }
        const mergedStops = [...byId.values()];
        const ids = new Set(mergedStops.map(stop => String(stop.stopId || '')));
        const routeById = new Map<string, RouteLeg>();
        const legacyRouteLegs = [...(plan.routeLegs || []), ...(snapshot.routeLegs || [])] as RouteLeg[];
        for (const leg of legacyRouteLegs) {
          if (!ids.has(leg.toStopId) || !(leg.fromStopId === 'origin' || leg.fromStopId === 'my-location' || ids.has(leg.fromStopId))) continue;
          if (!routeById.has(leg.legId)) routeById.set(leg.legId, leg);
        }
        const routeLegs = [...routeById.values()];
        const routeIds = new Set(routeLegs.map(leg => leg.legId));
        const chargeById = new Map<string, Record<string, unknown>>();
        for (const value of [...(plan.plannedCharges || []), ...(snapshot.plannedCharges || [])]) {
          const charge = value as Record<string, unknown>;
          if ((charge.stopId && !ids.has(String(charge.stopId))) || (charge.routeLegRef && !routeIds.has(String(charge.routeLegRef)))) continue;
          const key = typeof charge.chargeId === 'string' ? charge.chargeId : JSON.stringify(charge);
          if (!chargeById.has(key)) chargeById.set(key, charge);
        }
        const plannedCharges = [...chargeById.values()];
        assertPlanContent(mergedStops, routeLegs, plannedCharges, `${date} 日计划`);
        const contentChanged = !isDeepStrictEqual(plan.stops, mergedStops) || !isDeepStrictEqual(plan.routeLegs, routeLegs) || !isDeepStrictEqual(plan.plannedCharges, plannedCharges);
        if (contentChanged) {
          plan.versions = plan.versions || [];
          plan.versions.unshift({ revision: (plan.revision || 0) + 1, createdAt: this.now(), name: plan.name,
            cityCode: plan.cityCode, localDate: plan.localDate, timezone: plan.timezone,
            stops: structuredClone(plan.stops), routeLegs: structuredClone(plan.routeLegs), plannedCharges: structuredClone(plan.plannedCharges) });
          plan.versions = plan.versions.slice(0, 5);
          plan.stops = sortStopsByStartTime(mergedStops);
          plan.routeLegs = routeLegs;
          plan.plannedCharges = plannedCharges;
        }
        if (contentChanged) plan.revision = (plan.revision || 0) + 1;
      }

      const knownEvents = new Set((target.executionEvents || []).map(event => event.executionEventId));
      const importedEvents = relevantEvents.flatMap(event => {
        if (knownEvents.has(event.executionEventId)) return [];
        const { tripId: _legacyTripId, ...copy } = event;
        knownEvents.add(event.executionEventId);
        return [{ ...copy, planId: target.id }];
      });
      if (importedEvents.length) {
        const baseline = (target.stops as PlanStop[]).filter(stop => stop.status !== 'skipped')
          .map(stop => ({ ...stop, status: 'planned' as const }));
        const candidate = [...(target.executionEvents || []), ...importedEvents];
        const replay = replayExecutionEvents(baseline, candidate);
        if (!replay.errors.length) {
          target.executionEvents = candidate;
          target.revision = (target.revision || 0) + 1;
          migratedEvents += importedEvents.length;
        }
      }
      // 迁移完成后，日期计划必须成为账号自己的独立数据；保留 tripId 会让过期清理
      // 把它误判为旧旅行附属内容，也会让“无旅行实例”再次影响计划生命周期。
      delete target.tripId;
      migrated.push(this.planView(target));
    }
    return { plans: migrated, migratedEvents };
  }

  save(actorId: string, input: Record<string, unknown>, source: SavedPlan['source'] = 'current', context?: Record<string, unknown>, tripId?: string) {
    this.purgePastDatedPlans(actorId);
    this.assertCarryTargets(actorId,input);
    const name = requiredText(input.name, '方案名称', 40);
    const kind: 'plan' | 'scheme' = input.kind === 'scheme' ? 'scheme' : 'plan';
    const rawSnapshot = input.snapshot ?? {};
    if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) throw new Error('方案内容无效。');
    const snapshot = rawSnapshot as Record<string, unknown>;
    const rawLocalDate = input.localDate || context?.localDate;
    const localDate = rawLocalDate ? requiredText(rawLocalDate, '日期', 10) : '';
    const rawTimezone = input.timezone ?? context?.timezone;
    const timezone = rawTimezone ? requiredText(rawTimezone, '时区', 80) : undefined;
    if (timezone && !isValidTimeZone(timezone)) throw new Error('请选择有效的时区。');
    const today = dateKeyInTimeZone(new Date(this.now()), timezone || DEFAULT_TIMEZONE);
    if (localDate && !isValidDateKey(localDate)) throw new Error('请选择有效的日期。');
    if (kind === 'plan' && localDate && localDate < today) {
      throw new Error('单日计划只能保存为今天或未来的安排；过去的计划会自动清理。');
    }
    if (kind === 'plan') this.assertUniqueDatedPlanDate(actorId, localDate);
    const initialStops = kind === 'scheme'
      ? planStopsFromDays(input.days)
      : Array.isArray(snapshot.stops) ? snapshot.stops : [];
    const base = {
      id: `plan_${randomUUID()}`, ownerId: actorId, ...(tripId ? { tripId } : {}), kind, name, savedAt: this.now(), source,
      cityCode: resolvePlanCityCode(initialStops, context?.cityCode ?? input.cityCode),
      ...(localDate ? { localDate } : {}),
      ...(timezone ? { timezone } : {}),
    };
    // 同一身份下方案名唯一，避免"轻松版"越攒越多分不清。
    if (this.plans.some(p => p.ownerId === actorId && p.name === name)) {
      throw new Error('已有同名方案，换一个名字吧。');
    }
    if (kind === 'scheme') {
      const rawDays = Array.isArray(input.days) ? input.days : [];
      if (!rawDays.length) throw new Error('多天方案至少要有一天，请先添加计划。');
      const globalStopIds = new Set<string>();
      let days: SavedPlanDay[] = rawDays.map((rawDay: unknown, index) => {
        if (!rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay)) throw new Error(`第 ${index + 1} 天的内容无效。`);
        const day = rawDay as Record<string, unknown>;
        if (!Array.isArray(day.stops)) throw new Error(`第 ${index + 1} 天的内容缺失，请重新保存。`);
        const routeLegs = optionalArray(day.routeLegs, `第 ${index + 1} 天路线`);
        const plannedCharges = optionalArray(day.plannedCharges, `第 ${index + 1} 天费用`);
        assertPlanContent(day.stops, routeLegs, plannedCharges, `第 ${index + 1} 天`, globalStopIds);
        return {
          dayIndex: index,
          ...(day.planId ? { planId: String(day.planId) } : {}),
          stops: stripStopDates(sortStopsByStartTime(day.stops)),
          routeLegs,
          plannedCharges,
        };
      });
      days = normalizeSchemeDays(days);
      const normalizedIds = new Set<string>();
      days.forEach((day, index) => assertPlanContent(day.stops, day.routeLegs, day.plannedCharges || [], `第 ${index + 1} 天`, normalizedIds));
      assertNoCrossDayOverlap(days);
      const plan: SavedPlan = { ...base, days, stops: [], routeLegs: [], plannedCharges: [] };
      this.plans.push(plan);
      return plan;
    }
    const stops = Array.isArray(snapshot.stops) ? snapshot.stops : null;
    if (!stops) throw new Error('方案内容缺失，请重新保存。');
    const routeLegs = optionalArray(snapshot.routeLegs, '路线');
    const plannedCharges = optionalArray(snapshot.plannedCharges, '费用');
    // 与 update() 一致：日计划创建时也先顺延消解重叠，再严格校验，
    // 保证直接调用接口、Agent 操作和编辑页得到完全一致的结果。
    const adjustedStops = autoShiftDatedPlanStops(stops as unknown[]);
    assertPlanContent(adjustedStops, routeLegs, plannedCharges);
    const plan: SavedPlan = {
      ...base,
      stops: stripStopDates(sortStopsByStartTime(adjustedStops)), routeLegs,
      plannedCharges,
      revision: 0,
      executionEvents: [],
    };
    if (localDate) {
      // T7：新建日计划同样不保留「次日起始」的站点，直接归入对应日期的计划。
      const marked = markStopsPastMidnight(plan.stops as unknown[], localDate);
      if (marked.crossed) {
        const split = this.migrateNextDayStops(actorId, plan, marked.stops as PlanStop[], [], {
          routeLegs: plan.routeLegs, plannedCharges: plan.plannedCharges,
        });
        plan.stops = split.stops;
        plan.routeLegs = split.keptLegs;
        plan.plannedCharges = split.keptCharges;
      }
    }
    this.plans.push(plan);
    return plan;
  }
  remove(actorId: string, planId: string) {
    this.purgePastDatedPlans(actorId);
    const plan = this.plans.find(item => item.id === planId && item.ownerId === actorId);
    if (!plan) throw new Error('只能删除自己的方案。');
    this.plans = this.plans.filter(item => item.id !== planId);
    return { removed: true };
  }

  /** 原地编辑：名称/日期/内容整体更新，保留 id 与创建时间。 */
  update(actorId: string, planId: string, input: Record<string, unknown>, options: { allowPast?: boolean } = {}) {
    this.purgePastDatedPlans(actorId);
    const plan = this.get(actorId, planId);
    this.assertCarryTargets(actorId,input);
    if (input.expectedRevision !== undefined) {
      if (typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Error('expectedRevision 必须是非负整数。');
      }
      this.assertPlanRevision(plan, input.expectedRevision);
    }
    const currentPlanView = plan.kind === 'plan' ? this.planView(plan) : null;
    const hasExecutionFacts = Boolean(currentPlanView?.stops.some(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const stop = value as PlanStop;
      return Boolean(stop.status && stop.status !== 'planned');
    }));
    const name = requiredText(input.name, '方案名称', 40);
    if (this.plans.some(p => p.ownerId === actorId && p.id !== planId && p.name === name)) {
      throw new Error('已有同名方案，换一个名字吧。');
    }
    const localDate = input.localDate !== undefined && input.localDate !== null && input.localDate !== ''
      ? requiredText(input.localDate, '日期', 10)
      : plan.kind === 'plan' && input.localDate === undefined
        ? plan.localDate
        : undefined;
    const rawTimezone = input.timezone ?? plan.timezone;
    const timezone = rawTimezone ? requiredText(rawTimezone, '时区', 80) : undefined;
    if (timezone && !isValidTimeZone(timezone)) throw new Error('请选择有效的时区。');
    const today = dateKeyInTimeZone(new Date(this.now()), timezone || DEFAULT_TIMEZONE);
    if (localDate && !isValidDateKey(localDate)) throw new Error('请选择有效的日期。');
    if (plan.kind === 'plan' && localDate && localDate < today) {
      throw new Error('单日计划只能保存为今天或未来的安排；过去的计划会自动清理。');
    }
    if (plan.kind === 'plan' && hasExecutionFacts && localDate !== plan.localDate) {
      throw new Error('已有进度的日计划不能改日期；请先纠正进度，再调整日期。');
    }
    const nextLocalDate = localDate;
    if (plan.kind === 'plan' && nextLocalDate !== plan.localDate) {
      this.assertUniqueDatedPlanDate(actorId, nextLocalDate, planId);
    }
    let nextDays: SavedPlanDay[] | undefined;
    let nextStops: unknown[] | undefined;
    let nextRouteLegs: unknown[] | undefined;
    let nextPlannedCharges: unknown[] | undefined;
    let nextExecutionEvents: ExecutionEvent[] | undefined;
    if (plan.kind === 'scheme') {
      const submittedDays = Array.isArray(input.days) ? input.days as Array<Record<string, unknown>> : [];
      const rawSnapshot = input.snapshot ?? {};
      if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) throw new Error('方案内容无效。');
      const snapshot = rawSnapshot as Record<string, unknown>;
      const rawDays = submittedDays.length
        ? submittedDays
        : (Array.isArray(snapshot.stops) ? [{ dayIndex: 0, stops: snapshot.stops, routeLegs: snapshot.routeLegs || [] }] : []);
      if (!rawDays.length) throw new Error('多天方案至少要有一天，请先添加计划。');
      const globalStopIds = new Set<string>();
      nextDays = rawDays.map((rawDay, index) => {
        if (!rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay)) throw new Error(`第 ${index + 1} 天的内容无效。`);
        const day = rawDay as Record<string, unknown>;
        if (!Array.isArray(day.stops)) throw new Error(`第 ${index + 1} 天的内容缺失，请重新保存。`);
        const routeLegs = optionalArray(day.routeLegs, `第 ${index + 1} 天路线`);
        const plannedCharges = optionalArray(day.plannedCharges, `第 ${index + 1} 天费用`);
        assertPlanContent(day.stops, routeLegs, plannedCharges, `第 ${index + 1} 天`, globalStopIds);
        return {
          dayIndex: index,
          ...(day.planId ? { planId: String(day.planId) } : {}),
          stops: stripStopDates(sortStopsByStartTime(day.stops)),
          routeLegs,
          plannedCharges,
        };
      });
      nextDays = normalizeSchemeDays(nextDays);
      const normalizedIds = new Set<string>();
      nextDays.forEach((day, index) => assertPlanContent(day.stops, day.routeLegs, day.plannedCharges || [], `第 ${index + 1} 天`, normalizedIds));
      assertNoCrossDayOverlap(nextDays);
    } else {
      // 旧的单日方案：兼容 snapshot.stops 与 days 两种提交形态。
      const rawSnapshot = input.snapshot ?? {};
      if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) throw new Error('方案内容无效。');
      const snapshot = rawSnapshot as Record<string, unknown>;
      const submittedDays = Array.isArray(input.days) ? input.days as Array<Record<string, unknown>> : [];
      const stops = Array.isArray(snapshot.stops)
        ? snapshot.stops
        : (submittedDays.length ? submittedDays[0].stops : null);
      if (!stops) throw new Error('方案内容缺失，请重新保存。');
      const routeLegs = optionalArray(
        Array.isArray(snapshot.routeLegs) ? snapshot.routeLegs : (submittedDays.length ? submittedDays[0].routeLegs : undefined),
        '路线',
      );
      const plannedCharges = optionalArray(
        Array.isArray(snapshot.plannedCharges) ? snapshot.plannedCharges : (submittedDays.length ? submittedDays[0].plannedCharges : undefined),
        '费用',
      );
      // 日计划允许调整时间，服务端把后续待进行节点顺延后再校验，保证
      // 直接调用接口、Agent 操作和编辑页得到完全一致的结果。
      const adjustedStops = autoShiftDatedPlanStops(stops as unknown[]);
      assertPlanContent(adjustedStops, routeLegs, plannedCharges);
      if (!options.allowPast) {
        this.assertEditedStopsNotInPast(
          adjustedStops,
          (currentPlanView?.stops ?? []) as PlanStop[],
          localDate || plan.localDate,
          timezone,
        );
      }
      // Keep the response and persisted copy in chronological order.  The
      // edit form can submit a different visual order after a time change;
      // sorting here makes every reader see the same queue immediately.
      nextStops = sortStopsByStartTime(stripStopDates(adjustedStops, true));
      nextRouteLegs = routeLegs;
      nextPlannedCharges = plannedCharges;
    }
    if (plan.kind === 'plan' && plan.sourceSchemeId && nextStops) {
      const nextLocalDate = input.localDate !== undefined ? localDate : plan.localDate;
      const linkedDays = this.plans
        .filter(item => item.ownerId === actorId && item.kind === 'plan' && item.sourceSchemeId === plan.sourceSchemeId)
        .flatMap(item => {
          const date = item.id === plan.id ? nextLocalDate : item.localDate;
          if (!date || !isValidDateKey(date)) return [];
          return [{
            dayIndex: Date.parse(`${date}T00:00:00.000Z`) / 86400000,
            groupId: `plan:${item.id}`,
            label: `${date} 日计划`,
            stops: item.id === plan.id ? nextStops! : item.stops,
          }];
        });
      assertNoCrossDayOverlap(linkedDays);
    }
    const contentChanged = plan.kind === 'plan' && nextStops !== undefined && nextRouteLegs !== undefined &&
      nextPlannedCharges !== undefined && !samePlanContent(plan, nextStops, nextRouteLegs, nextPlannedCharges);
    if (plan.kind === 'plan' && nextStops) {
      const retainedIds = new Set(nextStops.flatMap(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const id = (value as Record<string, unknown>).stopId;
        return typeof id === 'string' ? [id] : [];
      }));
      const currentView = currentPlanView || this.planView(plan);
      const currentStatuses = new Map(currentView.stops.flatMap(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const stop = value as PlanStop;
        return [[stop.stopId, stop.status || 'planned'] as const];
      }));
      const removedInProgress = [...currentStatuses].find(([id, status]) => !retainedIds.has(id) && status !== 'planned');
      if (removedInProgress) throw new Error('有进度记录的地点不能直接删除；请先纠正为未完成，再编辑计划。');
      const submittedById = new Map(nextStops.flatMap(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const stop = value as PlanStop;
        return typeof stop.stopId === 'string' ? [[stop.stopId, stop] as const] : [];
      }));
      for (const [stopId, status] of currentStatuses) {
        if (status === 'planned') continue;
        const currentStop = (currentView.stops as PlanStop[]).find(stop => stop.stopId === stopId);
        const submittedStop = submittedById.get(stopId);
        if (!currentStop || !submittedStop) continue;
        if (!isDeepStrictEqual(executedStopSignature(currentStop), executedStopSignature(submittedStop))) {
          throw new Error('已记录进度的地点不能修改地点或时间；请先纠正进度，再编辑计划。');
        }
      }
      // Defer this mutation until every validation below has passed.  A
      // rejected edit must leave the execution log byte-for-byte unchanged.
      nextExecutionEvents = (plan.executionEvents || []).filter(event => retainedIds.has(event.stopId));
    }
    const priorVersion: SavedPlanVersion | undefined = contentChanged ? {
      revision: Math.max(0, ...(plan.versions || []).map((version, index) => Number.isInteger(version.revision) ? version.revision : index + 1)) + 1,
      createdAt: this.now(),
      name: plan.name,
      cityCode: plan.cityCode,
      ...(plan.localDate ? { localDate: plan.localDate } : {}),
      ...(plan.timezone ? { timezone: plan.timezone } : {}),
      stops: structuredClone(plan.stops),
      routeLegs: structuredClone(plan.routeLegs),
      plannedCharges: structuredClone(plan.plannedCharges),
    } : undefined;
    const linkedPlans = plan.kind === 'scheme'
      ? this.plans.filter(item => item.ownerId === actorId && item.kind === 'plan' && item.sourceSchemeId === plan.id)
      : [];
    const retainedDayIndexes = new Set((nextDays ?? plan.days ?? []).map((day, index) => Number.isInteger(day.dayIndex) ? day.dayIndex : index));
    const detachedPlans = nextDays
      ? linkedPlans.filter(item => {
        try { return !retainedDayIndexes.has(sourceDayIndexOf(item, plan)); }
        catch { return true; }
      })
      : [];
    const detachedPlanIds = new Set(detachedPlans.map(item => item.id));
    const shiftedPlans = plan.kind === 'scheme' && localDate && localDate !== plan.localDate
      ? linkedPlans.filter(item => !detachedPlanIds.has(item.id)).map(item => {
        const dayIndex = sourceDayIndexOf(item, plan);
        const startMs = Date.parse(`${localDate}T00:00:00.000Z`);
        return { plan: item, localDate: new Date(startMs + dayIndex * 86400000).toISOString().slice(0, 10) };
      })
      : [];
    const shiftedDates = new Set(shiftedPlans.map(item => item.localDate));
    const conflicts = this.plans.filter(item =>
      item.ownerId === actorId &&
      item.kind !== 'scheme' &&
      item.sourceSchemeId !== plan.id &&
      item.localDate &&
      shiftedDates.has(item.localDate),
    );
    if (conflicts.length) {
      const dates = [...new Set(conflicts.map(item => item.localDate!))].sort();
      throw new Error(`调整起始日期会与已有计划冲突：${dates.join('、')}。请先处理这些日期的计划。`);
    }
    // T7 编辑路径：起始时间被推过午夜的「计划」站点归入次日计划，日计划不保留
    // 次日起始。放在全部校验之后执行，被拒绝的编辑不会污染其它日期的计划。
    const effectiveLocalDate = localDate || (plan.kind === 'plan' ? plan.localDate : undefined);
    let carried: { stops: PlanStop[]; events: ExecutionEvent[]; keptLegs: RouteLeg[]; keptCharges: Array<{ stopId?: string }>; migrated: number } | null = null;
    if (plan.kind === 'plan' && effectiveLocalDate && nextStops) {
      const marked = markStopsPastMidnight(nextStops, effectiveLocalDate);
      if (marked.crossed) {
        carried = this.migrateNextDayStops(
          actorId,
          { ...plan, localDate: effectiveLocalDate },
          marked.stops as PlanStop[],
          (nextExecutionEvents ?? plan.executionEvents ?? []) as ExecutionEvent[],
          {
            routeLegs: nextRouteLegs ?? plan.routeLegs,
            plannedCharges: nextPlannedCharges ?? plan.plannedCharges,
          },
        );
      }
    }
    plan.name = name;
    if (carried) plan.executionEvents = carried.events;
    else if (nextExecutionEvents) plan.executionEvents = nextExecutionEvents;
    if (localDate) plan.localDate = localDate;
    else delete plan.localDate;
    if (timezone) plan.timezone = timezone;
    if (nextDays) {
      for (const child of detachedPlans) {
        // Keep already-loaded dates as standalone plans if their source day is removed.
        delete child.sourceSchemeId;
        delete child.sourceDayIndex;
      }
      plan.days = nextDays;
    }
    if (nextStops) plan.stops = (carried ? carried.stops : nextStops) as PlanStop[];
    if (carried) {
      plan.routeLegs = carried.keptLegs;
      plan.plannedCharges = carried.keptCharges;
    } else {
      if (nextRouteLegs) plan.routeLegs = nextRouteLegs;
      if (nextPlannedCharges) plan.plannedCharges = nextPlannedCharges;
    }
    plan.revision = (plan.revision || 0) + 1;
    const cityStops = plan.kind === 'scheme' ? planStopsFromDays(nextDays ?? plan.days) : (plan.stops ?? []);
    plan.cityCode = resolvePlanCityCode(cityStops, input.cityCode ?? plan.cityCode);
    if (priorVersion) plan.versions = [...(plan.versions || []), priorVersion].slice(-5);
    for (const shifted of shiftedPlans) {
      const child = shifted.plan;
      // T7 钉扎（docs/计划与进度三态转换逻辑.md）：已开始/已完成的站点属于它们实际
      // 发生的日期——方案改期不搬动它们，并把这份历史副本与方案解绑；只有尚未开始
      // 的站点跟随改期落到新日期。
      const derivedStops = (this.planView(child).stops ?? []) as PlanStop[];
      const executedStops = derivedStops.filter(stop =>
        stop.status === 'completed' || stop.status === 'en_route' || stop.status === 'visiting');
      if (!executedStops.length) { child.localDate = shifted.localDate; continue; }
      const executedIds = new Set(executedStops.map(stop => stop.stopId));
      const executedDates = [...new Set((child.executionEvents || [])
        .map(event => dateKeyInTimeZone(new Date(event.occurredAt), child.timezone || DEFAULT_TIMEZONE))
        .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
      const factsDate = executedDates[0] || child.localDate;
      const movedIds = new Set(derivedStops
        .filter(stop => !executedIds.has(stop.stopId))
        .map(stop => stop.stopId));
      const childEvents = (child.executionEvents || []) as ExecutionEvent[];
      const movedEvents = childEvents.filter(event => movedIds.has(event.stopId));
      child.executionEvents = childEvents.filter(event => !movedIds.has(event.stopId));
      const childLegs = (child.routeLegs || []) as RouteLeg[];
      const movedLegs = childLegs.filter(leg => movedIds.has(leg.toStopId));
      child.routeLegs = childLegs.filter(leg => !movedIds.has(leg.toStopId));
      child.stops = sortStopsByStartTime(executedStops.map(stop => {
        const copy = { ...stop } as Record<string, unknown>;
        copy.status = 'planned'; // 状态由事件重放推导，持久层一律存 planned。
        return copy as unknown as PlanStop;
      }));
      child.localDate = factsDate;
      delete child.sourceSchemeId;
      delete child.sourceDayIndex;
      child.revision = (child.revision || 0) + 1;
      if (!movedIds.size) continue; // 整份都已执行：留在事实日期，不产生新日期副本。
      const plannedCopy: SavedPlan = {
        id: `plan_${randomUUID()}`, ownerId: child.ownerId, kind: 'plan',
        name: child.name, cityCode: child.cityCode, localDate: shifted.localDate,
        timezone: child.timezone, savedAt: this.now(), source: 'current',
        sourceSchemeId: child.sourceSchemeId, sourceDayIndex: child.sourceDayIndex,
        stops: sortStopsByStartTime(derivedStops
          .filter(stop => movedIds.has(stop.stopId))
          .map(stop => {
            const copy = { ...stop } as Record<string, unknown>;
            delete copy.date;
            copy.status = 'planned';
            return copy as unknown as PlanStop;
          })),
        routeLegs: movedLegs, plannedCharges: [],
        revision: 0, executionEvents: movedEvents,
      };
      this.plans.push(plannedCopy);
    }
    return plan;
  }

  /**
   * 方案载入：确定起始日期后，自动展开为每天一份带日期的计划。
   * 第 1 天＝起始日期，第 2 天＝起始日期 +1，以此类推；旅行只是后续可选的执行容器。
   * 幂等：同一方案重复载入时，先移除它上一次展开的计划，再生成新的；方案本体保留在库中，可反复载入与编辑。
   * 目标日期已有日计划或执行进度冲突时先返回清单，由界面确认后再载入；
   * 载入只生成 planned 节点，进度事实保持原样，时间重叠的计划自动顺延。
   */
  loadAsPlans(
    actorId: string,
    planId: string,
    startDate: string,
    replace = false,
    progress: {
      stops: readonly PlanStop[];
      revision?: number;
      confirmed?: boolean;
      confirmationToken?: string;
    } = { stops: [] },
  ): {
    plans?: SavedPlan[];
    conflict?: true;
    dates?: string[];
    progressConflict?: true;
    progressConflicts?: Array<{ date: string; names: string[]; timeOverlap: boolean }>;
    progressAdjustedDates?: string[];
    confirmationToken?: string;
    confirmationStale?: true;
  } {
    this.purgePastDatedPlans(actorId);
    const scheme = this.get(actorId, planId);
    // Facts belong to the account, not to the caller's optional progress payload.
    const ownProgress = this.plans.filter(p => p.ownerId === actorId && p.kind === 'plan' && p.localDate)
      .flatMap(p => (this.planView(p).stops as PlanStop[]).filter(s => s.status && s.status !== 'planned')
        .map(s => {
          if (s.status !== 'visiting' && s.status !== 'en_route') {
            const corrected = new Set((p.executionEvents || []).map(e => e.correctsEventId));
            const latest = (p.executionEvents || []).filter(e => e.stopId === s.stopId && !corrected.has(e.executionEventId))
              .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
            if (!latest || s.status === 'skipped') return { ...s, date: p.localDate };
            const timezone = p.timezone || DEFAULT_TIMEZONE;
            const instant = new Date(latest.occurredAt);
            const eventDate = dateKeyInTimeZone(instant, timezone);
            const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
            const minute = Number(parts.find(part => part.type === 'hour')!.value) * 60 + Number(parts.find(part => part.type === 'minute')!.value);
            const offset = (Date.parse(`${eventDate}T00:00:00Z`) - Date.parse(`${p.localDate}T00:00:00Z`)) / 86400000;
            return { ...s, date: p.localDate, progressEndMinutes: offset * 1440 + minute };
          }
          const timezone = p.timezone || DEFAULT_TIMEZONE;
          const now = new Date(this.now());
          const today = dateKeyInTimeZone(now, timezone);
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
          const minute = Number(parts.find(part => part.type === 'hour')!.value) * 60 + Number(parts.find(part => part.type === 'minute')!.value);
          const offset = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.localDate}T00:00:00Z`)) / 86400000;
          const projected = shiftPlanStops([s], -offset * 1440)[0] as PlanStop;
          return { ...projected, date: today, progressEndMinutes: minute };
        }));
    const progressById = new Map<string, PlanStop>(ownProgress.map(s => [`${s.date}:${s.stopId}`, s]));
    for (const stop of progress.stops) progressById.set(`${stop.date}:${stop.stopId}`, stop);
    progress = { ...progress, stops: [...progressById.values()] };
    if (scheme.kind !== 'scheme' || !scheme.days?.length) throw new Error('单日计划无需载入：它已经是某一天的计划了。');
    const globalStopIds = new Set<string>();
    for (const [index, rawDay] of scheme.days.entries()) {
      if (!rawDay || !Array.isArray(rawDay.stops)) throw new Error(`第 ${index + 1} 天的内容无效，无法载入。`);
      assertPlanContent(
        rawDay.stops,
        optionalArray(rawDay.routeLegs, `第 ${index + 1} 天路线`),
        optionalArray(rawDay.plannedCharges, `第 ${index + 1} 天费用`),
        `第 ${index + 1} 天`,
        globalStopIds,
      );
    }
    assertNoCrossDayOverlap(scheme.days);
    this.assertStartDate(startDate, scheme.timezone || DEFAULT_TIMEZONE);
    const startMs = Date.parse(`${startDate}T00:00:00Z`);
    const scheduledDays: Array<{ day: SavedPlanDay; date: string; stops: unknown[] }> = [];
    const progressConflictMap = new Map<string, { date: string; names: Set<string>; timeOverlap: boolean }>();
    const adjustedDates: string[] = [];
    let lastScheduledDate = '';
    for (const day of scheme.days) {
      const sourceDate = new Date(startMs + day.dayIndex * 86400000).toISOString().slice(0, 10);
      const earliestDate = lastScheduledDate && sourceDate <= lastScheduledDate ? addDays(lastScheduledDate, 1) : sourceDate;
      const sourceStops = day.stops.filter(stop =>
        stop && typeof stop === 'object' && !Array.isArray(stop) && (stop as Record<string, unknown>).status !== 'skipped',
      ).map(stop => ({ ...(stop as Record<string, unknown>), status: 'planned' }));
      const scheduled = scheduleStopsAfterProgress(
        stripStopDates(sortStopsByStartTime(sourceStops)), earliestDate, progress.stops,
      );
      for (const item of scheduled.conflicts) {
        const prior = progressConflictMap.get(item.date) || { date: item.date, names: new Set<string>(), timeOverlap: false };
        item.names.forEach(name => prior.names.add(name));
        prior.timeOverlap ||= item.timeOverlap;
        progressConflictMap.set(item.date, prior);
      }
      if (scheduled.adjusted || scheduled.date !== sourceDate) adjustedDates.push(sourceDate);
      scheduledDays.push({ day, date: scheduled.date, stops: scheduled.stops });
      lastScheduledDate = scheduled.date;
    }
    const dates = scheduledDays.map(item => item.date);
    const progressConflicts = [...progressConflictMap.values()].map(item => ({
      date: item.date, names: [...item.names], timeOverlap: item.timeOverlap,
    }));
    const conflictDates = new Set(dates);
    const conflicts = [...new Set(this.plans
      .filter(p => p.ownerId === actorId && p.kind !== 'scheme' && p.sourceSchemeId !== scheme.id &&
        Boolean(p.localDate && conflictDates.has(p.localDate)))
      .map(p => p.localDate!))].sort();
    const confirmationToken = planLoadConfirmationToken({
      scheme,
      startDate,
      targetDates: dates,
      datedPlans: this.plans.filter(p => p.ownerId === actorId && p.kind !== 'scheme'),
      progressRevision: progress.revision,
      progressStops: progress.stops,
    });
    const confirmationMatches = Boolean(progress.confirmationToken && progress.confirmationToken === confirmationToken);
    const confirmationStale = Boolean(progress.confirmationToken && !confirmationMatches);
    const progressConfirmed = Boolean(progress.confirmed && confirmationMatches);
    const replaceConfirmed = Boolean(replace && confirmationMatches);
    if (confirmationStale || (conflicts.length && !replaceConfirmed) || (progressConflicts.length && !progressConfirmed)) {
      return {
        ...(conflicts.length && !replaceConfirmed ? { conflict: true, dates: conflicts } : {}),
        ...(progressConflicts.length && !progressConfirmed ? {
          progressConflict: true,
          progressConflicts,
        } : {}),
        confirmationToken,
        ...(confirmationStale ? { confirmationStale: true } : {}),
      };
    }
    // 方案是设计稿：展开为带日期的每日计划，本体保留在库中。
    const replaced = this.plans.filter(p => p.ownerId === actorId && (p.sourceSchemeId === scheme.id ||
      (replaceConfirmed && p.kind === 'plan' && p.localDate && conflicts.includes(p.localDate))));
    // Preserve baseline nodes referenced by any event, including corrected events.
    const retained = replaced.map(p => {
      const eventIds = new Set((p.executionEvents || []).map(e => e.stopId));
      const factIds = new Set((this.planView(p).stops as PlanStop[]).filter(s => s.status && s.status !== 'planned').map(s => s.stopId));
      const stops = p.stops.filter(value => eventIds.has((value as PlanStop).stopId) || factIds.has((value as PlanStop).stopId));
      if (!stops.length && !p.executionEvents?.length) return undefined;
      const copy = structuredClone(p);
      copy.stops = structuredClone(stops);
      if (copy.executionEvents?.length && replayExecutionEvents(this.progressBaseStops(copy).map(s => ({ ...s, status: 'planned' as const })), copy.executionEvents).errors.length) {
        throw new Error('已有执行记录不完整，无法载入；原记录已保留。');
      }
      copy.routeLegs = routesForStops(copy.routeLegs, copy.stops);
      copy.plannedCharges = chargesForDay(copy.plannedCharges, copy.stops, copy.routeLegs, copy.localDate!);
      delete copy.sourceSchemeId;
      delete copy.sourceDayIndex;
      return copy;
    }).filter((p): p is SavedPlan => Boolean(p));
    const progressStopIds = new Set([...progress.stops.map(stop => stop.stopId), ...retained.flatMap(p => p.stops.map(s => (s as PlanStop).stopId))]);
    const created = scheduledDays.map(({ day, date, stops: scheduledStops }) => {
      let name = `${scheme.name} · 第 ${day.dayIndex + 1} 天`;
      if (this.plans.some(p => p.ownerId === actorId && p.name === name)) name = `${name}（${date}）`;
      // 导入只写入待进行队列：完成/跳过等模板状态不会变成执行事实。
      // 与已有进度共享 stopId 的节点另建身份，避免挂载时被事实队列静默去重。
      const sourceStops = scheduledStops as Array<Record<string, unknown>>;
      const stopIdMap = new Map(sourceStops.map(stop => {
        const sourceId = String(stop.stopId);
        return [sourceId, progressStopIds.has(sourceId) ? `stop_${randomUUID().replaceAll('-', '')}` : sourceId] as const;
      }));
      let stops = stripStopDates(sortStopsByStartTime(sourceStops.map(stop => ({
        ...stop,
        stopId: stopIdMap.get(String(stop.stopId)) || stop.stopId,
        status: 'planned',
      }))));
      const stopIdsChanged = [...stopIdMap].some(([sourceId, targetId]) => sourceId !== targetId);
      const routeIdMap = new Map<string, string>();
      const routeSources = day.routeLegs || [];
      if (stopIdsChanged) for (const value of routeSources) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const legId = (value as Record<string, unknown>).legId;
        if (typeof legId === 'string') routeIdMap.set(legId, `leg_${randomUUID().replaceAll('-', '')}`);
      }
      const routeLegs = routesForStops(routeSources.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const copy = { ...(value as Record<string, unknown>) };
        for (const field of ['fromStopId', 'toStopId'] as const) {
          const reference = copy[field];
          if (typeof reference === 'string' && stopIdMap.has(reference)) copy[field] = stopIdMap.get(reference);
        }
        if (typeof copy.legId === 'string' && routeIdMap.has(copy.legId)) copy.legId = routeIdMap.get(copy.legId);
        return copy;
      }), stops);
      const plannedCharges = chargesForDay((day.plannedCharges || []).map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const charge = { ...(value as Record<string, unknown>) };
        if (typeof charge.stopId === 'string' && stopIdMap.has(charge.stopId)) charge.stopId = stopIdMap.get(charge.stopId);
        if (typeof charge.routeLegRef === 'string' && routeIdMap.has(charge.routeLegRef)) charge.routeLegRef = routeIdMap.get(charge.routeLegRef);
        if (stopIdsChanged && typeof charge.chargeId === 'string') charge.chargeId = `charge_${randomUUID().replaceAll('-', '')}`;
        return charge;
      }), stops, routeLegs, date);
      assertPlanContent(stops, routeLegs, plannedCharges, `载入后的第 ${day.dayIndex + 1} 天`);
      const plan: SavedPlan = {
        id: `plan_${randomUUID()}`, ownerId: actorId, kind: 'plan', sourceSchemeId: scheme.id, name,
        sourceDayIndex: day.dayIndex, cityCode: scheme.cityCode, localDate: date,
        ...(scheme.timezone ? { timezone: scheme.timezone } : {}), savedAt: this.now(), source: scheme.source,
        stops, routeLegs, plannedCharges, revision: 0, executionEvents: [],
        ...(day.planId ? {} : {}),
      };
      return plan;
    });
    const merged = created.map(plan => {
      const prior = retained.filter(p => p.localDate === plan.localDate);
      if (!prior.length) return plan;
      if (prior.length > 1) throw new Error('同一天存在多份进度记录，需要先合并后再载入方案。');
      const facts = prior[0];
      const copy: SavedPlan = { ...plan, id: facts.id, revision: (facts.revision || 0) + 1,
        versions: facts.versions, executionEvents: facts.executionEvents,
        stops: [...facts.stops, ...plan.stops], routeLegs: [...facts.routeLegs, ...plan.routeLegs],
        plannedCharges: [...facts.plannedCharges, ...plan.plannedCharges] };
      const view = this.planView(copy);
      assertPlanContent(view.stops, view.routeLegs, view.plannedCharges, '载入后计划');
      return copy;
    });
    const replacedIds = new Set(replaced.map(p => p.id));
    const mergedDates = new Set(merged.map(p => p.localDate));
    this.plans = [...this.plans.filter(p => !replacedIds.has(p.id)), ...retained.filter(p => !mergedDates.has(p.localDate)), ...merged];
    // T7 载入路径：展开后的「次日起始」站点不留在当天计划——按日期升序迁入对应的
    // 次日计划（已存在则合并并按 T1 消解重叠）。带执行事实的站点钉在原日期。
    for (const plan of [...merged].sort((left, right) => (left.localDate || '').localeCompare(right.localDate || ''))) {
      if (!plan.localDate) continue;
      const factStopIds = new Set((plan.executionEvents || []).map(event => event.stopId));
      const marked = markStopsPastMidnight(plan.stops as unknown[], plan.localDate, factStopIds);
      if (!marked.crossed) continue;
      const split = this.migrateNextDayStops(actorId, plan, marked.stops as PlanStop[], plan.executionEvents || [], {
        routeLegs: plan.routeLegs, plannedCharges: plan.plannedCharges,
      });
      plan.stops = split.stops;
      plan.executionEvents = split.events;
      plan.routeLegs = split.keptLegs as typeof plan.routeLegs;
      plan.plannedCharges = split.keptCharges as typeof plan.plannedCharges;
    }
    return {
      plans: merged.map(p => this.planView(p)),
      ...(adjustedDates.length ? { progressAdjustedDates: adjustedDates } : {}),
    };
  }
}
