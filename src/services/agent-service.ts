/**
 * 可持久化（当前为内存实现）的 Agent 任务服务。
 *
 * 完成 docs/02 §5–§6 中“initial/replan 任务 → 工具循环 → 待选提案”的最小闭环：
 * - operation 状态经过 queued/running/succeeded 或 failed；
 * - 只读工具可自主调用，plan.propose 只创建待选提案，不修改正式计划；
 * - 写工具仍需 ActionAuthorizationService 的一次性许可，后续任务可恢复。
 */

import type { ActionRequest } from '../domain/types.js';
import type { ModelToolCall } from '../providers/model.js';
import type { PlaceProvider, RouteProvider, WeatherProvider } from '../providers/travel.js';
import { DemoPlaceProvider, DemoRouteProvider } from '../providers/travel.js';
import type { AgentStep } from '../agent/runtime.js';
import { ToolGateway, type ToolExecutionContext, type ToolExecutionResult } from '../agent/tools.js';
import { registerToolCatalog } from '../agent/tool-catalog.js';
import { OperationStore } from '../domain/operations.js';
import {
  InMemoryTripService,
  type ServiceResult,
} from './trip-service.js';

export * from '../agent/contracts.js';
import type {
  AgentOperationView,
  AgentServiceOptions,
  StartAgentOperationInput,
  StartApplyOperationInput,
} from '../agent/contracts.js';
import { agentNow, type AgentState } from '../agent/state.js';
import {
  resumeApplyOperation,
  startApplyOperation,
  startOperation,
  viewOperation,
} from '../agent/operations/index.js';
import { loadAgentSerialized, serializeAgent } from '../agent/persistence.js';

export class AgentService {
  setModelProvider(provider: import('../providers/model.js').ModelProvider | undefined): void {
    this.state.modelProvider = provider;
  }
  readonly operations = new OperationStore();

  private readonly gateway: ToolGateway;

  private readonly placeProvider: PlaceProvider;

  private readonly routeProvider: RouteProvider;

  private readonly weatherProvider?: WeatherProvider;

  private readonly stepsByOperation = new Map<string, AgentStep[]>();

  private readonly toolResultsByOperation = new Map<string, ToolExecutionResult[]>();

  private readonly pendingActionsByOperation = new Map<string, ActionRequest[]>();

  private readonly pendingCallsByOperation = new Map<string, ModelToolCall[]>();

  private readonly executionContextByOperation = new Map<string, ToolExecutionContext>();

  /**
   * 功能分区模块看到的共享状态；与上面的字段指向同一批对象。
   * 后续把任务编排／审批恢复／持久化外迁时，它们只依赖这个对象。
   */
  private readonly state: AgentState;

  constructor(
    private readonly tripService: InMemoryTripService,
    private readonly options: AgentServiceOptions = {},
  ) {
    this.placeProvider = options.placeProvider ?? new DemoPlaceProvider();
    this.routeProvider = options.routeProvider ?? new DemoRouteProvider();
    this.weatherProvider = options.weatherProvider;
    this.gateway = new ToolGateway(tripService.authorization);
    this.state = {
      tripService: this.tripService,
      options: this.options,
      operations: this.operations,
      gateway: this.gateway,
      // 这两个是可选的，但**必须**显式带上：漏掉时它们会静默变成 undefined，
      // 表现为"配了预算台账却不生效"，而不是编译错误。
      modelProvider: options.modelProvider,
      externalBudget: options.externalBudget,
      stepsByOperation: this.stepsByOperation,
      toolResultsByOperation: this.toolResultsByOperation,
      pendingActionsByOperation: this.pendingActionsByOperation,
      pendingCallsByOperation: this.pendingCallsByOperation,
      executionContextByOperation: this.executionContextByOperation,
    };
    this.registerTools();
  }

  private now(): string {
    return agentNow(this.state);
  }

  private registerTools(): void {
    registerToolCatalog({
      gateway: this.gateway,
      tripService: this.tripService,
      placeProvider: this.placeProvider,
      routeProvider: this.routeProvider,
      weatherProvider: this.weatherProvider,
    });
  }

  /** 失败路径统一释放预占，避免额度被 reserved 记录永久占用。 */
  async start(input: StartAgentOperationInput): Promise<AgentOperationView> {
    return startOperation(this.state, input);
  }

  async startApply(input: StartApplyOperationInput): Promise<AgentOperationView> {
    return startApplyOperation(this.state, input);
  }

  async resumeApply(input: {
    operationId: string;
    actionRequestId: string;
    grantId: string;
  }): Promise<ServiceResult<AgentOperationView>> {
    return resumeApplyOperation(this.state, input);
  }

  get(operationId: string): AgentOperationView | null {
    if (!this.operations.get(operationId)) return null;
    return this.view(operationId);
  }

  /** 当前注册给模型/Agent 的完整工具目录（不含未配置的可选天气工具）。 */
  listToolDefinitions(allowed?: readonly string[]): ReturnType<ToolGateway['listDefinitions']> {
    return this.gateway.listDefinitions(allowed);
  }

  /** 找到等待指定 actionRequest 的 Agent 任务，用于文字确认后直接恢复。 */
  findAwaitingOperationForAction(
    tripId: string,
    actionRequestId: string,
  ): AgentOperationView | null {
    for (const operation of this.operations.list()) {
      if (operation.tripId !== tripId || operation.status !== 'awaiting_approval') continue;
      const pending = this.pendingActionsByOperation.get(operation.operationId) ?? [];
      if (pending.some((request) => request.actionRequestId === actionRequestId)) {
        return this.view(operation.operationId);
      }
    }
    return null;
  }

  private view(operationId: string): AgentOperationView {
    return viewOperation(this.state, operationId);
  }

  /** 当前原型中 plan.propose 为只读工具，任务同步完成；此方法保留 Worker 恢复入口。 */
  /** 取消某旅行的未终结任务，并失效关联待许可；用于删除旅行。 */
  cancelForTrip(tripId: string, now = this.now()): number {
    let cancelled = 0;
    for (const operation of this.operations.list()) {
      if (operation.tripId !== tripId) continue;
      const result = this.operations.cancel(operation.operationId, now);
      if (result.ok) cancelled += 1;
    }
    this.tripService.authorization.invalidateScope({ tripId, now });
    for (const [operationId, requests] of this.pendingActionsByOperation) {
      if (this.operations.get(operationId)?.tripId === tripId) {
        this.pendingActionsByOperation.delete(operationId);
        for (const request of requests) {
          this.tripService.authorization.revoke(request.actionRequestId, now);
        }
      }
    }
    return cancelled;
  }

  /** 本地持久化 Agent operation、检查点与待执行调用，供进程重启恢复。 */
  serialize(): string {
    return serializeAgent(this.state);
  }

  loadSerialized(serialized: string): void {
    loadAgentSerialized(this.state, serialized);
  }

  /** 原型中 plan.propose 为只读工具、任务同步完成；此方法保留 Worker 恢复入口。 */
  async resume(operationId: string): Promise<ServiceResult<AgentOperationView>> {
    if (!this.operations.get(operationId)) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    return { ok: true, value: this.view(operationId) };
  }
}

