/** 随行意图进入同一 Agent 对话；预览只读，采用必须来自用户点击的候选。 */
import type { ServerContext } from '../server/http/context.js';
import type { MessageRecord } from './message-service.js';
import { createCompanionAdvice, applyCompanionAdvice, validateCompanionAdjustmentTarget } from './companion-advice.js';
import { CompanionContextError } from './companion-context.js';

export interface AgentCompanionAdjustment {
  planId: string;
  expectedRevision: number;
  stopId: string;
  change: 'rest' | 'rain' | 'time' | 'replace';
  transportMode: 'walking' | 'transit' | 'driving';
  planName: string;
  localDate: string;
  status: 'needs_input' | 'preview' | 'unavailable' | 'applied' | 'cancelled' | 'superseded';
  candidates: Awaited<ReturnType<typeof createCompanionAdvice>>['candidates'];
  reasons: string[];
  selectedPreviewId?: string;
}

export async function runCompanionAgent(ctx: ServerContext, actorId: string, raw: unknown, location?: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CompanionContextError('INVALID_INPUT', '调整请求无效，请从首页重新选择。', 400);
  const request = raw as Record<string, unknown>;
  const action = request.action;
  let source: MessageRecord | undefined;
  let adjustment: AgentCompanionAdjustment;
  if (action === 'start') {
    if (typeof request.planId !== 'string' || typeof request.stopId !== 'string' || !Number.isInteger(request.expectedRevision)
      || !['rest', 'rain', 'time', 'replace'].includes(String(request.change)) || !['walking', 'driving', 'transit'].includes(String(request.transportMode))) {
      throw new CompanionContextError('INVALID_INPUT', '请选择有效的行程和调整意图。', 400);
    }
    const plan = ctx.planLibrary.list(actorId).find(item => item.id === request.planId && item.kind === 'plan');
    if (!plan) throw new CompanionContextError('PLAN_NOT_FOUND', '原行程已不可用，请回首页重新选择。', 404);
    validateCompanionAdjustmentTarget(ctx, actorId, plan.id, request.expectedRevision, request.stopId);
    adjustment = { planId: plan.id, expectedRevision: Number(request.expectedRevision), stopId: String(request.stopId),
      change: request.change as AgentCompanionAdjustment['change'], transportMode: request.transportMode as AgentCompanionAdjustment['transportMode'],
      planName: plan.name, localDate: plan.localDate!, status: 'needs_input', candidates: [], reasons: [] };
  } else if (['preview', 'apply', 'cancel'].includes(String(action))) {
    source = ctx.messageService.generalList(actorId).find(message => message.messageId === request.sourceMessageId && message.role === 'assistant');
    if (!source?.companionAdjustment) throw new CompanionContextError('COMPANION_STALE', '找不到这次调整对话，请从首页重新发起。');
    adjustment = structuredClone(source.companionAdjustment);
    if (adjustment.status === 'cancelled') throw new CompanionContextError('COMPANION_STALE', '这次调整已取消，请重新发起。');
  } else throw new CompanionContextError('INVALID_INPUT', '不支持的调整操作。', 400);

  if (action === 'cancel') {
    if (adjustment.status === 'applied') throw new CompanionContextError('COMPANION_STALE', '调整已经采用，不能再取消旧预览。');
    adjustment.status = 'cancelled';
    if (source) source.companionAdjustment = adjustment;
    return { reply: '已保留原安排。需要时再找我一起调整。', adjustment, refresh: [] as string[] };
  }
  if (action === 'apply') {
    const candidate = adjustment.candidates.find(item => item.previewId === request.previewId);
    if (!candidate || !['preview', 'applied'].includes(adjustment.status) || adjustment.selectedPreviewId && adjustment.selectedPreviewId !== candidate.previewId) throw new CompanionContextError('COMPANION_STALE', '这份候选已不可采用，请重新核对。');
    const receipt = applyCompanionAdvice(ctx, actorId, adjustment.planId, { previewId: candidate.previewId, expectedRevision: adjustment.expectedRevision,
      params: candidate.params, actionKey: `agent_${source!.messageId}_${candidate.previewId}`, ...(location ? { position: location } : {}) });
    adjustment.status = 'applied'; adjustment.selectedPreviewId = candidate.previewId;
    source!.companionAdjustment = adjustment;
    return { reply: `已采用「${candidate.title}」。首页随行将按新的后续安排继续，已有进度、预约及受保护费用已保留。`, adjustment, refresh: ['plans'], appliedRevision: receipt.appliedRevision };
  }
  if (action === 'preview' && adjustment.status !== 'needs_input') throw new CompanionContextError('COMPANION_STALE', '这轮建议已有结果，请从首页重新发起。');
  validateCompanionAdjustmentTarget(ctx, actorId, adjustment.planId, adjustment.expectedRevision, adjustment.stopId);
  if (action === 'start' && ['rest', 'time'].includes(adjustment.change)) {
    return { reply: `我会结合「${adjustment.planName}」的后续安排核对道路和预约。${adjustment.change === 'rest' ? '你想休息多久？' : '今天最迟希望几点结束？'}先告诉我，我再给你调整建议；确认之前会保留原安排。`, adjustment, refresh: [] as string[] };
  }
  const result = await createCompanionAdvice(ctx, actorId, adjustment.planId, { expectedRevision: adjustment.expectedRevision, change: adjustment.change,
    transportMode: adjustment.transportMode, ...(adjustment.change === 'rest' ? { minutes: request.minutes } : {}),
    ...(adjustment.change === 'time' ? { deadlineMinutes: request.deadlineMinutes } : {}), ...(location ? { position: location } : {}) });
  if (source && source.companionAdjustment?.status !== 'needs_input') throw new CompanionContextError('COMPANION_STALE', '这次追问已取消或已处理，请重新发起调整。');
  adjustment.candidates = result.candidates; adjustment.reasons = result.reasons;
  adjustment.status = result.candidates.length ? 'preview' : 'unavailable';
  if (source) source.companionAdjustment = { ...source.companionAdjustment!, status: 'superseded' };
  let reply = result.candidates.length ? `已核对「${adjustment.planName}」的道路与后续时间，为你准备了 ${result.candidates.length} 份调整建议。先看看前后变化，确认后才会更新行程。`
    : `暂时没有可以直接采用的调整，原安排已保留。${result.reasons.join(' ')}`;
  const model = ctx.modelProviderForActor(actorId);
  if (model && model.providerName !== 'scripted' && result.candidates.length) {
    try {
      const turn = await model.generateTurn({ tools: [], maxOutputTokens: 350, messages: [
        { role: 'system', content: '你是伴途随行助手。根据已核实的调整候选简短解释怎样选择。只引用给定事实，不编造地点、时间、天气或费用。候选尚未采用，不得声称已经修改或完成操作；不执行任何工具。' },
        { role: 'user', content: JSON.stringify({ intent: adjustment.change, plan: adjustment.planName, candidates: result.candidates, reasons: result.reasons }) },
      ] });
      if (!turn.error && !turn.toolCalls.length && turn.text?.trim()) reply += `\n\n${turn.text.trim()}`;
    } catch { /* 核实的候选继续可用，解释失败不丢失预览。 */ }
  }
  return { reply, adjustment, refresh: [] as string[] };
}
