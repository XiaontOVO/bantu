/**
 * 旅行记录的读取与视图构造：所有功能分区都要用的两件事。
 *
 * `ownedTrip` 是**唯一的归属校验入口**。任何按 tripId 存取的资源都必须先经过它，
 * 否则就是一个跨主体读取漏洞（见 http 层的历史修复记录）。
 */
import { normalizeTripSnapshot } from '../../domain/normalize.js';
import { generateJourneyMemory as generateJourneyMemoryDomain } from '../../domain/memory.js';
import { tripClock } from '../../domain/plan-boundaries.js';
import { replayExecutionEvents } from '../../domain/execution.js';
import { commitPlanSnapshot } from './commit.js';
import { id, serviceError } from './helpers.js';
import type { ServiceResult, TripRecord, TripView } from './contracts.js';
import type { TripState } from './state.js';

function dateKeyAt(value: string, timezone: string): string | null {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(instant));
    const part = (name: string) => parts.find(item => item.type === name)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return null;
  }
}

function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function nextDateKey(value: string): string | null {
  if (!isValidDateKey(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function overnightActiveStopIds(
  record: TripRecord,
  snapshot: TripRecord['snapshot'],
  today: string,
  timezone: string,
  fallbackDate: string | undefined,
) {
  const retained = new Set<string>();
  if (record.lifecycle !== 'active') return retained;
  const events = Array.isArray(snapshot.executionEvents) ? snapshot.executionEvents : [];
  const correctedIds = new Set(events.flatMap(event => event.correctsEventId ? [event.correctsEventId] : []));
  for (const stop of Array.isArray(snapshot.stops) ? snapshot.stops : []) {
    const date = stop.date || fallbackDate;
    if (!date || !['en_route', 'visiting'].includes(stop.status || '') || nextDateKey(date) !== today) continue;
    const latest = [...events].reverse().find(event => event.stopId === stop.stopId && !correctedIds.has(event.executionEventId));
    const expectedType = stop.status === 'en_route' ? 'depart' : 'arrive';
    // Corrected active progress keeps the corrected statusOverride while the
    // event type remains the type of the source event it replaces.
    if (latest && (latest.type === expectedType || latest.statusOverride === stop.status) &&
      dateKeyAt(latest.occurredAt, timezone) === date) retained.add(stop.stopId);
  }
  return retained;
}

function pruneExpiredEvents<T extends { occurredAt: string; correctsEventId?: string | null }>(
  events: T[],
  eventId: (event: T) => string,
  timezone: string,
  today: string,
  shouldExpire: (event: T) => boolean = () => false,
  shouldRetain: (event: T) => boolean = () => false,
) {
  const dropped = new Set(events
    .filter(event => shouldExpire(event) || ((dateKeyAt(event.occurredAt, timezone) || today) < today && !shouldRetain(event)))
    .map(eventId));
  // Corrections depend on their source event; remove the whole correction chain together.
  let addedCorrection = true;
  while (addedCorrection) {
    addedCorrection = false;
    for (const event of events) {
      if (event.correctsEventId && dropped.has(event.correctsEventId) && !dropped.has(eventId(event))) {
        dropped.add(eventId(event));
        addedCorrection = true;
      }
    }
  }
  return {
    events: events.filter(event => !dropped.has(eventId(event))),
    dropped,
  };
}

function prunePastSnapshot(record: TripRecord, input: TripRecord['snapshot'], now: string, preserveOvernight = false) {
  const snapshot = normalizeTripSnapshot(structuredClone(input));
  const timezone = snapshot.timezone || record.timezone || 'Asia/Shanghai';
  const today = dateKeyAt(now, timezone);
  if (!today) return { snapshot, changed: false };
  const fallbackDate = snapshot.travelDate || snapshot.localDate || snapshot.tripSettings?.localDate || record.localDate;
  const overnightStopIds = preserveOvernight
    ? overnightActiveStopIds(record, snapshot, today, timezone, fallbackDate)
    : new Set<string>();
  const expiredStopIds = new Set((snapshot.stops || [])
    .filter(stop => {
      const date = stop.date || fallbackDate;
      return Boolean(date && isValidDateKey(date) && date < today && !overnightStopIds.has(stop.stopId));
    })
    .map(stop => stop.stopId));
  let changed = expiredStopIds.size > 0;
  const stops = (snapshot.stops || []).filter(stop => !expiredStopIds.has(stop.stopId));
  const routeLegs = (snapshot.routeLegs || []).filter(leg =>
    !expiredStopIds.has(leg.fromStopId) && !expiredStopIds.has(leg.toStopId));
  if (routeLegs.length !== (snapshot.routeLegs || []).length) changed = true;
  const expiredRouteLegIds = new Set((snapshot.routeLegs || [])
    .filter(leg => !routeLegs.some(retained => retained.legId === leg.legId))
    .map(leg => leg.legId));
  const plannedCharges = (snapshot.plannedCharges || []).filter(charge =>
    (!charge.stopId || !expiredStopIds.has(charge.stopId)) &&
    (!charge.routeLegRef || !expiredRouteLegIds.has(charge.routeLegRef)));
  if (plannedCharges.length !== (snapshot.plannedCharges || []).length) changed = true;

  const constraints = (snapshot.constraints || []).filter(constraint => {
    const stopId = (constraint as { payload?: { stopId?: string } }).payload?.stopId;
    return !stopId || !expiredStopIds.has(stopId);
  });
  if (constraints.length !== (snapshot.constraints || []).length) changed = true;

  const allEvents = snapshot.executionEvents || [];
  const prunedExecution = pruneExpiredEvents(
    allEvents,
    event => event.executionEventId,
    timezone,
    today,
    event => expiredStopIds.has(event.stopId),
    event => overnightStopIds.has(event.stopId),
  );
  const executionEvents = prunedExecution.events;
  if (prunedExecution.dropped.size) changed = true;
  const affectedStopIds = new Set(allEvents
    .filter(event => prunedExecution.dropped.has(event.executionEventId))
    .map(event => event.stopId));
  if (affectedStopIds.size) {
    const replayed = replayExecutionEvents(stops, executionEvents).stops;
    const statusById = new Map(replayed.map(stop => [stop.stopId, stop.status]));
    for (const stop of stops) {
      if (!affectedStopIds.has(stop.stopId)) continue;
      const status = statusById.get(stop.stopId) || 'planned';
      if (stop.status !== status) changed = true;
      stop.status = status;
    }
  }

  const allSpendEvents = snapshot.spendEvents || [];
  const prunedSpend = pruneExpiredEvents(allSpendEvents, event => event.spendEventId, timezone, today);
  const spendEvents = prunedSpend.events;
  if (prunedSpend.dropped.size) changed = true;
  const latestSpend = [...spendEvents].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
  if (latestSpend) {
    if (snapshot.actualSpendMinor !== latestSpend.amountMinor || snapshot.actualSpendComplete !== latestSpend.completenessConfirmed || snapshot.spendRef !== latestSpend.spendEventId) changed = true;
  } else if (prunedSpend.dropped.size || expiredStopIds.size) {
    if (snapshot.actualSpendMinor !== null || snapshot.actualSpendComplete !== undefined || snapshot.spendRef !== null) changed = true;
  }

  const allWalkingEvents = snapshot.walkingEvents || [];
  const prunedWalking = pruneExpiredEvents(allWalkingEvents, event => event.walkingEventId, timezone, today);
  const walkingEvents = prunedWalking.events;
  if (prunedWalking.dropped.size) changed = true;
  const latestWalking = [...walkingEvents].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
  if (latestWalking) {
    if (snapshot.actualWalkingMeters !== latestWalking.walkingMeters || snapshot.actualWalkingComplete !== latestWalking.completenessConfirmed || snapshot.walkingRef !== latestWalking.walkingEventId) changed = true;
  } else if (prunedWalking.dropped.size || expiredStopIds.size) {
    if (snapshot.actualWalkingMeters !== null || snapshot.actualWalkingComplete !== undefined || snapshot.walkingRef !== null) changed = true;
  }

  const droppedSpendIds = prunedSpend.dropped;
  const chargesWithValidSpendRefs = plannedCharges.map(charge => {
    if (!charge.includedSpendEventId || !droppedSpendIds.has(charge.includedSpendEventId)) return charge;
    changed = true;
    return { ...charge, includedSpendEventId: null };
  });

  if (!changed) return { snapshot, changed: false };
  const next = normalizeTripSnapshot({
    ...snapshot,
    stops,
    routeLegs,
    plannedCharges: chargesWithValidSpendRefs,
    constraints,
    executionEvents,
    spendEvents,
    actualSpendMinor: latestSpend?.amountMinor ?? ((prunedSpend.dropped.size || expiredStopIds.size) ? null : snapshot.actualSpendMinor),
    actualSpendComplete: latestSpend?.completenessConfirmed ?? ((prunedSpend.dropped.size || expiredStopIds.size) ? undefined : snapshot.actualSpendComplete),
    spendRef: latestSpend?.spendEventId ?? ((prunedSpend.dropped.size || expiredStopIds.size) ? null : snapshot.spendRef),
    walkingEvents,
    actualWalkingMeters: latestWalking?.walkingMeters ?? ((prunedWalking.dropped.size || expiredStopIds.size) ? null : snapshot.actualWalkingMeters),
    actualWalkingComplete: latestWalking?.completenessConfirmed ?? ((prunedWalking.dropped.size || expiredStopIds.size) ? undefined : snapshot.actualWalkingComplete),
    walkingRef: latestWalking?.walkingEventId ?? ((prunedWalking.dropped.size || expiredStopIds.size) ? null : snapshot.walkingRef),
    // Keep an existing valid status when only older dates were removed; this must not
    // make an intact tomorrow plan look invalid to date switching and execution UI.
    planningStatus: stops.length ? snapshot.planningStatus : 'empty',
  });
  return { snapshot: next, changed: true };
}

function archivePastUnexecutedDays(state: TripState, record: TripRecord, now: string) {
  const archive = state.options.archiveExpiredPlanDay;
  if (!archive) return;
  const snapshot = record.snapshot;
  const timezone = snapshot.timezone || record.timezone || 'Asia/Shanghai';
  const today = dateKeyAt(now, timezone);
  if (!today) return;
  const fallbackDate = snapshot.travelDate || snapshot.localDate || snapshot.tripSettings?.localDate || record.localDate;
  const stopsByDate = new Map<string, NonNullable<typeof snapshot.stops>>();
  for (const stop of Array.isArray(snapshot.stops) ? snapshot.stops : []) {
    if (!stop || typeof stop !== 'object') continue;
    // The current stop state already reflects corrections. A corrected-to-planned
    // stop is still unexecuted, even if older events remain in its history.
    if (stop.status && stop.status !== 'planned') continue;
    const date = stop.date || fallbackDate;
    if (!date || !isValidDateKey(date) || date >= today) continue;
    const dayStops = stopsByDate.get(date) || [];
    dayStops.push(stop);
    stopsByDate.set(date, dayStops);
  }
  const sortedDates = [...stopsByDate.keys()].sort();
  const archivedStandaloneCharges = new Set<string>();
  for (const date of sortedDates) {
    const stops = stopsByDate.get(date)!;
    const stopIds = new Set(stops.map(stop => stop.stopId));
    const routeLegs = (Array.isArray(snapshot.routeLegs) ? snapshot.routeLegs : []).filter(leg =>
      Boolean(leg) && typeof leg.toStopId === 'string' && stopIds.has(leg.toStopId) &&
      (leg.fromStopId === 'origin' || (typeof leg.fromStopId === 'string' && stopIds.has(leg.fromStopId))));
    const routeIds = new Set(routeLegs.map(leg => leg.legId));
    const plannedCharges = (Array.isArray(snapshot.plannedCharges) ? snapshot.plannedCharges : []).filter(charge => {
      if (!charge || typeof charge !== 'object') return false;
      const item = charge as { date?: unknown; localDate?: unknown; stopId?: unknown; routeLegRef?: unknown };
      const chargeDate = item.date ?? item.localDate;
      if (typeof chargeDate === 'string' && chargeDate !== date) return false;
      if (typeof item.stopId === 'string' && !stopIds.has(item.stopId)) return false;
      if (typeof item.routeLegRef === 'string' && !routeIds.has(item.routeLegRef)) return false;
      // A trip-level charge with no date/place/route belongs to the archived
      // trip once. Without this, the same total is copied into every expired day.
      if (typeof chargeDate !== 'string' && typeof item.stopId !== 'string' && typeof item.routeLegRef !== 'string') {
        const key = JSON.stringify(charge);
        if (archivedStandaloneCharges.has(key)) return false;
        archivedStandaloneCharges.add(key);
      }
      return true;
    });
    archive({
      ownerId: record.ownerId,
      tripId: record.tripId,
      cityCode: record.cityCode,
      timezone,
      date,
      stops: structuredClone(stops),
      routeLegs: structuredClone(routeLegs),
      plannedCharges: structuredClone(plannedCharges),
    });
  }
}

/** 已完成的过期行程先冻结成记忆，再由下面的清理逻辑移除进度事实。 */
function archivePastJourneyMemories(record: TripRecord, now: string): boolean {
  const snapshot = record.snapshot;
  const timezone = snapshot.timezone || record.timezone || 'Asia/Shanghai';
  const today = dateKeyAt(now, timezone);
  if (!today) return false;
  const fallbackDate = snapshot.travelDate || snapshot.localDate || snapshot.tripSettings?.localDate || record.localDate;
  const expiredDates = new Set((Array.isArray(snapshot.stops) ? snapshot.stops : [])
    .filter(stop => stop?.status === 'completed')
    .map(stop => stop.date || fallbackDate)
    .filter((date): date is string => Boolean(date && isValidDateKey(date) && date < today)));
  if (!expiredDates.size) return false;

  if (!record.memories) {
    record.memories = { tripId: record.tripId, contentRevision: record.contentRevision, entries: [] };
  }
  let changed = false;
  for (const localDate of expiredDates) {
    const result = generateJourneyMemoryDomain(record.memories, {
      localDate,
      timezone,
      cityCode: record.cityCode,
      generatedBy: 'expiry',
      fallbackDate,
      stops: snapshot.stops || [],
      executionEvents: snapshot.executionEvents || [],
      routeLegs: snapshot.routeLegs || [],
      sourceContentRevision: record.contentRevision,
      now,
    });
    if (result.ok && result.state && result.state !== record.memories) {
      record.memories = result.state;
      record.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

/** 按站点日期清除过期日计划与执行进度，静态方案不在此数据域中。 */
export function purgePastProgress(state: TripState, record: TripRecord): boolean {
  if (record.deletedAt) return false;
  const now = state.now();
  // Persist a reusable design from the current snapshot before past nodes disappear.
  archivePastUnexecutedDays(state, record, now);
  const journeyMemoriesChanged = archivePastJourneyMemories(record, now);
  const current = prunePastSnapshot(record, record.snapshot, now, true);
  const history = (record.versions || []).map(version => {
    const result = prunePastSnapshot(record, version.snapshot, now, true);
    return { version: result.changed ? { ...version, snapshot: result.snapshot } : version, changed: result.changed };
  });
  let proposalsChanged = false;
  for (const proposal of record.proposals.values()) {
    let proposalChanged = false;
    proposal.candidates = proposal.candidates.map(candidate => {
      const result = prunePastSnapshot(record, candidate.snapshot, now);
      if (!result.changed) return candidate;
      proposalChanged = true;
      return { ...candidate, snapshot: result.snapshot };
    });
    if (proposalChanged) {
      proposal.status = 'expired';
      proposalsChanged = true;
    }
  }
  const planChanged = current.changed || history.some(item => item.changed) || proposalsChanged;
  if (!planChanged) {
    if (journeyMemoriesChanged) state.trips.set(record.tripId, record);
    return journeyMemoriesChanged;
  }

  const beforeRevision = record.revision;
  const versionRevision = beforeRevision + 1;
  const snapshot = normalizeTripSnapshot({ ...current.snapshot, version: versionRevision });
  const version = {
    tripId: record.tripId,
    revision: versionRevision,
    snapshot,
    reason: 'expired-day-cleanup',
    createdAt: now,
    beforeRevision,
    afterRevision: versionRevision,
    action: 'trip.expire-day',
  };
  const mutation = {
    mutationId: id('mutation'),
    tripId: record.tripId,
    actorId: record.ownerId,
    action: 'trip.expire-day',
    beforeRevision,
    afterRevision: versionRevision,
    reversesId: null,
    createdAt: now,
  };
  record.versions = history.map(item => item.version);
  commitPlanSnapshot(state, record, version, mutation);
  if (current.changed) {
    record.contentRevision += 1;
    if (record.memories) record.memories.contentRevision = record.contentRevision;
  }
  state.authorization.invalidateScope({ tripId: record.tripId, now });
  return true;
}

/** 取出属于该主体、且未被删除的旅行记录。 */
export function ownedTrip(
  state: TripState,
  actorId: string,
  tripId: string,
  options: { skipMaintenance?: boolean } = {},
): ServiceResult<TripRecord> {
  const trip = state.trips.get(tripId);
  if (!trip || trip.deletedAt || trip.ownerId !== actorId) {
    return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '旅行不存在。') };
  }
  if (!options.skipMaintenance) purgePastProgress(state, trip);
  return { ok: true, value: trip };
}

/**
 * 组装对外视图。
 *
 * 快照会先过一遍 normalize：历史记录里可能缺字段，直接回传会让前端拿到半成品。
 * 待处理许可从授权服务实时取，不缓存——否则用户批准后视图仍是旧的。
 */
export function toView(state: TripState, record: TripRecord): TripView {
  const snapshot = structuredClone(normalizeTripSnapshot(record.snapshot));
  return {
    trip: {
      tripId: record.tripId,
      dataMode: record.dataMode,
      lifecycle: record.lifecycle,
      planningStatus: snapshot.planningStatus,
      revision: record.revision,
      contentRevision: record.contentRevision,
      timezone: record.timezone,
      localDate: record.localDate,
      cityCode: record.cityCode,
      latestContextId: record.latestContextId,
      deletedAt: record.deletedAt,
    },
    snapshot,
    clock: tripClock(snapshot, state.now()),
    versionCount: record.versions.length,
    previousPlanRevision: record.versions
      .filter((version) => ['trip.patch', 'plan.apply', 'plan.undo'].includes(version.action || version.reason))
      .slice(0, -1).reverse().find((version) => version.snapshot.stops?.length)?.revision ?? null,
    latestProposalId: [...record.proposals.values()].reverse().find((proposal) =>
      proposal.status === 'ready' && proposal.baseRevision === record.revision &&
      (!proposal.contextSnapshotId || proposal.contextSnapshotId === record.latestContextId) &&
      Date.parse(proposal.expiresAt) > Date.parse(state.now())
    )?.proposalId ?? null,
    pendingActionRequests: state.authorization
      .listRequests()
      .filter(
        (request) =>
          request.tripId === record.tripId &&
          (request.status === 'pending' || request.status === 'approved'),
      )
      .map((request) => ({
        actionRequestId: request.actionRequestId,
        summary: request.summary,
        status: request.status,
        expiresAt: request.expiresAt,
      })),
  };
}
