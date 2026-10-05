import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDemoPlanSnapshot,
  buildDelayReplanSnapshot,
  buildEventReplanSnapshot,
  buildRainReplanSnapshot,
  buildRestReplanSnapshot,
} from '../src/demo/demo-data.js';
import { DEMO_PLACE_IDS } from '../src/demo/demo-data.js';
import { makeSnapshot } from './helpers.js';

const base = makeSnapshot({
  tripId: 'trip_1',
  dayStartMinutes: 9 * 60,
  dayEndMinutes: 21 * 60,
});

test('rest event inserts a rest stop with rest facilities between existing stops', () => {
  const candidate = buildRestReplanSnapshot(base);
  const rest = candidate.stops?.find((stop) => stop.stopId === DEMO_PLACE_IDS.xujiahuiPark);
  assert.ok(rest);
  assert.ok(rest.place?.facilityCodes.includes('rest_area'));
});

test('rain event replaces the outdoor first stop with an indoor stop', () => {
  const candidate = buildRainReplanSnapshot(base);
  const names = candidate.stops?.map((stop) => stop.stopId) ?? [];
  assert.equal(names[0], DEMO_PLACE_IDS.xujiahuiLibrary);
  assert.equal(names.includes(DEMO_PLACE_IDS.wukang), false);
});

test('delay event shifts departure without silently moving later fixed stops', () => {
  const normal = buildEventReplanSnapshot(base, { type: 'rest_requested' });
  const delayed = buildDelayReplanSnapshot(base, 30);
  assert.ok(
    (delayed.stops?.[0]?.plannedArrivalMinutes ?? 0) >=
      (normal.stops?.[0]?.plannedArrivalMinutes ?? 0) + 30,
  );
});

test('event dispatcher chooses rest, rain and delay candidates by explicit type', () => {
  assert.ok(buildEventReplanSnapshot(base, { type: 'rain_reported' }).stops?.some((stop) => stop.stopId === DEMO_PLACE_IDS.xujiahuiLibrary));
  assert.equal(
    buildEventReplanSnapshot(base, { type: 'delay_reported', delayMinutes: 20 }).stops?.[0]?.stopId,
    DEMO_PLACE_IDS.wukang,
  );
  assert.ok(
    buildEventReplanSnapshot(base, { type: 'rest_requested' }).stops?.some(
      (stop) => stop.stopId === DEMO_PLACE_IDS.xujiahuiPark,
    ),
  );
});

test('initial demo plans keep planned stops after 21:00', () => {
  const candidate = buildDemoPlanSnapshot({
    tripId: 'late-trip',
    dataMode: 'demo',
    timezone: 'Asia/Shanghai',
    travelDate: '2026-09-20',
    dayStartMinutes: 17 * 60,
    partySize: 2,
  });

  assert.equal(candidate.stops?.length, 4);
  assert.ok(candidate.stops?.some((stop) => stop.endMinutes! > 21 * 60));
});
