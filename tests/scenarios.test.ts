import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propagateSchedule } from '../src/domain/itinerary.js';
import { comparePlans } from '../src/domain/diff.js';
import { checkConstraint, evaluateSnapshot } from '../src/domain/constraints.js';
import { evaluateBudget } from '../src/domain/cost.js';
import type { BudgetLimitConstraint, CostEstimate, PlannedCharge, SpendEvent } from '../src/domain/types.js';
import { makeSnapshot, makeStop } from './helpers.js';

function route(legId: string, from: string, to: string, duration: number, meters: number) {
  return {
    legId,
    fromStopId: from,
    toStopId: to,
    transportMode: 'walking' as const,
    durationMinutes: duration,
    walkingMeters: meters,
    distanceMeters: meters,
    bufferMinutes: 5,
  };
}

function scheduleForRestPlan(departureMinutes = 13 * 60) {
  return propagateSchedule({
    departureMinutes,
    segments: [
      {
        stopId: 'r',
        placeId: 'R',
        durationMinutes: 30,
        minDurationMinutes: 30,
        openingIntervals: [{ startMinutes: 12 * 60, endMinutes: 17 * 60 }],
      },
      {
        stopId: 'v',
        placeId: 'V',
        durationMinutes: 60,
        earliestStartMinutes: 15 * 60,
        latestArrivalMinutes: 14 * 60 + 30,
        openingIntervals: [{ startMinutes: 14 * 60, endMinutes: 17 * 60 }],
      },
    ],
    routes: [route('o-r', 'origin', 'r', 5, 250), route('r-v', 'r', 'v', 20, 600)],
  });
}

function scheduleForFreePlan() {
  return propagateSchedule({
    departureMinutes: 13 * 60,
    segments: [
      { stopId: 'p', placeId: 'P', durationMinutes: 40 },
      {
        stopId: 'v',
        placeId: 'V',
        durationMinutes: 60,
        earliestStartMinutes: 15 * 60,
        latestArrivalMinutes: 14 * 60 + 30,
        openingIntervals: [{ startMinutes: 14 * 60, endMinutes: 17 * 60 }],
      },
    ],
    routes: [route('o-p', 'origin', 'p', 15, 900), route('p-v', 'p', 'v', 20, 1200)],
  });
}

test('SC01 rest plan reaches V at 14:05 and saves 1250m versus free-time plan', () => {
  const free = scheduleForFreePlan();
  const rest = scheduleForRestPlan();
  const freeSnapshot = makeSnapshot({ stops: free.stops, routeLegs: free.routeLegs, version: 1 });
  const restSnapshot = makeSnapshot({ stops: rest.stops, routeLegs: rest.routeLegs, version: 2 });

  const v = rest.stops.find((stop) => stop.stopId === 'v');
  assert.ok(v);
  assert.equal(v.plannedArrivalMinutes, 14 * 60 + 5);
  assert.equal(rest.waitingMinutesByStop.v, 55);

  const comparison = comparePlans(freeSnapshot, restSnapshot);
  assert.equal(comparison.delta.walkingMeters, -1250);
  assert.equal(comparison.delta.arrivalAtLastStopMinutes, -20);
  assert.equal(comparison.delta.completionMinutes, 0);
});

test('SC02 30-minute delay fails latest arrival by five minutes', () => {
  const delayed = scheduleForRestPlan(13 * 60 + 30);
  const v = delayed.stops.find((stop) => stop.stopId === 'v');
  assert.ok(v);
  assert.equal(v.plannedArrivalMinutes, 14 * 60 + 35);
  const check = checkConstraint(
    {
      constraintId: 'visit:v',
      kind: 'visit_window',
      strength: 'hard',
      source: 'user_form',
      memberIds: [],
      confirmedAt: null,
      payload: { stopId: 'v', latestArrivalMinutes: 14 * 60 + 30 },
    },
    makeSnapshot({ stops: delayed.stops }),
  );
  assert.equal(check.status, 'fail');
  assert.equal(check.reasonCode, 'arrives_too_late');
});

test('SC04 split opening interval forces wait to 14:00 and arrival is late', () => {
  const result = propagateSchedule({
    departureMinutes: 13 * 60,
    segments: [
      {
        stopId: 'r',
        placeId: 'R',
        durationMinutes: 30,
        openingIntervals: [
          { startMinutes: 12 * 60, endMinutes: 13 * 60 + 20 },
          { startMinutes: 14 * 60, endMinutes: 17 * 60 },
        ],
      },
      { stopId: 'v', placeId: 'V', durationMinutes: 60, latestArrivalMinutes: 14 * 60 + 30 },
    ],
    routes: [route('o-r', 'origin', 'r', 0, 0), route('r-v', 'r', 'v', 20, 600)],
  });
  const r = result.stops.find((stop) => stop.stopId === 'r');
  const v = result.stops.find((stop) => stop.stopId === 'v');
  assert.ok(r);
  assert.ok(v);
  assert.equal(r.startMinutes, 14 * 60);
  assert.equal(v.plannedArrivalMinutes, 14 * 60 + 55);
  assert.equal(result.warnings.filter((warning) => warning.includes('latest arrival')).length, 1);
});

function budgetConstraint(limitMinor: number): BudgetLimitConstraint {
  return {
    constraintId: 'budget:trip',
    kind: 'budget_limit',
    strength: 'hard',
    source: 'user_form',
    memberIds: [],
    confirmedAt: null,
    payload: { scope: 'trip', currency: 'CNY', limitMinor },
  };
}

function knownCost(lowerMinor: number, upperMinor: number | null = lowerMinor): CostEstimate {
  return {
    currency: 'CNY',
    basis: 'party',
    lowerMinor,
    upperMinor,
    certainty: upperMinor === null ? 'unknown' : 'known',
    sourceRef: 'test',
  };
}

test('SC01 budget passes with complete spend, fixed drink price and transit fare', () => {
  const charges: PlannedCharge[] = [
    {
      chargeId: 'drink',
      stopId: 'r',
      quantity: 2,
      costEstimate: { ...knownCost(3000), basis: 'per_person', participantCount: 1 },
      paymentStatus: 'unpaid',
    },
    {
      chargeId: 'transit',
      routeLegRef: 'r-v',
      quantity: 1,
      costEstimate: knownCost(2000),
      paymentStatus: 'unpaid',
    },
  ];
  // 两份饮品 = 2 × 30 元；已花费 80 元；总计 160 元。
  charges[0].costEstimate = { ...knownCost(3000), basis: 'party' };
  const spend: SpendEvent = {
    spendEventId: 'spend:1',
    tripId: 'trip_1',
    amountMinor: 8000,
    currency: 'CNY',
    basis: 'party',
    occurredAt: '2026-09-20T13:00:00+08:00',
    recordedAt: '2026-09-20T13:00:00+08:00',
    completenessConfirmed: true,
    includedChargeIds: [],
  };
  const evaluation = evaluateBudget({
    constraint: budgetConstraint(20000),
    charges,
    spendEvent: spend,
    participantCount: 2,
  });
  assert.equal(evaluation.status, 'pass');
  assert.equal(evaluation.totalUpperMinor, 16000);
});

test('SC05 incomplete spend or unknown upper bound makes hard budget unknown', () => {
  const unknownCharge: PlannedCharge = {
    chargeId: 'lunch',
    quantity: 1,
    costEstimate: { ...knownCost(3000, null), certainty: 'unknown' },
    paymentStatus: 'unpaid',
  };
  const incomplete = evaluateBudget({
    constraint: budgetConstraint(20000),
    charges: [unknownCharge],
    spendEvent: {
      spendEventId: 'spend:2',
      tripId: 'trip_1',
      amountMinor: 8000,
      currency: 'CNY',
      basis: 'party',
      occurredAt: '2026-09-20T13:00:00+08:00',
      recordedAt: '2026-09-20T13:00:00+08:00',
      completenessConfirmed: false,
      includedChargeIds: [],
    },
  });
  assert.equal(incomplete.status, 'unknown');
});

test('SC38 paid charge not linked to complete spend stays unknown, linked becomes 160', () => {
  const charge: PlannedCharge = {
    chargeId: 'venue',
    quantity: 1,
    costEstimate: knownCost(6000),
    paymentStatus: 'paid',
    includedSpendEventId: null,
  };
  const baseSpend = {
    spendEventId: 'spend:3',
    tripId: 'trip_1',
    amountMinor: 8000,
    currency: 'CNY' as const,
    basis: 'party' as const,
    occurredAt: '2026-09-20T13:00:00+08:00',
    recordedAt: '2026-09-20T13:00:00+08:00',
    completenessConfirmed: true,
  };
  const unlinked = evaluateBudget({
    constraint: budgetConstraint(20000),
    charges: [charge],
    spendEvent: { ...baseSpend, includedChargeIds: [] },
  });
  assert.equal(unlinked.status, 'unknown');

  const linked = evaluateBudget({
    constraint: budgetConstraint(20000),
    charges: [{ ...charge, includedSpendEventId: 'spend:3' }],
    spendEvent: { ...baseSpend, includedChargeIds: ['venue'] },
  });
  assert.equal(linked.status, 'pass');
  assert.equal(linked.totalUpperMinor, 8000);
});

test('SC22 missing public-transit walking distance keeps hard walking limit unknown', () => {
  const snapshot = makeSnapshot({
    stops: [makeStop({ stopId: 'a' }), makeStop({ stopId: 'b' })],
    routeLegs: [
      {
        legId: 'a-b',
        fromStopId: 'a',
        toStopId: 'b',
        transportMode: 'transit',
        durationMinutes: 20,
        distanceMeters: 5000,
        bufferMinutes: 5,
      },
    ],
  });
  const check = checkConstraint(
    {
      constraintId: 'walk:day',
      kind: 'walking_limit',
      strength: 'hard',
      source: 'user_form',
      memberIds: [],
      confirmedAt: null,
      payload: { scope: 'day', maxWalkingMeters: 1000 },
    },
    snapshot,
  );
  assert.equal(check.status, 'unknown');
  assert.equal(check.reasonCode, 'walking_data_unknown');
});

test('unknown hard constraints make planningStatus needs_review, not validated', () => {
  const snapshot = makeSnapshot({
    stops: [makeStop({ stopId: 'b' })],
    routeLegs: [
      {
        legId: 'a-b',
        fromStopId: 'a',
        toStopId: 'b',
        transportMode: 'transit',
        durationMinutes: 20,
        distanceMeters: 5000,
        bufferMinutes: 5,
      },
    ],
  });
  const summary = evaluateSnapshot(snapshot, [
    {
      constraintId: 'walk:day',
      kind: 'walking_limit',
      strength: 'hard',
      source: 'user_form',
      memberIds: [],
      confirmedAt: null,
      payload: { scope: 'day', maxWalkingMeters: 1000 },
    },
  ]);
  assert.equal(summary.planningStatus, 'needs_review');
  assert.equal(summary.checks[0].status, 'unknown');
});
