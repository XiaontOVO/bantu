/**
 * 旅行的整体操作：删除与克隆。
 *
 * 两者的共同点是"影响整趟旅行"，因此都要先作废该旅行名下的一次性许可——
 * 否则旧许可可能在新计划上被消费，越过用户当时的确认。
 */
import { normalizeTripSnapshot } from '../../domain/normalize.js';
import { createInitialVersion } from '../../domain/versioning.js';
import { ownedTrip, toView } from './access.js';
import { createTrip } from './trips.js';
import { serviceError } from './helpers.js';
import type { ServiceResult, TripView } from './contracts.js';
import type { TripState } from './state.js';

/** 软删除：保留记录以便回溯，但归属校验会拒绝后续访问。 */
export function deleteTrip(
  state: TripState,
  actorId: string,
  tripId: string,
): ServiceResult<true> {
  // Deletion must not run expiry maintenance first: that could archive old
  // unexecuted stops into the reusable plan library as a side effect.
  const tripResult = ownedTrip(state, actorId, tripId, { skipMaintenance: true });
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  record.deletedAt = state.now();
  record.updatedAt = record.deletedAt;
  state.authorization.invalidateScope({ tripId, now: record.deletedAt });
  state.trips.set(tripId, record);
  return { ok: true, value: true };
}

/**
 * 克隆：复制行程形状，但**清空执行事实**。
 * 复制一趟"已经走过"的记录会伪造历史，所以进度、花费、步行与位置引用一律归零。
 */
export function cloneTrip(
  state: TripState,
  actorId: string,
  tripId: string,
): ServiceResult<TripView> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const source = tripResult.value;
  const created = createTrip(state, actorId, {
    cityCode: source.cityCode,
    localDate: source.localDate,
    timezone: source.timezone,
    dataMode: source.dataMode,
    partySize: source.snapshot.tripSettings?.partySize ?? 1,
    budgetMinor: source.snapshot.budget?.limitMinor ?? null,
    budgetStrength: source.snapshot.budget?.strength ?? 'hard',
  });
  if (!created.ok) return created;
  const target = state.trips.get(created.value.trip.tripId);
  if (!target) {
    return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '克隆目标不存在。') };
  }
  // 为新行程重新分配内部 ID，并同步改写所有路线、约束和费用引用。
  const sourceStops = source.snapshot.stops ?? [];
  const stopIds = new Map(sourceStops.map((stop, index) => [stop.stopId, `clone_stop_${index + 1}`]));
  const sourceLegs = source.snapshot.routeLegs ?? [];
  const legIds = new Map(sourceLegs.map((leg, index) => [leg.legId, `clone_route_${index + 1}`]));
  const sourceCharges = source.snapshot.plannedCharges ?? [];
  const chargeIds = new Map(sourceCharges.map((charge, index) => [charge.chargeId, `clone_charge_${index + 1}`]));
  const remapReference = (value: string) => stopIds.get(value) ?? legIds.get(value) ?? chargeIds.get(value) ?? value;
  const remappedStops = sourceStops.map((stop, index) => {
    const { baseRevision: _baseRevision, ...rest } = stop;
    return { ...rest, stopId: stopIds.get(stop.stopId) ?? `clone_stop_${index + 1}`, status: 'planned' as const };
  });
  const remappedRouteLegs = sourceLegs.map((leg, index) => ({
    ...leg,
    legId: legIds.get(leg.legId) ?? `clone_route_${index + 1}`,
    fromStopId: remapReference(leg.fromStopId),
    toStopId: remapReference(leg.toStopId),
  }));
  const remappedConstraints = (source.snapshot.constraints ?? []).map(constraint => {
    const payload = { ...constraint.payload } as Record<string, unknown>;
    for (const key of ['stopId', 'memberId']) {
      if (typeof payload[key] === 'string') payload[key] = remapReference(payload[key] as string);
    }
    if (Array.isArray(payload.scopeStopIds)) payload.scopeStopIds = payload.scopeStopIds.map(value =>
      typeof value === 'string' ? remapReference(value) : value,
    );
    if (Array.isArray(payload.includedChargeIds)) payload.includedChargeIds = payload.includedChargeIds.map(value =>
      typeof value === 'string' ? remapReference(value) : value,
    );
    return {
      ...constraint,
      ...(constraint.subjectId ? { subjectId: remapReference(constraint.subjectId) } : {}),
      ...(constraint.memberIds ? { memberIds: constraint.memberIds.map(remapReference) } : {}),
      payload,
    } as typeof constraint;
  });
  const remappedCharges = sourceCharges.map((charge, index) => ({
    ...charge,
    chargeId: chargeIds.get(charge.chargeId) ?? `clone_charge_${index + 1}`,
    ...(charge.stopId ? { stopId: remapReference(charge.stopId) } : {}),
    ...(charge.routeLegRef ? { routeLegRef: remapReference(charge.routeLegRef) } : {}),
    paymentStatus: 'unpaid' as const,
    includedSpendEventId: null,
  }));
  const nextSnapshot = normalizeTripSnapshot({
    ...source.snapshot,
    tripId: target.tripId,
    version: 0,
    lifecycle: 'draft',
    stops: remappedStops,
    routeLegs: remappedRouteLegs,
    constraints: remappedConstraints,
    plannedCharges: remappedCharges,
    executionEvents: [],
    spendEvents: [],
    walkingEvents: [],
    actualSpendMinor: null,
    actualSpendComplete: false,
    actualWalkingMeters: null,
    actualWalkingComplete: false,
    planningStatus: remappedStops.length > 0 ? 'needs_review' : 'empty',
    contextSnapshotId: null,
  });
  target.snapshot = nextSnapshot;
  target.versions = [createInitialVersion(target.tripId, nextSnapshot, state.now(), 'clone')];
  state.trips.set(target.tripId, target);
  return { ok: true, value: toView(state, target) };
}
