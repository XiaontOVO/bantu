/**
 * 待选方案：生成、查询与放弃。
 *
 * 提案只是**待选**，不影响正式计划——真正的写入要经过 trip/apply.ts 的许可与幂等。
 * 两条不变量：
 *
 * 1. 候选必须带校验结果与结构差异，用户才有的可比；没带就按当前约束与计划现算。
 * 2. 每个候选各自生成一个 actionRequest，同一审批组互斥（不能同时批准两个候选）。
 */
import { checkConstraint } from '../../domain/constraints.js';
import { diffPlans } from '../../domain/diff.js';
import { evaluateCandidate } from '../../domain/planning.js';
import { normalizeTripSnapshot } from '../../domain/normalize.js';
import { checkPlanBoundary, preserveExecutedStops } from '../../domain/plan-boundaries.js';
import type { Proposal, ProposalCandidate } from '../../domain/types.js';
import type { CreateActionRequestInput } from '../../domain/authorization.js';
import { ownedTrip } from './access.js';
import { id, serviceError } from './helpers.js';
import { isValidRevision } from './validation.js';
import type { CreateProposalInput, ProposalView, ServiceResult } from './contracts.js';
import type { TripState } from './state.js';

/**
 * 提案视图＝提案本身 + 每个候选对应的许可。
 *
 * 查找必须同时按 tripId 与 candidateId 收窄：候选 id 是提案自己起的
 * （Agent 固定用 `initial_agent_1`／`rest_agent_1`），**不同旅行之间会重名**。
 * 只按 candidateId 全局查找，会把别人旅行的动作请求（含它的 actorId、sessionId、
 * canonicalArgs）当成自己这一份返回给客户端——既是越权读取，也会让本地的
 * 批准步骤对不上号（ACTION_AUTHORIZATION_INVALID）。
 */
function toProposalView(state: TripState, proposal: Proposal): ProposalView {
  const allRequests = state.authorization
    .listRequests()
    .filter((request) => request.tripId === proposal.tripId && request.proposalId === proposal.proposalId);
  const candidateCounts = new Map<string, number>();
  for (const candidate of proposal.candidates) {
    candidateCounts.set(candidate.candidateId, (candidateCounts.get(candidate.candidateId) ?? 0) + 1);
  }
  const requests = proposal.candidates.flatMap((candidate) => {
    if (candidateCounts.get(candidate.candidateId) !== 1) return [];
    const request = allRequests.find((item) => item.candidateId === candidate.candidateId);
    return request ? [request] : [];
  });
  return {
    proposal: structuredClone(proposal),
    actionRequests: requests.map((request) => structuredClone(request)),
  };
}


export function createProposal(
  state: TripState,
  actorId: string,
  tripId: string,
  input: CreateProposalInput,
): ServiceResult<ProposalView> {
  const tripResult = ownedTrip(state, actorId, tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  if (!isValidRevision(input.baseRevision)) {
    return { ok: false, error: serviceError('INVALID_INPUT', 'baseRevision 必须是非负整数。') };
  }
  if (record.revision !== input.baseRevision) {
    return {
      ok: false,
      error: serviceError('REVISION_CONFLICT', '行程已有更新，请查看最新安排。', {
        currentRevision: record.revision,
      }),
    };
  }
  if (record.lifecycle === 'archived') {
    return { ok: false, error: serviceError('INVALID_TRIP_STATE', '归档旅行不能生成计划。') };
  }

  const proposalId = input.proposalId ?? id('proposal');
  if (!proposalId.trim()) {
    return { ok: false, error: serviceError('INVALID_INPUT', 'proposalId 不能为空。') };
  }
  if (record.proposals.has(proposalId)) {
    return { ok: false, error: serviceError('IDEMPOTENCY_CONFLICT', '提案 ID 已使用，请重新加载后生成新方案。') };
  }
  const suppliedCandidateIds = input.candidates.flatMap((candidate, index) => [candidate.candidateId ?? `${proposalId}_candidate_${index + 1}`]);
  if (suppliedCandidateIds.some((candidateId) => !candidateId.trim()) || new Set(suppliedCandidateIds).size !== suppliedCandidateIds.length) {
    return { ok: false, error: serviceError('INVALID_INPUT', '候选方案 ID 不能重复。') };
  }
  for (const candidate of input.candidates) {
    const snapshot = normalizeTripSnapshot(candidate.snapshot);
    if (snapshot.tripId !== tripId) {
      return { ok: false, error: serviceError('TRIP_MISMATCH', '候选方案必须属于当前行程。') };
    }
    if (snapshot.dataMode !== record.dataMode) {
      return { ok: false, error: serviceError('DATA_MODE_MISMATCH', '在线与演示数据不能混用。') };
    }
  }
  // 同一审批组互斥：用户不能同时批准两个候选。
  const approvalGroupId = id('approval_group');
  const createdAt = state.now();
  const expiresAt =
    input.expiresAt ?? new Date(Date.parse(createdAt) + 5 * 60 * 1000).toISOString();
  const constraints = record.snapshot.constraints ?? [];

  const candidates: ProposalCandidate[] = input.candidates.map((candidate, index) => {
    const candidateId = candidate.candidateId ?? `${proposalId}_candidate_${index + 1}`;
    const snapshot = normalizeTripSnapshot({ ...candidate.snapshot,
      travelDate: record.snapshot.travelDate, timezone: record.snapshot.timezone,
      stops: preserveExecutedStops(candidate.snapshot.stops, record.snapshot.stops) });
    // 候选可以自带校验结果；没带就按当前约束现算，绝不留空。
    const checks =
      candidate.checks ? [...candidate.checks] : constraints.map((constraint) => checkConstraint(constraint, snapshot));
    const changes = diffPlans(record.snapshot, snapshot).map((change) => change);
    const boundary = checkPlanBoundary(record.snapshot, snapshot, createdAt);
    if (boundary) checks.push({ constraintId: 'system-time', status: 'fail', reasonCode: 'PLAN_TIME_OR_PROGRESS_CONFLICT', explanation: boundary });
    const evaluation = evaluateCandidate(
      { candidateId, title: candidate.title, summary: candidate.summary, snapshot, checks, changes },
      constraints,
    );
    return {
      candidateId,
      kind: input.kind,
      title: candidate.title,
      summary: candidate.summary,
      snapshot,
      changes,
      checks: evaluation.checks,
      applicability: evaluation.applicability,
      contextSnapshotId: input.contextSnapshotId ?? record.latestContextId,
      // 证据引用从快照里的地点推导，用户才能追到"这个推荐凭什么"。
      evidenceRefs:
        candidate.evidenceRefs ??
        [...new Set(snapshot.stops.flatMap((stop) => stop.place?.evidenceIds ?? []))],
      plannedDepartureAt: candidate.snapshot.departureBasis?.plannedDepartureAt ?? null,
    };
  });

  const proposal: Proposal = {
    proposalId,
    tripId,
    kind: input.kind,
    status: 'ready',
    baseRevision: input.baseRevision,
    contextSnapshotId: input.contextSnapshotId ?? record.latestContextId,
    createdAt,
    expiresAt,
    candidates,
    algorithmVersion: input.algorithmVersion ?? 'engine-v1',
    promptVersion: input.promptVersion ?? 'prompt-v1',
  };
  // 每个候选一个独立许可，参数摘要与 applyProposal 侧保持一致。
  const createdActionRequestIds: string[] = [];
  for (const candidate of candidates) {
    const args = {
      proposalId,
      candidateId: candidate.candidateId,
      expectedRevision: input.baseRevision,
      contextSnapshotId: proposal.contextSnapshotId,
    };
    const requestInput: CreateActionRequestInput = {
      actionRequestId: id('action'),
      tripId,
      actorId,
      // 未绑定具体会话时用 '*'：该许可对任何持有它的会话都要求重新确认。
      sessionId: input.sessionId ?? '*',
      toolName: 'plan.apply',
      canonicalArgs: args,
      summary: `采用「${candidate.title}」`,
      createdAt,
      expiresAt,
      approvalGroupId,
      baseRevision: input.baseRevision,
      contextSnapshotId: proposal.contextSnapshotId,
      proposalId,
      candidateId: candidate.candidateId,
    };
    const created = state.authorization.createRequest(requestInput);
    if (!created.ok) {
      for (const actionRequestId of createdActionRequestIds) {
        state.authorization.discardPendingRequest(actionRequestId);
      }
      return {
        ok: false,
        error: serviceError(
          created.error?.code ?? 'INVALID_INPUT',
          created.error?.message ?? '创建授权失败。',
        ),
      };
    }
    createdActionRequestIds.push(requestInput.actionRequestId);
  }

  record.proposals.set(proposalId, proposal);
  state.trips.set(tripId, record);
  return { ok: true, value: toProposalView(state, proposal) };
}

export function getProposal(
  state: TripState,
  actorId: string,
  tripId: string,
  proposalId: string,
): ServiceResult<ProposalView> {
  const result = ownedTrip(state, actorId, tripId);
  if (!result.ok) return result;
  const proposal = result.value.proposals.get(proposalId);
  if (!proposal) return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '提案不存在。') };
  return { ok: true, value: toProposalView(state, proposal) };
}

/** 放弃提案：终结提案，并把它名下还挂着的待办许可一并拒绝。 */
export function rejectProposal(
  state: TripState,
  actorId: string,
  tripId: string,
  proposalId: string,
): ServiceResult<Proposal> {
  const result = ownedTrip(state, actorId, tripId);
  if (!result.ok) return result;
  const proposal = result.value.proposals.get(proposalId);
  if (!proposal) return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '提案不存在。') };
  if (proposal.status !== 'ready') {
    return { ok: false, error: serviceError('OPERATION_TERMINAL', '提案已经终结。') };
  }
  proposal.status = 'rejected';
  for (const request of state.authorization.listRequests()) {
    if (request.tripId === tripId && request.proposalId === proposalId && request.status === 'pending') {
      state.authorization.decide(request.actionRequestId, 'reject', { now: state.now() });
    }
  }
  result.value.proposals.set(proposalId, proposal);
  state.trips.set(tripId, result.value);
  return { ok: true, value: structuredClone(proposal) };
}
