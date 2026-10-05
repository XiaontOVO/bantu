/** Build a conflict-free local schedule for decoded, coordinate-backed plan stops. */
export function buildImportedStops(stops, makeStopIds, dayIndex, fallbackCityCode = '') {
  let startMinutes = 9 * 60;
  return (stops || []).map((stop, index) => {
    if (Number.isInteger(stop.startMinutes) && stop.startMinutes >= 0) startMinutes = stop.startMinutes;
    const duration = Math.max(15, Number(stop.durationMinutes) || 60);
    const ids = makeStopIds(index, dayIndex);
    // Keep the canonical directory identity when the share carries it. Only
    // older plan codes without an identity need an isolated fallback ID.
    const placeId = typeof stop.placeId === 'string' && stop.placeId.trim()
      ? stop.placeId.trim()
      : ids.placeId;
    const imported = {
      stopId: ids.stopId,
      placeId,
      place: {
        placeId,
        name: stop.name,
        coordinates: stop.coordinates,
        ...( /^\d{6}$/.test(String(stop.cityCode || fallbackCityCode || '')) && (stop.cityCode || fallbackCityCode) !== '000000' ? { cityCode: stop.cityCode || fallbackCityCode } : {}),
        facilityCodes: [],
        evidenceIds: [],
      },
      plannedArrivalMinutes: startMinutes,
      startMinutes,
      endMinutes: startMinutes + duration,
      departureMinutes: startMinutes + duration,
      minDurationMinutes: duration,
      plannedDurationMinutes: duration,
      status: 'planned',
    };
    startMinutes += duration + 30;
    return imported;
  });
}

/** Preserve blank days and reset the schedule to 09:00 at the start of each day. */
export function buildImportedSchemeDays(days, makeStopIds, fallbackCityCode = '') {
  return (days || []).map((day, dayIndex) => ({
    dayIndex,
    stops: buildImportedStops(day.stops, makeStopIds, dayIndex, fallbackCityCode),
    routeLegs: [],
  }));
}
