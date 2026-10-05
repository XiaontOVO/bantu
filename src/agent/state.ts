/**
 * AgentService 的共享状态。
 *
 * 与服务层同样的做法：把状态收进这个对象后，任务编排、审批恢复、持久化
 * 可以作为独立模块接收 `AgentState` 工作，而不必挤在同一个类里。
 *
 * 五张 `*ByOperation` 表都是**按任务分片**的检查点：
 * 它们是"任务离开进程后还能接着跑"的依据，因此序列化时必须一起落盘。
 */
import type { ActionRequest } from '../domain/types.js';
import type { ModelProvider, ModelToolCall } from '../providers/model.js';
import type { OperationStore } from '../domain/operations.js';
import type { AgentStep } from './runtime.js';
import type { ToolExecutionContext, ToolExecutionResult, ToolGateway } from './tools.js';
import type { AgentServiceOptions } from './contracts.js';
import type { ExternalBudgetLedger } from '../services/external-budget.js';
import type { InMemoryTripService } from '../services/trip-service.js';

export interface AgentState {
  tripService: InMemoryTripService;
  options: AgentServiceOptions;
  operations: OperationStore;
  gateway: ToolGateway;
  /** 未配置时用脚本模型跑演示；配置后是真实供应商适配器。 */
  modelProvider?: ModelProvider;
  /** 外部调用预算台账；未配置时不预占、不结算。 */
  externalBudget?: ExternalBudgetLedger;
  /** 工具循环的中间产物：每一步的模型回合与工具结果。 */
  stepsByOperation: Map<string, AgentStep[]>;
  toolResultsByOperation: Map<string, ToolExecutionResult[]>;
  /** 待用户确认的动作：任务停在这里等许可。 */
  pendingActionsByOperation: Map<string, ActionRequest[]>;
  /** 正在等待的写工具调用：批准后要按原参数重放。 */
  pendingCallsByOperation: Map<string, ModelToolCall[]>;
  /** 恢复执行所需的主体/会话/旅行上下文。 */
  executionContextByOperation: Map<string, ToolExecutionContext>;
}

/** 统一时钟：测试通过 options.now 注入固定时间。 */
export function agentNow(state: AgentState): string {
  return state.options.now?.() ?? new Date().toISOString();
}
