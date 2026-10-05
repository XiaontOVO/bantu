/** Fixed public guidance only; provider messages and reasoning are never shown. */
export function personalAgentModelFailureMessage(code?: string): string {
  switch(code) {
    case 'MODEL_THINKING_UNSUPPORTED': return '当前模型拒绝关闭思考。请在 AI 设置中更换支持关闭的模型，或由你选择开启思考后继续。';
    case 'MODEL_CONTEXT_LIMIT': return '当前模型的原生上下文容量不足，本次任务尚未完成。请开启新对话，或在 AI 设置中选择容量足够的模型后重新委托；已经保存的操作会保留。';
    case 'MODEL_TIMEOUT': return '模型等待超时，后续处理尚未完成。可稍后继续处理；已经保存的操作会保留。';
    case 'MODEL_BAD_TOOL_ARGS': return '模型生成的操作参数无效，本轮操作未执行。请补充或简化指令后重试；已经保存的操作会保留。';
    case 'MODEL_EMPTY_RESPONSE': return '模型没有返回有效回复或可执行操作，后续处理尚未完成。请稍后重试；已经保存的操作会保留。';
    case 'MODEL_REFUSAL': case 'MODEL_CONTENT_FILTERED': return '模型拒绝处理本轮请求，后续任务尚未完成。可调整请求或更换模型后重试；已经保存的操作会保留。';
    case 'MODEL_ABORTED': return '本轮模型请求已取消，后续处理尚未完成；已经保存的操作会保留。';
    default: return '模型暂时无法继续处理，请稍后继续。';
  }
}
