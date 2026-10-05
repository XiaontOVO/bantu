import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConstraint, evaluateSnapshot } from '../src/domain/constraints.js';
import { makeSnapshot, makeStop } from './helpers.js';
import type { Constraint } from '../src/domain/types.js';

function constraint<T extends Constraint>(value: T): T {
  return value;
}

test('visit_window passes when arrival exactly equals latest arrival', () => {
  const snapshot = makeSnapshot({
    stops: [
      makeStop({
        stopId: 'v',
        startMinutes: 14 * 60 + 30,
        plannedArrivalMinutes: 14 * 60 + 30,
        plannedDurationMinutes: 30,
      }),
    ],
  });
  const check = checkConstraint(
    constraint({
      constraintId: 'v',
      kind: 'visit_window',
      strength: 'hard',
      payload: { stopId: 'v', latestArrivalMinutes: 14 * 60 + 30 },
    }),
    snapshot,
  );
  assert.equal(check.status, 'pass');
});

test('visit_window allows departure exactly at closing and rejects crossing closure', () => {
  const closing = makeSnapshot({
    stops: [
      makeStop({
        stopId: 'v',
        startMinutes: 16 * 60 + 30,
        endMinutes: 17 * 60,
        openingIntervals: [{ startMinutes: 14 * 60, endMinutes: 17 * 60 }],
      }),
    ],
  });
  const pass = checkConstraint(
    constraint({
      constraintId: 'v',
      kind: 'visit_window',
      strength: 'hard',
      payload: { stopId: 'v' },
    }),
    closing,
  );
  assert.equal(pass.status, 'pass');

  const crossing = makeSnapshot({
    stops: [
      makeStop({
        stopId: 'v',
        startMinutes: 16 * 60 + 40,
        endMinutes: 17 * 60 + 10,
        openingIntervals: [{ startMinutes: 14 * 60, endMinutes: 17 * 60 }],
      }),
    ],
  });
  const fail = checkConstraint(
    constraint({
      constraintId: 'v',
      kind: 'visit_window',
      strength: 'hard',
      payload: { stopId: 'v' },
    }),
    crossing,
  );
  assert.equal(fail.status, 'fail');
  assert.equal(fail.reasonCode, 'outside_opening_hours');
});

test('lock_time fails when the time window is silently changed', () => {
  const snapshot = makeSnapshot({
    stops: [
      makeStop({
        stopId: 'v',
        startMinutes: 15 * 60,
        endMinutes: 16 * 60,
        timeLocked: true,
      }),
    ],
  });
  const check = checkConstraint(
    constraint({
      constraintId: 'lock:v',
      kind: 'lock_time',
      strength: 'hard',
      payload: { stopId: 'v', startMinutes: 14 * 60, endMinutes: 15 * 60 },
    }),
    snapshot,
  );
  assert.equal(check.status, 'fail');
  assert.equal(check.reasonCode, 'time_window_changed');
});

test('retain_stop reports a distinct reason when the flag was cleared', () => {
  const snapshot = makeSnapshot({
    stops: [makeStop({ stopId: 'v', retain: false })],
  });
  const check = checkConstraint(
    constraint({
      constraintId: 'retain:v',
      kind: 'retain_stop',
      strength: 'hard',
      payload: { stopId: 'v' },
    }),
    snapshot,
  );
  assert.equal(check.status, 'fail');
  assert.equal(check.reasonCode, 'retain_flag_cleared');
});

test('facility_required distinguishes no evidence from confirmed absence', () => {
  const noEvidence = checkConstraint(
    constraint({
      constraintId: 'facility:v',
      kind: 'facility_required',
      strength: 'hard',
      payload: { stopId: 'v', facilityCode: 'rest_area' },
    }),
    makeSnapshot({ stops: [makeStop({ stopId: 'v' })] }),
  );
  assert.equal(noEvidence.status, 'unknown');

  const confirmedAbsent = checkConstraint(
    constraint({
      constraintId: 'facility:v',
      kind: 'facility_required',
      strength: 'hard',
      payload: { stopId: 'v', facilityCode: 'rest_area' },
    }),
    makeSnapshot({
      stops: [
        makeStop({
          stopId: 'v',
          evidenceRefs: ['evidence_1'],
          place: {
            placeId: 'v',
            name: 'V',
            coordinates: null,
            facilityCodes: ['food'],
          },
        }),
      ],
    }),
  );
  assert.equal(confirmedAbsent.status, 'fail');
  assert.equal(confirmedAbsent.reasonCode, 'facility_missing');
});

test('walking_limit checks each leg and reports over-limit route', () => {
  const snapshot = makeSnapshot({
    routeLegs: [
      {
        legId: 'a-b',
        fromStopId: 'a',
        toStopId: 'b',
        transportMode: 'walking',
        durationMinutes: 10,
        walkingMeters: 800,
        distanceMeters: 800,
        bufferMinutes: 0,
      },
    ],
  });
  const check = checkConstraint(
    constraint({
      constraintId: 'walk:leg',
      kind: 'walking_limit',
      strength: 'hard',
      payload: { scope: 'leg', maxWalkingMeters: 500 },
    }),
    snapshot,
  );
  assert.equal(check.status, 'fail');
  assert.equal(check.reasonCode, 'walking_leg_limit_exceeded');
});

test('hard day walking limit requires complete actual cumulative walking', () => {
  const routeLegs = [
    {
      legId: 'a-b',
      fromStopId: 'a',
      toStopId: 'b',
      transportMode: 'walking' as const,
      durationMinutes: 5,
      walkingMeters: 400,
      distanceMeters: 400,
      bufferMinutes: 0,
    },
  ];
  const constraintValue = constraint({
    constraintId: 'walk:day',
    kind: 'walking_limit' as const,
    strength: 'hard' as const,
    payload: { scope: 'day' as const, maxWalkingMeters: 500 },
  });
  assert.equal(
    checkConstraint(constraintValue, makeSnapshot({ routeLegs })).status,
    'unknown',
  );
  assert.equal(
    checkConstraint(
      constraintValue,
      makeSnapshot({
        routeLegs,
        actualWalkingMeters: 200,
        actualWalkingComplete: true,
      }),
    ).status,
    'fail',
  );
  assert.equal(
    checkConstraint(
      constraintValue,
      makeSnapshot({
        routeLegs,
        actualWalkingMeters: 50,
        actualWalkingComplete: true,
      }),
    ).status,
    'pass',
  );
});

test('budget_limit passes known complete spend and fails when upper bound exceeds limit', () => {
  const base = makeSnapshot({
    budget: { currency: 'CNY', limitMinor: 10000, strength: 'hard', scope: 'trip' },
    plannedCharges: [
      {
        chargeId: 'c1',
        quantity: 1,
        costEstimate: {
          currency: 'CNY',
          basis: 'party',
          lowerMinor: 3000,
          upperMinor: 3000,
          certainty: 'known',
        },
        paymentStatus: 'unpaid',
      },
    ],
    actualSpendMinor: 2000,
    actualSpendComplete: true,
    spendRef: 'spend_1',
  });
  const constraintValue = constraint({
    constraintId: 'budget:1',
    kind: 'budget_limit' as const,
    strength: 'hard' as const,
    payload: { scope: 'trip' as const, currency: 'CNY', limitMinor: 6000 },
  });
  assert.equal(checkConstraint(constraintValue, base).status, 'pass');
  assert.equal(
    checkConstraint(
      { ...constraintValue, payload: { ...constraintValue.payload, limitMinor: 4000 } },
      base,
    ).status,
    'fail',
  );
});

test('soft preference conflicts do not make a plan needs_review by themselves', () => {
  const snapshot = makeSnapshot({
    stops: [makeStop({ stopId: 'v' })],
    partyNeeds: { m1: { pace: 'slow' } },
  });
  const summary = evaluateSnapshot(snapshot, [
    constraint({
      constraintId: 'pref:pace',
      kind: 'preference',
      strength: 'soft',
      payload: { key: 'pace', value: 'fast' },
    }),
  ]);
  assert.equal(summary.planningStatus, 'validated');
  assert.equal(summary.checks[0].status, 'fail');
});

test('a snapshot with no hard constraints validates once it has stops', () => {
  const summary = evaluateSnapshot(makeSnapshot({ stops: [makeStop({ stopId: 'v' })] }), []);
  assert.equal(summary.planningStatus, 'validated');
});

test('an empty snapshot stays empty even with hard constraints', () => {
  const summary = evaluateSnapshot(makeSnapshot(), [
    constraint({
      constraintId: 'visit:missing',
      kind: 'visit_window',
      strength: 'hard',
      payload: { stopId: 'missing', earliestStartMinutes: 0 },
    }),
  ]);
  assert.equal(summary.planningStatus, 'empty');
  assert.equal(summary.checks[0].status, 'fail');
});
