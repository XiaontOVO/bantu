import type { PlanStop, TripSnapshot } from '../src/domain/types.js';

export function makeSnapshot(overrides: Partial<TripSnapshot> = {}): TripSnapshot {
  return {
    tripId: 'trip_1',
    dataMode: 'demo',
    lifecycle: 'draft',
    planningStatus: 'empty',
    timezone: 'Asia/Shanghai',
    travelDate: '2026-09-20',
    dayStartMinutes: 9 * 60,
    stops: [],
    routeLegs: [],
    version: 0,
    contextSnapshotId: null,
    ...overrides,
  };
}

export function makeStop(overrides: Partial<PlanStop> & { stopId: string }): PlanStop {
  const startMinutes = overrides.startMinutes ?? overrides.plannedStartMinutes ?? 9 * 60;
  const durationMinutes =
    overrides.plannedDurationMinutes ??
    overrides.minDurationMinutes ??
    (overrides.durationSeconds === undefined ? 30 : overrides.durationSeconds / 60);
  const endMinutes = overrides.endMinutes ?? startMinutes + durationMinutes;
  const filled: PlanStop = {
    placeId: overrides.placeId ?? overrides.place?.placeId ?? overrides.stopId,
    place: overrides.place ?? {
      placeId: overrides.placeId ?? overrides.stopId,
      name: overrides.placeId ?? overrides.stopId,
      coordinates: null,
      facilityCodes: [],
    },
    plannedArrivalMinutes: overrides.plannedArrivalMinutes ?? startMinutes,
    startMinutes,
    plannedStartMinutes: startMinutes,
    endMinutes,
    departureMinutes: overrides.departureMinutes ?? endMinutes,
    plannedDepartureMinutes: overrides.departureMinutes ?? endMinutes,
    minDurationMinutes: overrides.minDurationMinutes ?? durationMinutes,
    plannedDurationMinutes: overrides.plannedDurationMinutes ?? durationMinutes,
    status: overrides.status ?? 'planned',
    ...overrides,
    stopId: overrides.stopId,
  };
  return filled;
}

