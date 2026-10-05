const PREF_PREFIX = 'bantu.scene.auto.v1:';
const DEPARTURE_PREF_PREFIX = 'bantu.scene.departure.v1:';
export const SCENE_FIX_MAX_ACCURACY_METERS = 50;
export const SCENE_DWELL_MS = 20_000;
export const SCENE_DEPARTURE_DWELL_MS = 30_000;
export const SCENE_DEPARTURE_MARGIN_METERS = 40;

export function sceneArrivalPreference(principalId) {
  if (!principalId) return 'off';
  try { return localStorage.getItem(`${PREF_PREFIX}${principalId}`) === 'on' ? 'on' : 'off'; }
  catch { return 'off'; }
}

export function setSceneArrivalPreference(principalId, enabled) {
  if (!principalId) return false;
  try { localStorage.setItem(`${PREF_PREFIX}${principalId}`, enabled ? 'on' : 'off'); return true; }
  catch { return false; }
}

export function sceneDeparturePreference(principalId) {
  if (!principalId) return 'off';
  try { return localStorage.getItem(`${DEPARTURE_PREF_PREFIX}${principalId}`) === 'on' ? 'on' : 'off'; }
  catch { return 'off'; }
}

export function setSceneDeparturePreference(principalId, enabled) {
  if (!principalId) return false;
  try { localStorage.setItem(`${DEPARTURE_PREF_PREFIX}${principalId}`, enabled ? 'on' : 'off'); return true; }
  catch { return false; }
}

export function distanceMeters(a, b) {
  const toRadians = value => value * Math.PI / 180;
  const lat1 = toRadians(a.lat), lat2 = toRadians(b.lat);
  const dLat = lat2 - lat1, dLng = toRadians(b.lng - a.lng);
  const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

/** Two fresh, precise fixes separated by a dwell window; a single GPS jump cannot open the scene. */
export function advanceSceneArrival(previous, fix, zone, nowMs = Date.now()) {
  const reset = { firstAt: 0, lastAt: 0, fixAt: 0, samples: 0, arrived: false };
  if (!fix || !zone || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) ||
      !Number.isFinite(fix.accuracyMeters) || fix.accuracyMeters <= 0 || fix.accuracyMeters > SCENE_FIX_MAX_ACCURACY_METERS ||
      !Number.isFinite(fix.measuredAt) || Math.abs(nowMs - fix.measuredAt) > 60_000 ||
      distanceMeters(fix, zone) > zone.radiusMeters) return reset;
  if (!previous?.firstAt || nowMs - previous.lastAt > 45_000 || nowMs < previous.lastAt) {
    return { firstAt: nowMs, lastAt: nowMs, fixAt: fix.measuredAt, samples: 1, arrived: false };
  }
  if (fix.measuredAt <= previous.fixAt) return previous;
  const samples = previous.samples + 1;
  return { firstAt: previous.firstAt, lastAt: nowMs, fixAt: fix.measuredAt, samples,
    arrived: samples >= 2 && nowMs - previous.firstAt >= SCENE_DWELL_MS };
}

/** Arm only after a stable inside fix; require two clearly outside fixes before a suggestion. */
export function advanceSceneDeparture(previous, fix, zone, nowMs = Date.now()) {
  const blank = { inside: null, armed: false, outsideFirstAt: 0, outsideLastAt: 0, outsideFixAt: 0, outsideSamples: 0, departed: false };
  if (!zone) return blank;
  const valid = fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng) &&
    Number.isFinite(fix.accuracyMeters) && fix.accuracyMeters > 0 && fix.accuracyMeters <= 35 &&
    Number.isFinite(fix.measuredAt) && Math.abs(nowMs - fix.measuredAt) <= 60_000;
  if (!valid) return previous?.armed ? { ...previous, outsideFirstAt: 0, outsideLastAt: 0, outsideFixAt: 0, outsideSamples: 0, departed: false } : blank;
  if (!previous?.armed) {
    const inside = advanceSceneArrival(previous?.inside, fix, zone, nowMs);
    return { ...blank, inside, armed: inside.arrived };
  }
  if (previous.departed) return previous;
  const clearlyOutside = distanceMeters(fix, zone) > zone.radiusMeters + fix.accuracyMeters + SCENE_DEPARTURE_MARGIN_METERS;
  if (!clearlyOutside) return { ...previous, outsideFirstAt: 0, outsideLastAt: 0, outsideFixAt: 0, outsideSamples: 0 };
  if (!previous.outsideFirstAt || nowMs - previous.outsideLastAt > 60_000 || nowMs < previous.outsideLastAt) {
    return { ...previous, outsideFirstAt: nowMs, outsideLastAt: nowMs, outsideFixAt: fix.measuredAt, outsideSamples: 1 };
  }
  if (fix.measuredAt <= previous.outsideFixAt) return previous;
  const outsideSamples = previous.outsideSamples + 1;
  return { ...previous, outsideLastAt: nowMs, outsideFixAt: fix.measuredAt, outsideSamples,
    departed: outsideSamples >= 2 && nowMs - previous.outsideFirstAt >= SCENE_DEPARTURE_DWELL_MS };
}
