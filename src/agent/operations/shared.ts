/**
 * 任务编排的共享部分：句柄生成、租约时长、视图读取。
 *
 * 三个入口（start／startApply／resumeApply）都要用到这些；
 * 放在这里是为了让各入口模块只关心自己的流程，不重复实现句柄与视图。
 */
import { randomUUID } from 'node:crypto';
import type { ActionRequest } from '../../domain/types.js';
import type { AgentOperationView } from '../contracts.js';
import type { AgentState } from '../state.js';

export function newOperationId(): string {
  return `op_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function newLeaseToken(): string {
  return `lease_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function approvalDeadline(now: string): string {
  return new Date(Date.parse(now) + APPROVAL_WAIT_MS).toISOString();
}

export function releaseReservations(
  state: AgentState,
  ...reservationIds: Array<string | undefined>
): void {
  if (!state.externalBudget) return;
  for (const reservationId of reservationIds) {
    if (reservationId) state.externalBudget.release(reservationId);
  }
}

export function actionRequestsFor(
  state: AgentState,
  actionRequestIds: readonly string[],
): ActionRequest[] {
  return actionRequestIds
    .map((actionRequestId) => state.tripService.authorization.getRequest(actionRequestId))
    .filter((request): request is ActionRequest => Boolean(request));
}

export function viewOperation(state: AgentState, operationId: string): AgentOperationView {
  // 调用方负责先确认任务存在（get / findAwaitingOperationForAction 都做过了）。
  const operation = state.operations.get(operationId)!;
  return {
    operation,
    steps: (state.stepsByOperation.get(operationId) ?? []).map(step=>{
      const {reasoningContent,providerReplay,...turn}=step.turn;
      return {...step,turn};
    }),
    pendingActionRequests: state.pendingActionsByOperation.get(operationId) ?? [],
    toolExecutions: state.toolResultsByOperation.get(operationId) ?? [],
  };
}

export function getOperation(
  state: AgentState,
  operationId: string,
): AgentOperationView | null {
  if (!state.operations.get(operationId)) return null;
  return viewOperation(state, operationId);
}

export const LEASE_SECONDS = 15;

export const APPROVAL_WAIT_MS = 10 * 60 * 1000;
