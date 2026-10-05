/**
 * 发起规划任务（初次排程或局部重排）。
 *
 * 流程：创建任务 → 带租约领取 → **预算预占** → 跑模型回合循环 → 按结果落终态。
 * 预占必须在发外部请求之前：额度不足时任务直接失败，不发出任何调用。
 */
import { AgentRuntime, type AgentRunResult } from '../runtime.js';
import { modelTurn, toolCall, ScriptedModelProvider } from '../../providers/model.js';
import type { ModelProvider, ModelTurn } from '../../providers/model.js';
import type { Operation } from '../../domain/types.js';
import { agentNow, type AgentState } from '../state.js';
import type { AgentOperationView, StartAgentOperationInput } from '../contracts.js';
import {
  LEASE_SECONDS,
  actionRequestsFor,
  approvalDeadline,
  newLeaseToken,
  newOperationId,
  releaseReservations,
  viewOperation,
} from './shared.js';

export function buildScript(state: AgentState, input: StartAgentOperationInput): ModelProvider {
  const turns: ModelTurn[] = [
    modelTurn([toolCall('call_read', 'trip.read', { tripId: input.tripId })], undefined, {
      inputTokens: 20,
      outputTokens: 8,
    }),
    modelTurn(
      [
        toolCall('call_propose', 'plan.propose', {
          kind: input.kind,
          baseRevision: input.baseRevision,
          contextSnapshotId: input.contextSnapshotId ?? null,
          eventType: input.event?.type ?? null,
        }),
      ],
      undefined,
      { inputTokens: 40, outputTokens: 16 },
    ),
    modelTurn(
      [],
      input.kind === 'initial' ? '已生成初始方案，请确认差异后采用。' : '已生成调整方案，请确认具体变化。',
      { inputTokens: 20, outputTokens: 10 },
    ),
  ];
  const provider = state.options.modelProviderForActor ? state.options.modelProviderForActor(input.actorId) : state.modelProvider;
  return provider ?? new ScriptedModelProvider(turns, () => agentNow(state));
}

export function proposalIdFromRun(runResult: AgentRunResult): string | undefined {
  const proposeStep = runResult.steps.find((step) =>
    step.turn.toolCalls.some((call) => call.name === 'plan.propose'),
  );
  const proposeResult = proposeStep?.toolResults.find(
    (result) => result.toolName === 'plan.propose',
  );
  const value = proposeResult?.result;
  return value && typeof value === 'object' && typeof (value as { proposalId?: unknown }).proposalId === 'string'
    ? (value as { proposalId: string }).proposalId
    : undefined;
}

export async function startOperation(
  state: AgentState,
  input: StartAgentOperationInput,
): Promise<AgentOperationView> {
  const now = agentNow(state);
  const operationId = newOperationId();
  const leaseToken = newLeaseToken();
  const operation: Operation = {
    operationId,
    tripId: input.tripId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    kind: input.kind === 'initial' ? 'initial_plan' : 'replan',
    status: 'queued',
    phase: 'queued',
    baseRevision: input.baseRevision,
    expectedRevision: input.baseRevision,
    contextId: input.contextSnapshotId ?? null,
    createdAt: now,
    updatedAt: now,
    usageTotals: {},
  };
  const created = state.operations.create(operation);
  if (!created.ok || !created.operation) {
    throw new Error(created.error?.message ?? '创建任务失败。');
  }
  const claimed = state.operations.claim(operationId, leaseToken, now, LEASE_SECONDS);
  if (!claimed.ok) throw new Error(claimed.error?.message ?? '领取任务失败。');

  // 预算在发外部请求之前预占；额度不足时任务直接落到失败态，不发出请求。
  let modelReservationId: string | undefined;
  let toolReservationId: string | undefined;
  if (state.externalBudget) {
    const modelReservation = state.externalBudget.reserve('model_requests', 6, now);
    if (!modelReservation.ok) {
      state.operations.fail(
        operationId,
        leaseToken,
        {
          code: 'BUDGET_EXHAUSTED',
          message: modelReservation.message ?? '模型调用额度已耗尽。',
        },
        now,
      );
      return viewOperation(state, operationId);
    }
    modelReservationId = modelReservation.reservationId;
    const toolReservation = state.externalBudget.reserve('tool_calls', 12, now);
    if (!toolReservation.ok) {
      state.externalBudget.release(modelReservationId!);
      state.operations.fail(
        operationId,
        leaseToken,
        {
          code: 'BUDGET_EXHAUSTED',
          message: toolReservation.message ?? '工具调用额度已耗尽。',
        },
        now,
      );
      return viewOperation(state, operationId);
    }
    toolReservationId = toolReservation.reservationId;
  }

  const model = buildScript(state, input);
  let runResult: AgentRunResult;
  try {
    runResult = await new AgentRuntime(state.gateway).run({
      operationId,
      messages: [
        ...(input.userText !== undefined ? [{ role: 'system' as const, content: `你是伴途旅行助手。当前旅行 ${input.tripId}，计划版本 ${input.baseRevision}。先读取行程并按需要查询资料，再回答或生成候选。保持用户原有约束；信息不足时提问，未知事实不要编造。当前仅可查询和提出方案，不能声称已修改行程。方案需用户明确许可后才能应用。` }, ...(input.conversation ?? [])] : []),
        {
          role: 'user',
          content: input.userText ?? (
            input.kind === 'initial'
              ? '生成一份一日初始方案，先查资料再提案。'
              : `用户报告：${JSON.stringify(input.event ?? { type: 'rest_requested' })}`),
        },
      ],
      // 规划任务只允许只读工具 + 提案；写工具留给应用任务。
      allowedTools: ['trip.read', 'places.search', 'routes.estimate', 'plan.propose'],
      context: {
        actorId: input.actorId,
        sessionId: input.sessionId,
        tripId: input.tripId,
        allowedToolNames: ['trip.read', 'places.search', 'routes.estimate', 'plan.propose'],
        now,
        metadata: {
          contextSnapshotId: input.contextSnapshotId ?? null,
          event: input.event ?? null,
        },
      },
      model,
      gateway: state.gateway,
      budget: { maxModelCalls: 6, maxToolCalls: 12 },
    });
  } catch (error) {
    // 供应商直接抛异常时必须释放预占并让任务落到失败态：
    // 否则额度会被永久占用（used() 仍计入 reserved），任务也会永远停在 running。
    releaseReservations(state, modelReservationId, toolReservationId);
    state.operations.fail(
      operationId,
      leaseToken,
      { code: 'AGENT_FAILED', message: (error as Error).message || '模型调用失败。' },
      agentNow(state),
    );
    return viewOperation(state, operationId);
  }

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
  // 结算按实际用量：模型按回合数、工具按实际调用数。
  if (state.externalBudget && modelReservationId) {
    state.externalBudget.settle(modelReservationId, runResult.steps.length, agentNow(state));
  }
  if (state.externalBudget && toolReservationId) {
    state.externalBudget.settle(
      toolReservationId,
      runResult.steps.reduce((total, step) => total + step.toolResults.length, 0),
      agentNow(state),
    );
  }

  const proposalId = proposalIdFromRun(runResult);
  if (runResult.status === 'succeeded' && proposalId) {
    state.operations.complete(
      operationId,
      leaseToken,
      { kind: 'proposal', proposalId },
      agentNow(state),
    );
  } else if (runResult.status === 'succeeded' && input.userText !== undefined) {
    state.operations.complete(operationId, leaseToken, { kind: 'agent_result' }, agentNow(state));
  } else if (runResult.status === 'awaiting_approval') {
    state.operations.pause(operationId, leaseToken, 'awaiting_approval', {
      now: agentNow(state),
      waitUntil: approvalDeadline(now),
    });
    state.pendingActionsByOperation.set(
      operationId,
      actionRequestsFor(state, runResult.pendingActionRequestIds),
    );
  } else {
    state.operations.fail(
      operationId,
      leaseToken,
      runResult.error ?? { code: 'AGENT_FAILED', message: 'Agent 任务失败。' },
      agentNow(state),
    );
  }

  return viewOperation(state, operationId);
}
