/** Shared by the scheme editor and server. Times are relative to a day's midnight. */
const DAY = 1440;
const startOf = stop => [stop?.startMinutes, stop?.plannedStartMinutes, stop?.plannedArrivalMinutes,
  stop?.plannedDepartureMinutes, stop?.departureMinutes].find(Number.isFinite);
const endOf = stop => Number.isFinite(stop?.endMinutes) ? stop.endMinutes : startOf(stop) +
  ([stop?.plannedDurationMinutes, stop?.minDurationMinutes,
    Number.isFinite(stop?.durationSeconds) ? stop.durationSeconds / 60 : undefined,
    Number.isFinite(stop?.minDurationSeconds) ? stop.minDurationSeconds / 60 : undefined].find(Number.isFinite) ?? 0);
const timeKeys = ['startMinutes', 'plannedStartMinutes', 'plannedArrivalMinutes', 'endMinutes',
  'departureMinutes', 'plannedDepartureMinutes', 'travelStartMinutes', 'plannedTravelStartMinutes',
  'forecastStartMinutes', 'forecastEndMinutes', 'actualArrivalMinutes', 'actualCompletionMinutes'];
const refsOf = stop => [stop?.stopId, stop?.placeId, stop?.place?.placeId].filter(Boolean);

function shiftStop(stop, offset) {
  if (!offset) return stop;
  const copy = { ...stop };
  for (const key of timeKeys) if (Number.isFinite(copy[key])) copy[key] -= offset;
  // Visit windows belong to this scheduled visit; opening hours stay local clock times.
  if (copy.visitWindow) {
    copy.visitWindow = { ...copy.visitWindow };
    for (const key of ['startMinutes', 'endMinutes']) {
      if (Number.isFinite(copy.visitWindow[key])) copy.visitWindow[key] -= offset;
    }
  }
  return copy;
}

/**
 * Preserve absolute visit times and identities, moving only visits starting on a later day.
 * A visit ending after midnight stays whole; the next day's continuation is derived below.
 * Input is never mutated. An unchanged array is returned as-is.
 * @template {{dayIndex?: number, stops: any[], routeLegs?: any[], plannedCharges?: any[]}} T
 * @param {T[]} days
 * @returns {T[]}
 */
export function normalizeSchemeDays(days) {
  let length = days.length;
  let changed = false;
  const assignments = days.map((day, index) => day.stops.map(stop => {
    const start = startOf(stop), end = endOf(stop);
    const offset = Number.isFinite(start) && start >= DAY ? Math.floor(start / DAY) : 0;
    const target = index + offset;
    // Intervals are half-open: ending exactly at 24:00 does not occupy the next day.
    const last = stop?.status !== 'skipped' && Number.isFinite(end) && end > start
      ? index + Math.ceil(end / DAY) - 1 : target;
    length = Math.max(length, target + 1, last + 1);
    if (offset || day.dayIndex !== index) changed = true;
    return { stop, target, offset: offset * DAY };
  }));
  if (length > Math.max(366, days.length)) throw new Error('跨日安排超过方案可用的天数，请调整时间（最多 366 天）。');
  if (!changed && length === days.length) return days;
  const output = Array.from({ length }, (_, index) => ({
    ...(days[index] || {}), dayIndex: index, stops: [], routeLegs: [], plannedCharges: [],
  }));
  assignments.forEach((visits, index) => {
    const destinations = new Map();
    for (const visit of visits) {
      output[visit.target].stops.push(shiftStop(visit.stop, visit.offset));
      for (const ref of refsOf(visit.stop)) {
        const targets = destinations.get(ref) || new Set();
        targets.add(visit.target); destinations.set(ref, targets);
      }
    }
    // Legacy place aliases are usable only when they resolve to one destination day.
    const destinationOf = ref => destinations.get(ref)?.size === 1 ? [...destinations.get(ref)][0] : undefined;
    const routeDestinations = new Map();
    for (const route of days[index].routeLegs || []) {
      const to = destinationOf(route?.toStopId);
      const from = ['origin', 'my-location'].includes(route?.fromStopId) ? index : destinationOf(route?.fromStopId);
      if (to !== undefined && to === from) {
        output[to].routeLegs.push(route); routeDestinations.set(route.legId, to);
      }
    }
    for (const charge of days[index].plannedCharges || []) {
      const stopDay = charge.stopId === undefined ? undefined : destinationOf(charge.stopId);
      const routeDay = charge.routeLegRef === undefined ? undefined : routeDestinations.get(charge.routeLegRef);
      const invalid = (charge.stopId !== undefined && stopDay === undefined) ||
        (charge.routeLegRef !== undefined && routeDay === undefined) ||
        (stopDay !== undefined && routeDay !== undefined && stopDay !== routeDay);
      if (invalid) {
        if (charge.paymentStatus === 'paid' || charge.status === 'paid') throw new Error('跨日调整影响已支付的交通费用，请先核对费用关联。');
        continue;
      }
      output[routeDay ?? stopDay ?? index].plannedCharges.push(charge);
    }
  });
  for (const day of output) day.stops.sort((a, b) => (startOf(a) ?? Infinity) - (startOf(b) ?? Infinity));
  return /** @type {T[]} */ (output);
}

/** Read-only continuation rows: never saved as another stop or execution event. */
export function schemeDayContinuations(days, dayIndex) {
  return days.flatMap((day, index) => {
    if (index >= dayIndex) return [];
    const offset = (dayIndex - index) * DAY;
    return day.stops.flatMap(stop => {
      const start = startOf(stop), end = endOf(stop);
      if (stop?.status === 'skipped' || !Number.isFinite(start) || !Number.isFinite(end) || start >= offset || end <= offset) return [];
      return [{ stop, sourceDay: index, startMinutes: 0, endMinutes: Math.min(DAY, end - offset) }];
    });
  });
}

/** Keep existing day objects alive while route requests settle; daily plans use T7 instead. */
export function normalizeSchemeDraft(draft, followStopId) {
  if (!draft || draft.planKind === 'plan' || draft.dailyPlanDate) return false;
  const previous = draft.days;
  const normalized = normalizeSchemeDays(previous);
  if (normalized === previous) return false;
  draft.days = normalized.map((day, index) => previous[index] ? Object.assign(previous[index], day) : day);
  if (followStopId) {
    const index = draft.days.findIndex(day => day.stops.some(stop => stop.stopId === followStopId));
    if (index >= 0) draft.activeDay = index;
  }
  if (normalized.length > previous.length) {
    draft.saveNotice = `跨日安排已自动补齐到第 ${normalized.length} 天，地点和游览时长已保留。`;
  }
  return true;
}
