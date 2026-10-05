import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStopDuration, getStopEnd, normalizePlanStop, normalizeTripSnapshot } from '../src/domain/normalize.js';

test('normalization accepts docs-style aliases and minimal stops without recursion', () => {
  const stop = normalizePlanStop({
    stopId: 's1',
    placeId: 'P1',
    plannedArrivalMinutes: 540,
    plannedStartMinutes: 550,
    plannedDepartureMinutes: 610,
    durationSeconds: 3600,
    timeLocked: true,
  });
  assert.equal(stop.place?.placeId, 'P1');
  assert.equal(stop.startMinutes, 550);
  assert.equal(stop.endMinutes, 610);
  assert.equal(stop.departureMinutes, 610);
  assert.equal(stop.durationSeconds, 3600);
  assert.equal(stop.timeLocked, true);

  const minimal = normalizePlanStop({ stopId: 's2' });
  assert.equal(getStopEnd(minimal), 0);
  assert.equal(getStopDuration(minimal), 0);

  const arrivalOnly = normalizePlanStop({ stopId: 's3', plannedArrivalMinutes: 1410, plannedDurationMinutes: 90 });
  assert.equal(arrivalOnly.startMinutes, 1410, 'a legacy arrival-only time becomes the interval start when no activity start is supplied');
  assert.equal(arrivalOnly.endMinutes, 1500);
});

test('normalization preserves execution and spend facts for later constraints', () => {
  const snapshot = normalizeTripSnapshot({
    tripId: 'trip_1',
    executionEvents: [],
    spendEvents: [
      {
        spendEventId: 's1',
        tripId: 'trip_1',
        amountMinor: 8000,
        currency: 'CNY',
        basis: 'party',
        occurredAt: '2026-09-20T13:00:00+08:00',
        recordedAt: '2026-09-20T13:00:00+08:00',
        completenessConfirmed: true,
        includedChargeIds: ['c1'],
      },
    ],
  });
  assert.equal(snapshot.spendEvents?.length, 1);
  assert.equal(snapshot.executionEvents?.length, 0);
});
