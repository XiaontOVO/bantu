import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPlans } from '../src/domain/diff.js';
import {
  detectConstraintConflicts,
  evaluateCandidate,
  isCandidateApplicable,
  noFeasiblePlanMessage,
  rankCandidates,
} from '../src/domain/planning.js';
import type { ProposalCandidate } from '../src/domain/types.js';
import { makeSnapshot, makeStop } from './helpers.js';

test('diffPlans distinguishes insert, remove, move and update without double-counting', () => {
  const baseline = makeSnapshot({
    stops: [makeStop({ stopId: 'a', startMinutes: 9 * 60 }), makeStop({ stopId: 'b', startMinutes: 11 * 60 })],
  });
  const candidate = makeSnapshot({
    stops: [
      makeStop({ stopId: 'a', startMinutes: 9 * 60 + 30 }),
      makeStop({ stopId: 'c', startMinutes: 11 * 60 }),
    ],
  });
  const changes = diffPlans(baseline, candidate);
  assert.ok(changes.some((change) => change.type === 'move' && change.stopId === 'a'));
  assert.ok(changes.some((change) => change.type === 'remove' && change.stopId === 'b'));
  assert.ok(changes.some((change) => change.type === 'insert' && change.stopId === 'c'));
});

test('candidate evaluation keeps hard fail separate from unknown', () => {
  const failed: ProposalCandidate = {
    candidateId: 'fail',
    title: '失败',
    summary: '超过最晚到达',
    snapshot: makeSnapshot({
      stops: [
        makeStop({
          stopId: 'v',
          startMinutes: 15 * 60,
          plannedArrivalMinutes: 15 * 60,
          visitWindow: { startMinutes: 14 * 60, endMinutes: 16 * 60 },
        }),
      ],
    }),
    checks: [
      { constraintId: 'visit:v', status: 'fail', reasonCode: 'arrives_too_late', affectedStopIds: ['v'] },
    ],
  };
  assert.equal(isCandidateApplicable(failed), false);

  const unknown: ProposalCandidate = {
    candidateId: 'unknown',
    title: '待核实',
    summary: '步行资料缺失',
    snapshot: makeSnapshot({ stops: [makeStop({ stopId: 'v' })] }),
    checks: [
      { constraintId: 'walk:leg', status: 'unknown', reasonCode: 'walking_data_unknown', affectedStopIds: [] },
    ],
  };
  assert.equal(evaluateCandidate(unknown, []).applicability, 'needs_verification');
  assert.equal(isCandidateApplicable(unknown), false);
});

test('candidate ranking is deterministic by fewer changes, walking, then stable id', () => {
  const baseline = makeSnapshot({ stops: [makeStop({ stopId: 'a' })] });
  const candidates: ProposalCandidate[] = [
    {
      candidateId: 'c_large',
      title: '改动多',
      summary: '',
      snapshot: makeSnapshot({
        stops: [makeStop({ stopId: 'a', startMinutes: 10 * 60 }), makeStop({ stopId: 'b' })],
      }),
      changes: [
        { type: 'move', stopId: 'a', summary: 'move' },
        { type: 'insert', stopId: 'b', summary: 'insert' },
      ],
    },
    {
      candidateId: 'c_small_b',
      title: '改动少 B',
      summary: '',
      snapshot: makeSnapshot({ stops: [makeStop({ stopId: 'a', startMinutes: 10 * 60 })] }),
      changes: [{ type: 'move', stopId: 'a', summary: 'move' }],
    },
    {
      candidateId: 'c_small_a',
      title: '改动少 A',
      summary: '',
      snapshot: makeSnapshot({ stops: [makeStop({ stopId: 'a', startMinutes: 10 * 60 })] }),
      changes: [{ type: 'move', stopId: 'a', summary: 'move' }],
    },
  ];
  const ranked = rankCandidates(candidates, baseline);
  assert.equal(ranked[0].candidateId, 'c_small_a');
  assert.equal(ranked[1].candidateId, 'c_small_b');
  assert.equal(ranked[2].candidateId, 'c_large');
});

test('directly contradictory visit windows are reported; limited search is not', () => {
  const constraints = [
    {
      constraintId: 'a',
      kind: 'visit_window' as const,
      strength: 'hard' as const,
      payload: { stopId: 'v', earliestStartMinutes: 15 * 60 },
    },
    {
      constraintId: 'b',
      kind: 'visit_window' as const,
      strength: 'hard' as const,
      payload: { stopId: 'v', latestStartMinutes: 14 * 60 },
    },
  ];
  const conflicts = detectConstraintConflicts(constraints);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].code, 'CONTRADICTORY_VISIT_WINDOWS');
  assert.ok(noFeasiblePlanMessage(constraints).includes('无法同时满足'));
  assert.ok(noFeasiblePlanMessage([]).includes('不表示全城无解'));
});
