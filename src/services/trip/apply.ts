/**
 * 一次性动作许可的确认、应用与撤销。
 *
 * 三条不变量：
 *
 * 1. **许可来自具体动作**，不是泛泛的"同意"。按钮与文字确认都只对"已展示且唯一"的候选生效；
 *    否定、假设与引用（"如果…就…"）由 authorization.confirmFromText 识别为不授权。
 * 2. **批准后只写一次**：幂等键 + 一次性许可双重保证；证据与版本校验都在消费许可之前，
 *    因为许可一旦消费就不能退回。
 * 3. **撤销只回退最近一次**计划调整；该版之后若已记录执行事实则拒绝——
 *    计划可以撤销，"我们确实去过"不行。
 */
import {
  applyProposal as applyProposalDomain,
  assertCanApply,
  undoLastPlanApply,
  type PlanVersion,
} from '../../domain/versioning.js';
import { digestArgs } from '../../domain/authorization.js';
import type { ActionRequest } from '../../domain/types.js';
import type { ActionAuthorizationService } from '../../domain/authorization.js';
import { activePrincipal } from './identity.js';
import { ownedTrip, toView } from './access.js';
import { commitPlanSnapshot } from './commit.js';
import { isValidRevision } from './validation.js';
import { id, serviceError } from './helpers.js';
import type {
  AppliedProposalValue,
  ApplyProposalCommand,
  MutationView,
  ServiceResult,
  UndoCommand,
} from './contracts.js';
import type { TripState } from './state.js';

type ActionRequestView = ReturnType<ActionAuthorizationService['getRequest']>;

export interface DecideActionInput {
  actorId: string;
  sessionId: string;
  actionRequestId: string;
  decision: 'approve' | 'reject';
  digest?: string;
  now?: string;
}

export interface ConfirmFromTextInput {
  actorId: string;
  sessionId: string;
  tripId: string;
  text: string;
  proposalId?: string;
  now?: string;
}

/**
 * 找出某趟旅行里某个候选对应的动作请求。
 *
 * **必须按 tripId 收窄**：候选 id 是提案自己起的（Agent 固定用 `initial_agent_1`／
 * `rest_agent_1`），不同旅行之间天然重名。只按 candidateId 全局查找时，
 * 用户在自己旅行里说一句"确认"，命中的可能是另一个主体那份动作请求——
 * 等于替别人授权，同时自己的候选再也确认不了。
 */
function requestsForCandidate(
  state: TripState,
  tripId: string,
  candidateId: string,
): ActionRequest[] {
  return state.authorization
    .listRequests()
    .filter((request) => request.tripId === tripId && request.candidateId === candidateId);
}

/** 按钮确认。归属通过请求所属旅行反查，而不是信任调用方传来的 tripId。 */
export function decideAction(
  state: TripState,
  input: DecideActionInput,
): ServiceResult<ActionRequestView> {
  const auth = activePrincipal(state, input.actorId, input.sessionId);
  if (!auth.ok) return auth;
  const request = state.authorization.getRequest(input.actionRequestId);
  if (!request || request.tripId === undefined) {
    return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '动作请求不存在。') };
  }
  const trip = state.trips.get(request.tripId);
  if (!trip || trip.deletedAt || trip.ownerId !== input.actorId) {
    return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '动作请求不存在。') };
  }
  const result = state.authorization.decide(input.actionRequestId, input.decision, {
    now: input.now ?? state.now(),
    digest: input.digest,
    actorId: input.actorId,
    sessionId: input.sessionId,
    confirmationSource: 'button',
  });
  if (!result.ok) {
    return {
      ok: false,
      error: serviceError(
        result.error?.code ?? 'ACTION_AUTHORIZATION_INVALID',
        result.error?.message ?? '授权失败。',
      ),
    };
  }
  return { ok: true, value: result.value?.request };
}

/**
 * 文字确认。
 *
 * 只把**已展示且唯一**的候选交给解析器：模型或用户都不能凭一句话授权一个没见过的动作。
 * 否定、假设与引用（"如果…就…"）由 `authorization.confirmFromText` 负责识别为不授权。
 */
export function confirmFromText(
  state: TripState,
  input: ConfirmFromTextInput,
): ServiceResult<ActionRequestView> {
  const auth = activePrincipal(state, input.actorId, input.sessionId);
  if (!auth.ok) return auth;
  const tripResult = ownedTrip(state, input.actorId, input.tripId);
  if (!tripResult.ok) return tripResult;
  const now = input.now ?? state.now();

  const proposals = [...tripResult.value.proposals.values()].filter(
    (proposal) => proposal.status === 'ready',
  );
  const visible: Array<{
    actionRequestId: string;
    candidateIndex: number;
    candidateId: string;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'executed';
    expiresAt: string;
  }> = [];
  for (const proposal of proposals) {
    if (proposal.proposalId !== input.proposalId && input.proposalId) continue;
    proposal.candidates.forEach((candidate, index) => {
      const request = requestsForCandidate(state, input.tripId, candidate.candidateId)
        .find((item) => item.proposalId === proposal.proposalId);
      if (!request || (request.sessionId !== '*' && request.sessionId !== input.sessionId)) return;
      visible.push({
        actionRequestId: request.actionRequestId,
        candidateIndex: index + 1,
        candidateId: candidate.candidateId,
        status: request.status as (typeof visible)[number]['status'],
        expiresAt: request.expiresAt,
      });
    });
  }

  const resolution = state.authorization.confirmFromText({
    actorId: input.actorId,
    sessionId: input.sessionId,
    text: input.text,
    displayed: visible,
    now,
    grantId: id('grant'),
  });
  if (!resolution.ok) {
    return {
      ok: false,
      error: serviceError(
        resolution.error?.code ?? 'ACTION_AUTHORIZATION_REQUIRED',
        resolution.error?.message ?? '需要明确许可。',
      ),
    };
  }
  return { ok: true, value: resolution.value?.request };
}

export function applyProposal(
  state: TripState,
  command: ApplyProposalCommand,
): ServiceResult<AppliedProposalValue> {
  const auth = activePrincipal(state, command.actorId, command.sessionId);
  if (!auth.ok) return auth;
  const tripResult = ownedTrip(state, command.actorId, command.tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  const proposal = record.proposals.get(command.proposalId);
  if (!proposal) return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '提案不存在。') };
  const now = command.now ?? state.now();

  // 幂等：同一 key + 同一请求体只写一次；并发同 key 直接拒绝而不是并行执行。
  const scope = 'plan.apply';
  const body = {
    tripId: command.tripId,
    proposalId: command.proposalId,
    candidateId: command.candidateId ?? null,
    expectedRevision: command.expectedRevision,
    actionRequestId: command.actionRequestId,
  };
  const begin = state.idempotency.begin({
    actorId: command.actorId,
    scope,
    key: command.idempotencyKey,
    requestBody: body,
    now,
  });
  if (begin.kind === 'conflict') {
    return { ok: false, error: serviceError('IDEMPOTENCY_CONFLICT', '同一幂等键对应了不同请求。') };
  }
  if (begin.kind === 'in_progress') {
    return {
      ok: false,
      error: serviceError('OPERATION_IN_PROGRESS', '同一次应用正在处理中。', { retryable: true }),
    };
  }
  if (begin.kind === 'replay') {
    if (begin.record.status === 'failed') {
      return {
        ok: false,
        error: serviceError(
          begin.record.error?.code ?? 'OPERATION_FAILED',
          begin.record.error?.message ?? '上次操作失败，请重新检查。',
        ),
      };
    }
    return { ok: true, value: begin.record.response as AppliedProposalValue };
  }

  // 证据与版本校验都在消费许可之前：许可一旦被消费就不能退回。
  const check = assertCanApply(proposal, record.snapshot, now, {
    candidateId: command.candidateId,
    evidenceRegistry: state.options.evidenceRegistry,
  });
  if (!check.ok) {
    state.idempotency.fail(
      command.actorId,
      scope,
      command.idempotencyKey,
      { code: check.code, message: check.message },
      now,
    );
    return { ok: false, error: serviceError(check.code, check.message) };
  }

  const request = state.authorization.getRequest(command.actionRequestId);
  const expectedArgs = {
    proposalId: proposal.proposalId,
    candidateId: check.candidate.candidateId,
    expectedRevision: proposal.baseRevision,
    contextSnapshotId: proposal.contextSnapshotId,
  };
  const expectedDigest = digestArgs(expectedArgs);
  if (
    !request ||
    request.tripId !== command.tripId ||
    request.toolName !== 'plan.apply' ||
    request.proposalId !== proposal.proposalId ||
    request.candidateId !== check.candidate.candidateId ||
    request.baseRevision !== proposal.baseRevision ||
    command.expectedRevision !== proposal.baseRevision ||
    (request.contextSnapshotId ?? null) !== (proposal.contextSnapshotId ?? null) ||
    request.argsDigest !== expectedDigest ||
    digestArgs(request.canonicalArgs) !== expectedDigest
  ) {
    state.idempotency.fail(
      command.actorId,
      scope,
      command.idempotencyKey,
      { code: 'ACTION_AUTHORIZATION_INVALID', message: '许可与要应用的方案或候选不匹配。' },
      now,
    );
    return { ok: false, error: serviceError('ACTION_AUTHORIZATION_INVALID', '许可与要应用的候选不匹配。') };
  }

  // 先完整生成领域版本；即使证据、边界或候选校验失败，也不能提前消耗一次性许可。
  const applied = applyProposalDomain(proposal, record.snapshot, now, 'plan.apply', {
    candidateId: check.candidate.candidateId,
  });
  if (!applied.ok) {
    state.idempotency.fail(
      command.actorId,
      scope,
      command.idempotencyKey,
      { code: applied.code, message: applied.message },
      now,
    );
    return { ok: false, error: serviceError(applied.code, applied.message) };
  }

  // 授权摘要在创建请求时冻结；这里再次校验目标提案、候选、版本和上下文。
  const consumed = state.authorization.consumeGrant({
    grantId: command.grantId,
    actionRequestId: request.actionRequestId,
    actorId: command.actorId,
    sessionId: command.sessionId,
    digest: expectedDigest,
    now,
  });
  if (!consumed.ok) {
    state.idempotency.fail(
      command.actorId,
      scope,
      command.idempotencyKey,
      {
        code: consumed.error?.code ?? 'ACTION_AUTHORIZATION_INVALID',
        message: consumed.error?.message ?? '许可无效。',
      },
      now,
    );
    return {
      ok: false,
      error: serviceError(
        consumed.error?.code ?? 'ACTION_AUTHORIZATION_INVALID',
        consumed.error?.message ?? '许可无效。',
      ),
    };
  }

  const mutationId = applied.version.mutationId ?? id('mutation');
  const mutation: MutationView = {
    mutationId,
    tripId: record.tripId,
    actorId: command.actorId,
    action: 'plan.apply',
    beforeRevision: applied.version.beforeRevision ?? command.expectedRevision,
    afterRevision: applied.version.revision,
    reversesId: null,
    createdAt: now,
  };
  const version: PlanVersion = { ...applied.version, mutationId };
  commitPlanSnapshot(state, record, version, mutation);
  proposal.status = 'applied';
  record.proposals.set(proposal.proposalId, proposal);

  const value: AppliedProposalValue = {
    trip: toView(state, record),
    mutationId,
    revision: version.revision,
    actionRequestId: command.actionRequestId,
    grantId: command.grantId,
  };
  state.idempotency.complete(command.actorId, scope, command.idempotencyKey, value, now);
  return { ok: true, value };
}

/**
 * 撤销最近一次计划调整。
 *
 * 只允许撤销 mutationId 对应的那一版；若该版之后已经记录了执行事实，
 * 领域层会拒绝——撤销计划可以，抹掉"我们确实去过"不行。
 */
export function undo(
  state: TripState,
  command: UndoCommand,
): ServiceResult<AppliedProposalValue> {
  const auth = activePrincipal(state, command.actorId, command.sessionId);
  if (!auth.ok) return auth;
  const tripResult = ownedTrip(state, command.actorId, command.tripId);
  if (!tripResult.ok) return tripResult;
  const record = tripResult.value;
  if (!isValidRevision(command.expectedRevision)) {
    return { ok: false, error: serviceError('INVALID_INPUT', 'expectedRevision 必须是非负整数。') };
  }
  const now = command.now ?? state.now();

  const scope = 'plan.undo';
  const body = {
    tripId: command.tripId,
    mutationId: command.mutationId,
    expectedRevision: command.expectedRevision,
  };
  const begin = state.idempotency.begin({
    actorId: command.actorId,
    scope,
    key: command.idempotencyKey,
    requestBody: body,
    now,
  });
  if (begin.kind === 'conflict') {
    return { ok: false, error: serviceError('IDEMPOTENCY_CONFLICT', '同一幂等键对应了不同请求。') };
  }
  if (begin.kind === 'replay') {
    if (begin.record.status === 'failed') {
      return {
        ok: false,
        error: serviceError(
          begin.record.error?.code ?? 'OPERATION_FAILED',
          begin.record.error?.message ?? '上次操作失败，请重新检查。',
        ),
      };
    }
    return { ok: true, value: begin.record.response as AppliedProposalValue };
  }
  if (begin.kind === 'in_progress') {
    return { ok: false, error: serviceError('OPERATION_IN_PROGRESS', '撤销正在处理中。') };
  }

  const versionIndex = record.versions.findIndex(
    (version) => version.mutationId === command.mutationId,
  );
  if (versionIndex < 0) {
    return { ok: false, error: serviceError('UNDO_CONFLICT', '只能撤销最近一次调整应用。') };
  }
  const version = record.versions[versionIndex];
  const previous = record.versions[versionIndex - 1];
  const factsChanged =
    record.snapshot.executionEvents?.some(
      (event) => Date.parse(event.recordedAt) > Date.parse(version.createdAt),
    ) ?? false;
  const undone = undoLastPlanApply(record.snapshot, version, now, {
    expectedRevision: command.expectedRevision,
    hasFactsChanged: factsChanged,
    restoredSnapshot: previous?.snapshot,
  });
  if (!undone.ok || !undone.version) {
    state.idempotency.fail(
      command.actorId,
      scope,
      command.idempotencyKey,
      { code: undone.code ?? 'UNDO_CONFLICT', message: undone.message ?? '不能撤销该调整。' },
      now,
    );
    return {
      ok: false,
      error: serviceError(undone.code ?? 'UNDO_CONFLICT', undone.message ?? '不能撤销该调整。'),
    };
  }
  const mutationId = undone.version.mutationId ?? id('mutation');
  const mutation: MutationView = {
    mutationId,
    tripId: record.tripId,
    actorId: command.actorId,
    action: 'plan.undo',
    beforeRevision: command.expectedRevision,
    afterRevision: undone.version.revision,
    reversesId: version.mutationId ?? null,
    createdAt: now,
  };
  const versionToCommit: PlanVersion = { ...undone.version, mutationId };
  commitPlanSnapshot(state, record, versionToCommit, mutation);

  const value: AppliedProposalValue = {
    trip: toView(state, record),
    mutationId,
    revision: versionToCommit.revision,
    actionRequestId: '',
    grantId: '',
  };
  state.idempotency.complete(command.actorId, scope, command.idempotencyKey, value, now);
  return { ok: true, value };
}
