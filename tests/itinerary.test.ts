import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propagateSchedule } from '../src/domain/itinerary.js';

test('propagateSchedule calculates times from origin to final stop', () => {
  const result = propagateSchedule({
    departureMinutes: 13 * 60,
    segments: [
      {
        stopId: 'p',
        placeId: 'P',
        durationMinutes: 40,
        minDurationMinutes: 30,
      },
      {
        stopId: 'v',
        placeId: 'V',
        durationMinutes: 60,
        minDurationMinutes: 60,
        openingIntervals: [{ startMinutes: 14 * 60, endMinutes: 17 * 60 }],
      },
    ],
    routes: [
      {
        legId: 'o-p',
        fromStopId: 'origin',
        toStopId: 'p',
        transportMode: 'walking',
        durationMinutes: 15,
        bufferMinutes: 5,
      },
      {
        legId: 'p-v',
        fromStopId: 'p',
        toStopId: 'v',
        transportMode: 'walking',
        durationMinutes: 20,
        bufferMinutes: 5,
      },
    ],
  });

  assert.equal(result.warnings.length, 0);
  const p = result.stops.find((s) => s.stopId === 'p');
  assert.ok(p);
  assert.equal(p.startMinutes, 13 * 60 + 20);
  assert.equal(p.endMinutes, 14 * 60);
  assert.equal(p.departureMinutes, 14 * 60);
  assert.equal(p.plannedArrivalMinutes, 13 * 60 + 20);

  const v = result.stops.find((s) => s.stopId === 'v');
  assert.ok(v);
  assert.equal(v.plannedArrivalMinutes, 14 * 60 + 25);
  assert.equal(v.startMinutes, 14 * 60 + 25);
  assert.equal(v.endMinutes, 15 * 60 + 25);
  assert.equal(v.departureMinutes, 15 * 60 + 25);
});

test('propagateSchedule warns for missing route when more than one stop remains', () => {
  const result = propagateSchedule({
    departureMinutes: 0,
    segments: [
      { stopId: 'a', placeId: 'A', durationMinutes: 30 },
      { stopId: 'b', placeId: 'B', durationMinutes: 30 },
    ],
    routes: [],
  });
  assert.ok(result.warnings.some((w) => w.includes('missing route')));
});

test('propagateSchedule keeps a valid late-evening visit without a daily cutoff warning', () => {
  const result = propagateSchedule({
    departureMinutes: 22 * 60,
    segments: [{ stopId: 'late', placeId: 'Late place', durationMinutes: 45 }],
    routes: [],
  });

  assert.equal(result.stops[0].startMinutes, 22 * 60);
  assert.equal(result.stops[0].endMinutes, 22 * 60 + 45);
  assert.deepEqual(result.warnings, []);
});
