import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConstraint, evaluateSnapshot } from '../src/domain/constraints.js';
import { makeSnapshot } from './helpers.js';

test('retain_stop constraint passes when stop exists and retained', () => {
  const snapshot = makeSnapshot({
    stops: [
      {
        stopId: 'p',
        placeId: 'P',
        startMinutes: 9 * 60,
        endMinutes: 10 * 60,
        departureMinutes: 10 * 60,
        minDurationMinutes: 30,
        plannedDurationMinutes: 60,
        retain: true,
        status: 'planned',
      },
    ],
  });
  const check = checkConstraint(
    {
      constraintId: 'retain:p',
      kind: 'retain_stop',
      strength: 'hard',
      source: 'user_form',
      confirmedAt: '2026-09-20T09:00:00+08:00',
      memberIds: [],
      payload: { stopId: 'p' },
    },
    snapshot,
  );
  assert.equal(check.status, 'pass');
});

test('visit_window constraint fails outside open interval', () => {
  const snapshot = makeSnapshot({
    stops: [
      {
        stopId: 'v',
        placeId: 'V',
        startMinutes: 12 * 60,
        endMinutes: 13 * 60,
        departureMinutes: 13 * 60,
        minDurationMinutes: 60,
        plannedDurationMinutes: 60,
        status: 'planned',
      },
    ],
  });
  const check = checkConstraint(
    {
      constraintId: 'visit:v',
      kind: 'visit_window',
      strength: 'hard',
      source: 'user_form',
      confirmedAt: null,
      memberIds: [],
      payload: { stopId: 'v', earliestStartMinutes: 14 * 60 },
    },
    snapshot,
  );
  assert.equal(check.status, 'fail');
});

test('evaluateSnapshot returns needs_review when hard constraint fails', () => {
  const snapshot = makeSnapshot({
    stops: [
      {
        stopId: 'v',
        placeId: 'V',
        startMinutes: 12 * 60,
        endMinutes: 13 * 60,
        departureMinutes: 13 * 60,
        minDurationMinutes: 60,
        plannedDurationMinutes: 60,
        status: 'planned',
      },
    ],
  });
  const result = evaluateSnapshot(snapshot, [
    {
      constraintId: 'visit:v',
      kind: 'visit_window',
      strength: 'hard',
      source: 'template',
      confirmedAt: null,
      memberIds: [],
      payload: { stopId: 'v', earliestStartMinutes: 14 * 60 },
    },
  ]);
  assert.equal(result.planningStatus, 'needs_review');
  assert.equal(result.checks[0].status, 'fail');
});
