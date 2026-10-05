/**
 * Agent 检查点的本地序列化与恢复。
 *
 * 落盘的不只是任务本身，还有五张按任务分片的检查点表——它们是
 * "进程重启后任务还能接着跑"的依据。少存一张，恢复出来的任务就会缺上下文，
 * 表现成"审批后无事发生"而不是明确报错。
 *
 * 这是离线恢复演练用的实现，不替代生产 PostgreSQL；两者必须保持同一套语义。
 */
import type { ActionRequest, Operation } from '../domain/types.js';
import type { ModelToolCall } from '../providers/model.js';
import type { AgentStep } from './runtime.js';
import type { ToolExecutionContext, ToolExecutionResult } from './tools.js';
import type { AgentState } from './state.js';

interface SerializedAgent {
  operations?: Operation[];
  stepsByOperation?: Array<[string, AgentStep[]]>;
  toolResultsByOperation?: Array<[string, ToolExecutionResult[]]>;
  pendingActionsByOperation?: Array<[string, ActionRequest[]]>;
  pendingCallsByOperation?: Array<[string, ModelToolCall[]]>;
  executionContextByOperation?: Array<[string, ToolExecutionContext]>;
}

export function serializeAgent(state: AgentState): string {
  return JSON.stringify({
    // 直接取列表：这里每次落盘都会被调用，不必先序列化再反序列化一遍。
    operations: state.operations.list(),
    stepsByOperation: [...state.stepsByOperation.entries()],
    toolResultsByOperation: [...state.toolResultsByOperation.entries()],
    pendingActionsByOperation: [...state.pendingActionsByOperation.entries()],
    pendingCallsByOperation: [...state.pendingCallsByOperation.entries()],
    executionContextByOperation: [...state.executionContextByOperation.entries()],
  } satisfies SerializedAgent);
}

/** 用 [[key, value]] 形式覆盖一张检查点表；先清空，避免旧任务的残留与新状态混在一起。 */
function restoreMap<T>(target: Map<string, T>, entries: Array<[string, T]> | undefined): void {
  target.clear();
  for (const [key, value] of entries ?? []) target.set(key, value);
}

export function loadAgentSerialized(state: AgentState, serialized: string): void {
  const parsed = JSON.parse(serialized) as SerializedAgent;
  state.operations.loadSerialized(JSON.stringify(parsed.operations ?? []));
  restoreMap(state.stepsByOperation, parsed.stepsByOperation);
  restoreMap(state.toolResultsByOperation, parsed.toolResultsByOperation);
  restoreMap(state.pendingActionsByOperation, parsed.pendingActionsByOperation);
  restoreMap(state.pendingCallsByOperation, parsed.pendingCallsByOperation);
  restoreMap(state.executionContextByOperation, parsed.executionContextByOperation);
}
