/** 模型供应商适配器契约；真实供应商实现必须保留 callId 与 usage。 */

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  toolCallId?: string;
  toolName?: string;
  [key: string]: unknown;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface ModelTurn {
  text?: string;
  /** Provider replay state, server-only; never presented as the user answer. */
  reasoningContent?: string;
  providerReplay?: { format: string; model: string; items: Record<string, unknown>[] };
  toolCalls: ModelToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage: ModelUsage;
  error?: { code: string; message: string };
}

export interface ModelTurnRequest {
  messages: readonly ModelMessage[];
  tools: readonly ModelToolDefinition[];
  maxOutputTokens?: number;
  /** Local request deadline, used for a bounded retry after a truncated model turn. */
  timeoutMs?: number;
  /** Cancel this turn, including pending response-body consumption. */
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly thinking?: import('./model-controls.js').ModelThinkingView;
  readonly controls?: import('./model-controls.js').ModelControls;
  withThinking?(mode: import('./model-controls.js').ThinkingMode, effort?: import('./model-controls.js').ThinkingEffort): ModelProvider;
  generateTurn(request: ModelTurnRequest): Promise<ModelTurn>;
}

/** 测试与离线演示用脚本模型；明确不代表真实 LLM 验收。 */
export class ScriptedModelProvider implements ModelProvider {
  readonly providerName = 'scripted';

  readonly modelName = 'scripted-demo-v1';

  private readonly turns: ModelTurn[];

  /**
   * 脚本模型。`turns` 是预先写好的回合序列，按顺序消耗。
   * 第二个参数保留是为了兼容既有调用方（它们会传入时钟），当前实现不使用它。
   */
  constructor(turns: readonly ModelTurn[], _now: () => string = () => new Date().toISOString()) {
    this.turns = turns.map((turn) => ({ ...turn }));
  }

  async generateTurn(_request: ModelTurnRequest): Promise<ModelTurn> {
    const turn = this.turns.shift();
    if (!turn) {
      return {
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    return turn;
  }
}

export function toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): ModelToolCall {
  return { callId, name, arguments: args };
}

export function modelTurn(
  toolCalls: ModelToolCall[],
  text?: string,
  usage: ModelUsage = { inputTokens: 0, outputTokens: 0 },
): ModelTurn {
  return {
    text,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage,
  };
}

/** Keep provider continuation state in the server transcript, separate from prose. */
export function modelAssistantMessage(turn: ModelTurn): ModelMessage {
  return {role:'assistant',content:turn.text,...(turn.toolCalls.length?{toolCalls:turn.toolCalls}:{}),
    ...(turn.reasoningContent?{reasoningContent:turn.reasoningContent}:{}),...(turn.providerReplay?{providerReplay:turn.providerReplay}:{})};
}
