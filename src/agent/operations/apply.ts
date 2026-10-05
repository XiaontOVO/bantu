/**
 * 采用方案：发起应用任务，以及用户批准后恢复执行。
 *
 * 两条纪律：
 * - 提案生成时已为该候选建好待批准许可时，这里**复用它**并直接停在等待态——
 *   否则同一候选会出现两个许可，"应用哪一个"就不确定了。
 * - 恢复时按**原参数**重放待执行调用；写操作一次性，失败即进失败态，
 *   不会留下半完成的动作。
 */
import { AgentRuntime } from '../runtime.js';
import { modelTurn, toolCall, ScriptedModelProvider } from '../../providers/model.js';
import type { Operation } from '../../domain/types.js';
import type { ToolExecutionContext } from '../tools.js';
import { agentNow, type AgentState } from '../state.js';
import type {
  AgentOperationView,
  StartApplyOperationInput,
} from '../contracts.js';
import type { ServiceResult } from '../../services/trip-service.js';
import {
  LEASE_SECONDS,
  actionRequestsFor,
  approvalDeadline,
  getOperation,
  newLeaseToken,
  newOperationId,
  viewOperation,
} from './shared.js';

export async function startApplyOperation(
  state: AgentState,
  input: StartApplyOperationInput,
): Promise<AgentOperationView> {
  const now = agentNow(state);
  const operationId = newOperationId();
  const leaseToken = newLeaseToken();
  const operation: Operation = {
    operationId,
    tripId: input.tripId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    kind: 'plan_apply',
    status: 'queued',
    phase: 'queued',
    baseRevision: input.expectedRevision,
    expectedRevision: input.expectedRevision,
    createdAt: now,
    updatedAt: now,
    usageTotals: {},
  };
  const created = state.operations.create(operation);
  if (!created.ok || !created.operation) {
    throw new Error(created.error?.message ?? '创建应用任务失败。');
  }
  const claimed = state.operations.claim(operationId, leaseToken, now, LEASE_SECONDS);
  if (!claimed.ok) throw new Error(claimed.error?.message ?? '领取应用任务失败。');

  const existingRequest = state.tripService.authorization
    .listRequests()
    .find(
      (request) =>
        request.tripId === input.tripId &&
        request.proposalId === input.proposalId &&
        request.candidateId === input.candidateId &&
        request.status === 'pending',
    );
  const applyContext: ToolExecutionContext = {
    actorId: input.actorId,
    sessionId: input.sessionId,
    tripId: input.tripId,
    now,
    allowedToolNames: ['trip.read', 'plan.apply'],
    metadata: {
      operationId,
      idempotencyKey: input.idempotencyKey ?? `agent-apply:${operationId}`,
    },
  };
  if (existingRequest) {
    state.pendingCallsByOperation.set(operationId, [
      toolCall(
        existingRequest.actionRequestId,
        'plan.apply',
        (existingRequest.canonicalArgs ?? {}) as Record<string, unknown>,
      ),
    ]);
    state.executionContextByOperation.set(operationId, applyContext);
    state.pendingActionsByOperation.set(operationId, [existingRequest]);
    state.operations.pause(operationId, leaseToken, 'awaiting_approval', {
      now,
      waitUntil: existingRequest.expiresAt,
    });
    return viewOperation(state, operationId);
  }

  const applyCall = toolCall('call_apply', 'plan.apply', {
    proposalId: input.proposalId,
    candidateId: input.candidateId,
    expectedRevision: input.expectedRevision,
  });
  const model = new ScriptedModelProvider(
    [
      modelTurn([toolCall('call_read', 'trip.read', { tripId: input.tripId })]),
      modelTurn([applyCall]),
    ],
    () => agentNow(state),
  );
  const runResult = await new AgentRuntime(state.gateway).run({
    operationId,
    messages: [{ role: 'user', content: '采用已展示并获许可的候选方案。' }],
    allowedTools: ['trip.read', 'plan.apply'],
    context: applyContext,
    model,
    gateway: state.gateway,
    budget: { maxModelCalls: 4, maxToolCalls: 4 },
  });

  state.stepsByOperation.set(operationId, runResult.steps);
  state.toolResultsByOperation.set(
    operationId,
    runResult.steps.flatMap((step) => step.toolResults),
  );
  state.operations.recordUsage(
    operationId,
    {
      inputTokens: runResult.usage.inputTokens,
      outputTokens: runResult.usage.outputTokens,
    },
    agentNow(state),
  );

  if (runResult.status === 'awaiting_approval') {
    // 把"还没执行的写调用"和它的上下文一起存下来，等用户批准后按原参数重放。
    state.pendingCallsByOperation.set(operationId, [applyCall]);
    state.executionContextByOperation.set(operationId, applyContext);
    state.pendingActionsByOperation.set(
      operationId,
      actionRequestsFor(state, runResult.pendingActionRequestIds),
    );
    state.operations.pause(operationId, leaseToken, 'awaiting_approval', {
      now: agentNow(state),
      waitUntil: approvalDeadline(now),
    });
  } else {
    state.operations.fail(
      operationId,
      leaseToken,
      runResult.error ?? {
        code: 'ACTION_AUTHORIZATION_REQUIRED',
        message: '应用任务没有进入等待许可状态。',
      },
      agentNow(state),
    );
  }
  return viewOperation(state, operationId);
}

export async function resumeApplyOperation(
  state: AgentState,
  input: { operationId: string; actionRequestId: string; grantId: string },
): Promise<ServiceResult<AgentOperationView>> {
  const current = getOperation(state, input.operationId);
  if (!current) {
    return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
  }
  if (current.operation.status !== 'awaiting_approval') {
    return { ok: false, error: { code: 'OPERATION_TERMINAL', message: '任务不在等待许可状态。' } };
  }
  const pendingCalls = state.pendingCallsByOperation.get(input.operationId);
  const baseContext = state.executionContextByOperation.get(input.operationId);
  if (!pendingCalls || pendingCalls.length === 0 || !baseContext) {
    return { ok: false, error: { code: 'INVALID_OPERATION_STATE', message: '任务缺少待执行动作。' } };
  }

  const now = agentNow(state);
  const resumed = state.operations.resume(input.operationId, now, 'awaiting_approval');
  if (!resumed.ok) {
    return {
      ok: false,
      error: resumed.error ?? { code: 'OPERATION_TERMINAL', message: '任务不能恢复。' },
    };
  }
  const leaseToken = newLeaseToken();
  const claimed = state.operations.claim(input.operationId, leaseToken, now, LEASE_SECONDS);
  if (!claimed.ok) {
    return {
      ok: false,
      error: claimed.error ?? { code: 'OPERATION_LEASE_FAILED', message: '无法领取任务。' },
    };
  }

  const context: ToolExecutionContext = {
    ...baseContext,
    now,
    actionRequestId: input.actionRequestId,
    grantId: input.grantId,
    metadata: {
      ...(baseContext.metadata ?? {}),
      actionRequestId: input.actionRequestId,
      grantId: input.grantId,
    },
  };
  const batch = await state.gateway.executeBatch(pendingCalls, context);

  const existingResults = state.toolResultsByOperation.get(input.operationId) ?? [];
  state.toolResultsByOperation.set(input.operationId, [...existingResults, ...batch.results]);
  const existingSteps = state.stepsByOperation.get(input.operationId) ?? [];
  state.stepsByOperation.set(input.operationId, [
    ...existingSteps,
    {
      stepIndex: existingSteps.length,
      turn: modelTurn([], undefined),
      toolResults: batch.results,
    },
  ]);

  const applied = batch.results.find(
    (result) => result.status === 'succeeded' && result.mutationId,
  );
  if (batch.status !== 'failed' && applied?.mutationId) {
    const appliedValue =
      applied.result && typeof applied.result === 'object'
        ? (applied.result as Record<string, unknown>)
        : {};
    state.operations.complete(
      input.operationId,
      leaseToken,
      {
        kind: 'agent_result',
        actionRequestId: input.actionRequestId,
        mutationId: applied.mutationId,
        committedActionRefs: [applied.mutationId],
        snapshotRevision: appliedValue.revision ?? null,
      },
      agentNow(state),
    );
  } else {
    const failure = batch.results.find((result) => result.error)?.error;
    state.operations.fail(
      input.operationId,
      leaseToken,
      { code: failure?.code ?? 'ACTION_FAILED', message: failure?.message ?? '动作执行失败。' },
      agentNow(state),
    );
  }

  // 终态后清掉检查点：这些表按任务分片，留着只会让内存无限增长。
  state.pendingCallsByOperation.delete(input.operationId);
  state.executionContextByOperation.delete(input.operationId);
  state.pendingActionsByOperation.delete(input.operationId);
  return { ok: true, value: viewOperation(state, input.operationId) };
}
