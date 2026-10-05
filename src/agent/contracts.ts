/**
 * AgentService 的对外契约。
 *
 * 与 `services/trip/contracts.ts` 一样：这里只放类型，不放实现，
 * 这样 http 层与工具目录都能引用契约而不必把服务实现拉进依赖图。
 */
import type { ActionRequest, Operation } from '../domain/types.js';
import type { ModelProvider, ModelMessage } from '../providers/model.js';
import type { PlaceProvider, RouteProvider, WeatherProvider } from '../providers/travel.js';
import type { ExternalBudgetLedger } from '../services/external-budget.js';
import type { AgentStep } from './runtime.js';
import type { ToolExecutionResult } from './tools.js';

export interface AgentServiceOptions {
  now?: () => string;
  placeProvider?: PlaceProvider;
  routeProvider?: RouteProvider;
  weatherProvider?: WeatherProvider;
  modelProvider?: ModelProvider;
  modelProviderForActor?: (actorId: string) => ModelProvider | undefined;
  externalBudget?: ExternalBudgetLedger;
}

/** 发起一次规划任务（初次排程或局部重排）。 */
export interface StartAgentOperationInput {
  actorId: string;
  sessionId: string;
  tripId: string;
  baseRevision: number;
  kind: 'initial' | 'replan';
  contextSnapshotId?: string | null;
  event?: Record<string, unknown>;
  /** 自然语言原文与服务端读取的会话历史，不能替换为关键词标签。 */
  userText?: string;
  conversation?: ModelMessage[];
}

/** 发起一次"采用方案"的任务；缺许可时它会停在 awaiting_approval。 */
export interface StartApplyOperationInput {
  actorId: string;
  sessionId: string;
  tripId: string;
  proposalId: string;
  candidateId: string;
  expectedRevision: number;
  idempotencyKey?: string;
}

export interface AgentOperationView {
  operation: Operation;
  steps: AgentStep[];
  pendingActionRequests: ActionRequest[];
  toolExecutions: ToolExecutionResult[];
}
