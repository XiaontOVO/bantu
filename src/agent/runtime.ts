import type {
  ModelMessage,
  ModelProvider,
  ModelTurn,
  ModelUsage,
} from '../providers/model.js';
import {modelAssistantMessage} from '../providers/model.js';
import { ToolGateway, type ToolExecutionContext, type ToolExecutionResult } from './tools.js';

export interface AgentBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxModelCalls: 6,
  maxToolCalls: 12,
  maxInputTokens: 32000,
  maxOutputTokens: 2048,
};

export interface AgentStep {
  stepIndex: number;
  turn: ModelTurn;
  toolResults: ToolExecutionResult[];
}

export interface AgentRunInput {
  operationId: string;
  messages: ModelMessage[];
  allowedTools: string[];
  context: ToolExecutionContext;
  model: ModelProvider;
  gateway: ToolGateway;
  budget?: Partial<AgentBudget>;
}

export interface AgentRunResult {
  status: 'succeeded' | 'awaiting_approval' | 'failed';
  messages: ModelMessage[];
  steps: AgentStep[];
  usage: ModelUsage;
  pendingActionRequestIds: string[];
  error?: { code: string; message: string };
}

function addUsage(total: ModelUsage, turn: ModelUsage): ModelUsage {
  return {
    inputTokens: total.inputTokens + (turn.inputTokens ?? 0),
    outputTokens: total.outputTokens + (turn.outputTokens ?? 0),
    ...(total.reasoningTokens!==undefined||turn.reasoningTokens!==undefined?{reasoningTokens:(total.reasoningTokens ?? 0)+(turn.reasoningTokens ?? 0)}:{}),
  };
}

/**
 * 持久化任务的最小运行时循环：
 * 模型回合 → 工具网关 → 结构化结果 → 下一轮模型；写调用进入 awaiting_approval。
 *
 * 生产适配层应在每步后保存 checkpoint、callId 与完整结果组；
 * 本实现保留同样的循环顺序，便于替换为数据库存储。
 */
export class AgentRuntime {
  constructor(private readonly gateway: ToolGateway) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const budget: AgentBudget = { ...DEFAULT_AGENT_BUDGET, ...(input.budget ?? {}) };
    const messages = [...input.messages];
    const steps: AgentStep[] = [];
    const pendingActionRequestIds: string[] = [];
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    let modelCalls = 0;
    let toolCalls = 0;

    if (budget.maxModelCalls <= 0 || budget.maxToolCalls < 0) {
      return {
        status: 'failed',
        messages,
        steps,
        usage,
        pendingActionRequestIds,
        error: { code: 'BUDGET_EXHAUSTED', message: '任务模型预算不足。' },
      };
    }

    while (modelCalls < budget.maxModelCalls) {
      if (usage.inputTokens >= budget.maxInputTokens || usage.outputTokens >= budget.maxOutputTokens) {
        return {
          status: 'failed',
          messages,
          steps,
          usage,
          pendingActionRequestIds,
          error: { code: 'BUDGET_EXHAUSTED', message: '任务 token 预算已耗尽。' },
        };
      }

      const turn = await input.model.generateTurn({
        messages,
        tools: this.gateway.listDefinitions(input.allowedTools),
        maxOutputTokens: Math.min(2048, budget.maxOutputTokens - usage.outputTokens),
      });
      modelCalls += 1;
      usage = addUsage(usage, turn.usage);

      if (turn.error || turn.finishReason === 'error') {
        steps.push({ stepIndex: steps.length, turn, toolResults: [] });
        return {
          status: 'failed',
          messages,
          steps,
          usage,
          pendingActionRequestIds,
          error: turn.error ?? { code: 'MODEL_ERROR', message: '模型返回错误。' },
        };
      }

      if (turn.toolCalls.length === 0) {
        steps.push({ stepIndex: steps.length, turn, toolResults: [] });
        if (turn.text) messages.push(modelAssistantMessage(turn));
        return {
          status: 'succeeded',
          messages,
          steps,
          usage,
          pendingActionRequestIds,
        };
      }

      if (toolCalls + turn.toolCalls.length > budget.maxToolCalls) {
        steps.push({ stepIndex: steps.length, turn, toolResults: [] });
        return {
          status: 'failed',
          messages,
          steps,
          usage,
          pendingActionRequestIds,
          error: { code: 'BUDGET_EXHAUSTED', message: '工具调用预算已耗尽。' },
        };
      }

      toolCalls += turn.toolCalls.length;
      const batch = await this.gateway.executeBatch(turn.toolCalls, input.context);
      steps.push({ stepIndex: steps.length, turn, toolResults: batch.results });
      // OpenAI-compatible 供应商要求 role:'tool' 的消息紧跟在带 tool_calls 的助手消息之后；
      // 缺少这条助手消息时第二次模型调用会被供应商拒绝（HTTP 400）。
      messages.push(modelAssistantMessage(turn));

      for (const result of batch.results) {
        messages.push({
          role: 'tool',
          toolCallId: result.callId,
          toolName: result.toolName,
          content: JSON.stringify({
            status: result.status,
            result: result.result,
            error: result.error,
            actionRequestId: result.actionRequestId,
          }),
        });
        if (result.actionRequestId && result.status === 'awaiting_approval') {
          pendingActionRequestIds.push(result.actionRequestId);
        }
      }

      if (batch.status === 'awaiting_approval') {
        return {
          status: 'awaiting_approval',
          messages,
          steps,
          usage,
          pendingActionRequestIds: [...new Set(pendingActionRequestIds)],
        };
      }
      // 工具失败结果会回传给模型，允许在预算内换策略；模型不调用工具时正常结束。
    }

    return {
      status: 'failed',
      messages,
      steps,
      usage,
      pendingActionRequestIds,
      error: { code: 'BUDGET_EXHAUSTED', message: '模型调用次数已达到任务上限。' },
    };
  }
}
