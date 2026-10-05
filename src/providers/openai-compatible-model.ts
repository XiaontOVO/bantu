import {randomUUID} from 'node:crypto';
import type {ModelMessage, ModelProvider, ModelToolCall, ModelTurn, ModelTurnRequest, ModelUsage} from './model.js';
import {modelThinkingView, parseModelControls, thinkingParameters, type ModelControls, type ThinkingMode, type ThinkingEffort} from './model-controls.js';

export interface OpenAiCompatibleOptions extends ModelControls {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  providerName?: string;
  fetchImpl?: typeof fetch;
  /** 供应商兼容端点路径，默认 /chat/completions。 */
  completionsPath?: string;
  extraHeaders?: Record<string, string>;
  /** 默认单次请求期限；ModelTurnRequest.timeoutMs 可覆盖本轮期限。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const wireToolName = (name: string) => name.replace(/\./g, '__');
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function modelFailure(code: string, message: string, usage: ModelUsage = {inputTokens: 0, outputTokens: 0}): ModelTurn {
  return {toolCalls: [], finishReason: 'error', usage, error: {code, message}};
}
/** A missing argument string is malformed, even for a parameterless tool. */
function parseArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {const parsed: unknown = JSON.parse(value); return record(parsed) ? parsed : null;} catch {return null;}
}
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function usageFrom(payload: Record<string, unknown>, responses: boolean): ModelUsage {
  const usage = record(payload.usage) ? payload.usage : {};
  const details = responses ? usage.output_tokens_details : usage.completion_tokens_details;
  return {inputTokens: tokenCount(responses ? usage.input_tokens : usage.prompt_tokens),
    outputTokens: tokenCount(responses ? usage.output_tokens : usage.completion_tokens),
    ...(record(details) && typeof details.reasoning_tokens === 'number' ? {reasoningTokens: tokenCount(details.reasoning_tokens)} : {})};
}
function chatText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (Array.isArray(value) && value.every(item => record(item) && item.type === 'text' && typeof item.text === 'string')) {
    const text = value.map(item => item.text).join('\n');return text.trim() ? text : undefined;
  }
  return null;
}

/** Server-only compatible adapter. Upstream errors and reasoning never become answer prose. */
export class OpenAiCompatibleModelProvider implements ModelProvider {
  readonly providerName: string;
  readonly modelName: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.providerName = options.providerName ?? 'openai_compatible';
    this.modelName = options.modelName;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  get thinking() {return modelThinkingView(this.options);}
  get controls() {return parseModelControls({...this.options});}
  withThinking(thinking: ThinkingMode, thinkingEffort: ThinkingEffort = this.options.thinkingEffort ?? 'high') {
    return new OpenAiCompatibleModelProvider({...this.options, thinking, thinkingEffort});
  }

  private chatMessage(message: ModelMessage): Record<string, unknown> {
    if (message.role === 'tool') return {role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? ''};
    if (message.role !== 'assistant') return {role: message.role, content: message.content ?? ''};
    const replay = message.providerReplay as ModelTurn['providerReplay'];
    const compatibleReplay = !replay || (replay.model === this.modelName && replay.format === this.thinking.format);
    return {role: 'assistant', content: message.content ?? null,
      ...(compatibleReplay && this.thinking.mode === 'on' && typeof message.reasoningContent === 'string' && ['thinking-type', 'enable-thinking'].includes(this.thinking.format)
        ? {reasoning_content: message.reasoningContent} : {}),
      ...(compatibleReplay && this.thinking.mode === 'on' && this.thinking.format === 'reasoning-enabled' && Array.isArray(replay?.items) ? {reasoning_details: replay.items} : {}),
      ...(Array.isArray(message.toolCalls) && message.toolCalls.length ? {tool_calls: (message.toolCalls as ModelToolCall[]).map(call => ({
        id: call.callId, type: 'function', function: {name: wireToolName(call.name), arguments: JSON.stringify(call.arguments ?? {})},
      }))} : {})};
  }

  private responsesInput(messages: readonly ModelMessage[]): Record<string, unknown>[] {
    const input: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.role === 'tool') {input.push({type: 'function_call_output', call_id: message.toolCallId, output: message.content ?? ''});continue;}
      const replay = message.providerReplay as ModelTurn['providerReplay'];
      if (message.role === 'assistant' && replay?.format === 'responses' && replay.model === this.modelName && Array.isArray(replay.items)) {
        input.push(...replay.items);
        // Older checkpoints stored reasoning items only. Preserve their replay and
        // synthesize only visible/call items absent from that old checkpoint.
        const calls = new Set(replay.items.filter(item => item.type === 'function_call').map(item => item.call_id));
        if (!replay.items.some(item => item.type === 'message') && message.content) input.push({role: 'assistant', content: message.content});
        for (const call of Array.isArray(message.toolCalls) ? message.toolCalls as ModelToolCall[] : []) {
          if (!calls.has(call.callId)) input.push({type: 'function_call', call_id: call.callId, name: wireToolName(call.name), arguments: JSON.stringify(call.arguments)});
        }
        continue;
      }
      if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
        if (message.content) input.push({role: 'assistant', content: message.content});
        for (const call of message.toolCalls as ModelToolCall[]) input.push({type: 'function_call', call_id: call.callId, name: wireToolName(call.name), arguments: JSON.stringify(call.arguments)});
      } else input.push({role: message.role, content: message.content ?? ''});
    }
    return input;
  }

  private parseTurn(payload: unknown, request: ModelTurnRequest): ModelTurn {
    if (!record(payload)) return modelFailure('MODEL_BAD_RESPONSE', '模型响应不是有效 JSON 对象。');
    const responses = this.options.apiFormat === 'responses';
    const usage = usageFrom(payload, responses);
    let content: unknown, rawCalls: unknown, finish: unknown, reasoningContent: unknown, providerReplay: ModelTurn['providerReplay'];
    if (responses) {
      if (!Array.isArray(payload.output) || !payload.output.every(record) || !['completed', 'incomplete'].includes(String(payload.status))) {
        return modelFailure('MODEL_BAD_RESPONSE', 'Responses 接口没有返回已完成的有效输出。', usage);
      }
      const incomplete = record(payload.incomplete_details) ? payload.incomplete_details.reason : undefined;
      if (payload.status === 'incomplete' && incomplete !== undefined && incomplete !== 'max_output_tokens') {
        return modelFailure(incomplete === 'content_filter' ? 'MODEL_CONTENT_FILTERED' : 'MODEL_BAD_RESPONSE', '模型输出被中断，无法作为完成结果。', usage);
      }
      const output = payload.output;
      const text: string[] = [];
      for (const item of output.filter(item => item.type === 'message')) {
        if (payload.status === 'completed' && item.status !== undefined && item.status !== 'completed') return modelFailure('MODEL_BAD_RESPONSE', 'Responses 消息尚未完成。', usage);
        if (!Array.isArray(item.content) || !item.content.every(record)) return modelFailure('MODEL_BAD_RESPONSE', 'Responses 消息结构无效。', usage);
        for (const part of item.content) {
          if (part.type === 'refusal') return modelFailure('MODEL_REFUSAL', '模型拒绝处理本次请求；任务没有被确认完成。', usage);
          if (part.type === 'output_text') {
            if (typeof part.text !== 'string') return modelFailure('MODEL_BAD_RESPONSE', '模型文字结构无效。', usage);
            text.push(part.text);
          }
        }
      }
      content = text.join('\n');
      const functions = output.filter(item => item.type === 'function_call');
      if (functions.some(item => item.status !== undefined && item.status !== 'completed')) {
        return modelFailure(payload.status === 'incomplete' ? 'MODEL_TOOL_ARGS_TRUNCATED' : 'MODEL_BAD_TOOL_ARGS', '模型工具调用尚未完成，未执行本轮工具。', usage);
      }
      if (functions.some(item => typeof item.call_id !== 'string' || !item.call_id.trim())) return modelFailure('MODEL_BAD_TOOL_ARGS', 'Responses 工具调用缺少有效 call_id。', usage);
      rawCalls = functions.map(item => ({id: item.call_id, type: 'function', function: {name: item.name, arguments: item.arguments}}));
      finish = payload.status === 'incomplete' ? 'length' : 'stop';
      // Keep original order, IDs, status and opaque reasoning for stateless replay.
      if (output.length) providerReplay = {format: 'responses', model: this.modelName, items: output};
    } else {
      const choices = payload.choices;
      if (!Array.isArray(choices) || !record(choices[0]) || !record(choices[0].message)) return modelFailure('MODEL_BAD_RESPONSE', '模型响应缺少有效 choices 消息。', usage);
      const choice = choices[0], message = choice.message as Record<string, unknown>;
      finish = choice.finish_reason;
      if (finish === 'content_filter') return modelFailure('MODEL_CONTENT_FILTERED', '模型输出被内容过滤，任务没有被确认完成。', usage);
      if (typeof message.refusal === 'string' && message.refusal.trim()) return modelFailure('MODEL_REFUSAL', '模型拒绝处理本次请求；任务没有被确认完成。', usage);
      if (finish !== undefined && !['stop', 'tool_calls', 'length', 'function_call'].includes(String(finish))) return modelFailure('MODEL_BAD_RESPONSE', '模型没有返回有效的结束状态。', usage);
      content = message.content;
      rawCalls = message.tool_calls ?? [];
      reasoningContent = message.reasoning_content;
      if (Array.isArray(message.reasoning_details) && message.reasoning_details.every(record)) providerReplay = {format: 'reasoning-enabled', model: this.modelName, items: message.reasoning_details};
      else if (typeof reasoningContent === 'string' && reasoningContent) providerReplay = {format: this.thinking.format, model: this.modelName, items: []};
    }
    const text = chatText(content);
    if (text === null || !Array.isArray(rawCalls)) return modelFailure('MODEL_BAD_RESPONSE', '模型文字或工具调用结构无效。', usage);
    const toolCalls: ModelToolCall[] = [], seenIds = new Set<string>();
    for (const [index, call] of rawCalls.entries()) {
      const fn = record(call) && record(call.function) ? call.function : {};
      const name = fn.name, args = parseArguments(fn.arguments);
      if (!record(call) || (call.type !== undefined && call.type !== 'function') || typeof name !== 'string' || !/^[\w.-]+$/.test(name) || args === null) {
        return modelFailure(finish === 'length' && typeof name === 'string' && args === null ? 'MODEL_TOOL_ARGS_TRUNCATED' : 'MODEL_BAD_TOOL_ARGS', '模型工具调用缺少有效名称或合法 JSON 对象参数。', usage);
      }
      // A few Chat-compatible gateways omit IDs; generated IDs remain unique for
      // the complete transcript. Responses IDs are always required above.
      const callId = call.id === undefined ? `compat_${randomUUID()}_${index}` : call.id;
      if (typeof callId !== 'string' || !callId.trim() || seenIds.has(callId)) return modelFailure('MODEL_BAD_TOOL_ARGS', '模型工具调用编号为空或重复，无法安全回放。', usage);
      seenIds.add(callId);
      toolCalls.push({callId, name: request.tools.find(tool => wireToolName(tool.name) === name)?.name ?? name, arguments: args});
    }
    if (!text && !toolCalls.length && finish !== 'length') return modelFailure('MODEL_EMPTY_RESPONSE', '模型没有返回文字或可执行工具，任务尚未完成。', usage);
    if (['tool_calls', 'function_call'].includes(String(finish)) && !toolCalls.length) return modelFailure('MODEL_BAD_RESPONSE', '模型声明了工具调用但没有返回有效调用。', usage);
    if (toolCalls.length && finish === 'length') return modelFailure('MODEL_TOOL_ARGS_TRUNCATED', '模型输出达到长度限制，未执行本轮工具，请重新生成完整调用。', usage);
    return {text, ...(typeof reasoningContent === 'string' && reasoningContent ? {reasoningContent} : {}), ...(providerReplay ? {providerReplay} : {}), toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : finish === 'length' ? 'length' : 'stop', usage};
  }

  async generateTurn(request: ModelTurnRequest): Promise<ModelTurn> {
    if (request.signal?.aborted) return modelFailure('MODEL_ABORTED', '本轮模型请求已取消。');
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const outputTokens = request.maxOutputTokens ?? 2048;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(outputTokens) || outputTokens <= 0) {
      return modelFailure('MODEL_INVALID_REQUEST', '模型请求期限和输出预算必须为有效的正整数。');
    }
    const wireNames = request.tools.map(tool => wireToolName(tool.name));
    if (new Set(wireNames).size !== wireNames.length) return modelFailure('MODEL_INVALID_REQUEST', '工具名称在兼容协议中发生冲突，不能安全调用。');
    let parameters: Record<string, unknown>;
    try {parseModelControls({...this.options});} catch {return modelFailure('MODEL_INVALID_REQUEST', '模型接口或思考设置无效。');}
    const apiFormat = this.options.apiFormat ?? 'chat-completions';
    try {parameters = thinkingParameters(this.thinking, apiFormat);} catch (error) {
      // Only this local, validated protocol check can use its trusted message.
      return modelFailure('MODEL_THINKING_UNSUPPORTED', error instanceof Error ? error.message : '当前思考设置不可用。');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let externalCancelled = false;
    let cancelRequest: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {const error = new DOMException('Model deadline exceeded', 'TimeoutError');controller.abort(error);reject(error);}, timeoutMs);
      cancelRequest = () => {externalCancelled = true;const error = new DOMException('Model request cancelled', 'AbortError');controller.abort(error);reject(error);};
      request.signal?.addEventListener('abort', cancelRequest, {once: true});
    });
    try {
      const url = `${this.options.baseUrl.replace(/\/$/, '')}${this.options.completionsPath ?? (apiFormat === 'responses' ? '/responses' : '/chat/completions')}`;
      const chatTools = request.tools.map(tool => ({type: 'function', function: {name: wireToolName(tool.name), description: tool.description, parameters: tool.inputSchema}}));
      let body: Record<string, unknown> = {model: this.modelName, messages: request.messages.map(message => this.chatMessage(message)),
        ...(chatTools.length ? {tools: chatTools, tool_choice: 'auto'} : {}), max_tokens: outputTokens, ...parameters};
      if (this.thinking.format === 'reasoning-effort') {delete body.max_tokens;body.max_completion_tokens = outputTokens;}
      if (apiFormat === 'responses') body = {model: this.modelName, input: this.responsesInput(request.messages),
        ...(request.tools.length ? {tools: request.tools.map(tool => ({type: 'function', name: wireToolName(tool.name), description: tool.description, parameters: tool.inputSchema, strict: false})), tool_choice: 'auto'} : {}),
        max_output_tokens: outputTokens, store: false, include: ['reasoning.encrypted_content'], ...parameters};
      const response = await Promise.race([this.fetchImpl(url, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}`, ...(this.options.extraHeaders ?? {})}, body: JSON.stringify(body), signal: controller.signal}), deadline]);
      let payload: unknown;
      try {payload = await Promise.race([response.json(), deadline]);} catch (error) {
        if (controller.signal.aborted || (error as Error)?.name === 'AbortError' || (error as Error)?.name === 'TimeoutError') throw error;
        if (response.ok) {
          if ((error as Error)?.name === 'SyntaxError') return modelFailure('MODEL_BAD_RESPONSE', '模型响应无法解析为有效 JSON。');
          throw error;
        }
      }
      if (!response.ok) {
        const error = record(payload) && record(payload.error) ? payload.error : {};
        if (response.status === 400 && String(error.code) === '1210' && /不支持关闭思考/.test(String(error.message))) {
          return modelFailure('MODEL_THINKING_UNSUPPORTED', '当前模型拒绝关闭思考。请更换支持关闭的模型，或在 AI 设置中选择开启思考后继续。');
        }
        // Detect only established context errors. The 1M application history budget
        // does not expand the endpoint's native context; never expose raw prompts.
        if (['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long'].includes(String(error.code))) {
          return modelFailure('MODEL_CONTEXT_LIMIT', '本轮内容超过模型原生上下文上限；应用的 1M 历史预算不改变供应商限制。');
        }
        return modelFailure(`MODEL_HTTP_${response.status}`, `模型供应商返回 HTTP ${response.status}，请检查服务状态和 API 配置。`);
      }
      return this.parseTurn(payload, request);
    } catch (error) {
      const name = (error as Error)?.name;
      if (externalCancelled || request.signal?.aborted) return modelFailure('MODEL_ABORTED', '本轮模型请求已取消。');
      if (controller.signal.aborted || name === 'TimeoutError' || name === 'AbortError') return modelFailure('MODEL_TIMEOUT', `模型请求超时（${timeoutMs}ms）。`);
      return modelFailure('MODEL_NETWORK_ERROR', '模型连接失败，请检查网络和 API 配置。');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cancelRequest) request.signal?.removeEventListener('abort', cancelRequest);
    }
  }
}
