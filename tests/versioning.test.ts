import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSnapshot } from './helpers.js';
import { applyProposal, createInitialVersion } from '../src/domain/versioning.js';
import type { Proposal } from '../src/domain/types.js';

test('createInitialVersion starts at revision 0', () => {
  const snapshot = makeSnapshot();
  const version = createInitialVersion(snapshot.tripId, snapshot, 'test');
  assert.equal(version.revision, 0);
  assert.equal(version.reason, 'test');
});

test('applyProposal applies a ready proposal with matching base revision', () => {
  const current = makeSnapshot({ version: 7 });
  const candidateSnapshot = makeSnapshot({
    version: 7,
    stops: current.stops,
    planningStatus: 'needs_review',
  });
  const proposal: Proposal = {
    proposalId: 'proposal_1',
    tripId: current.tripId,
    status: 'ready',
    baseRevision: 7,
    createdAt: '2026-09-20T13:00:00+08:00',
    expiresAt: '2026-09-20T13:05:00+08:00',
    candidates: [
      {
        candidateId: 'candidate_1',
        kind: 'replan',
        title: '就近休息',
        summary: '新增休息 30 分钟',
        changes: [],
        checks: [],
        snapshot: candidateSnapshot,
      },
    ],
  };
  const result = applyProposal(proposal, current, '2026-09-20T13:01:00+08:00');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.version.revision, 8);
  assert.equal(result.version.snapshot.planningStatus, 'validated');
});

test('applyProposal rejects when base revision is stale', () => {
  const current = makeSnapshot({ version: 8 });
  const proposal: Proposal = {
    proposalId: 'proposal_2',
    tripId: current.tripId,
    status: 'ready',
    baseRevision: 7,
    createdAt: '2026-09-20T13:00:00+08:00',
    expiresAt: '2026-09-20T13:05:00+08:00',
    candidates: [
      {
        candidateId: 'candidate_1',
        kind: 'replan',
        title: '旧方案',
        summary: '旧方案',
        changes: [],
        checks: [],
        snapshot: current,
      },
    ],
  };
  const result = applyProposal(proposal, current, '2026-09-20T13:01:00+08:00');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'REVISION_CONFLICT');
});

test('applyProposal rejects foreign trip snapshots, mixed data modes, and duplicate candidate IDs', () => {
  const current = makeSnapshot({ tripId: 'trip_1', dataMode: 'online', version: 3 });
  const baseProposal: Proposal = {
    proposalId: 'proposal_integrity',
    tripId: current.tripId,
    status: 'ready',
    baseRevision: current.version ?? 0,
    createdAt: '2026-09-20T13:00:00+08:00',
    expiresAt: '2026-09-20T13:05:00+08:00',
    candidates: [{
      candidateId: 'candidate_1', title: '候选', summary: '', checks: [],
      snapshot: makeSnapshot({ tripId: current.tripId, dataMode: 'online', version: current.version }),
    }],
  };

  const foreignTrip = structuredClone(baseProposal);
  foreignTrip.candidates[0].snapshot.tripId = 'trip_2';
  const foreignResult = applyProposal(foreignTrip, current, '2026-09-20T13:01:00+08:00');
  assert.equal(foreignResult.ok, false);
  if (!foreignResult.ok) assert.equal(foreignResult.code, 'TRIP_MISMATCH');

  const mixedMode = structuredClone(baseProposal);
  mixedMode.candidates[0].snapshot.dataMode = 'demo';
  const modeResult = applyProposal(mixedMode, current, '2026-09-20T13:01:00+08:00');
  assert.equal(modeResult.ok, false);
  if (!modeResult.ok) assert.equal(modeResult.code, 'DATA_MODE_MISMATCH');

  const duplicateCandidate = structuredClone(baseProposal);
  duplicateCandidate.candidates.push({ ...duplicateCandidate.candidates[0], title: '另一份内容' });
  const duplicateResult = applyProposal(duplicateCandidate, current, '2026-09-20T13:01:00+08:00');
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.equal(duplicateResult.code, 'INVALID_PROPOSAL');
});

test('applyProposal requires the proposal context to match the current trip context exactly', () => {
  const current = makeSnapshot({ contextSnapshotId: 'context_current', version: 2 });
  const proposal: Proposal = {
    proposalId: 'proposal_context', tripId: current.tripId, status: 'ready', baseRevision: 2,
    contextSnapshotId: null, createdAt: '2026-09-20T13:00:00+08:00', expiresAt: '2026-09-20T13:05:00+08:00',
    candidates: [{ candidateId: 'candidate', title: '候选', summary: '', checks: [], snapshot: current }],
  };
  const result = applyProposal(proposal, current, '2026-09-20T13:01:00+08:00');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'CONTEXT_CHANGED');
});
