/**
 * 对话入口：读写聊天记录、撤回单条消息。
 *
 * 对话按 tripId 存在 MessageService 里，没有归属概念，
 * 因此**每个入口都必须先确认旅行归属**，否则任何会话都能读到别人的聊天记录。
 */
import { randomUUID } from 'node:crypto';
import { parsePagination, readJson, type RouteRequest } from '../request.js';
import { sendData, sendError, sendServiceError } from '../respond.js';
import type { RouteHandler } from '../router.js';
import type { ServerContext } from '../context.js';
import { runPersonalAgent } from '../../../services/personal-agent-runtime.js';
import { normalizePostImages } from '../../../services/community-service.js';
import type { MessageRecord } from '../../../services/message-service.js';
import { agentResultLinks } from '../../../services/personal-agent-result-links.js';
import { runCompanionAgent } from '../../../services/personal-agent-companion.js';
import { CompanionContextError } from '../../../services/companion-context.js';
import { resolveCompanionDelegation } from '../../../services/personal-agent-delegation.js';
import { resolveAgentViewContext } from '../../../services/personal-agent-view-context.js';

function messageView(message: MessageRecord) {
  return { ...message, ...(message.images?.length ? { images: message.images.map((image, index) => ({ alt: image.alt, dataUrl: `/api/v1/agent/chat/${encodeURIComponent(message.messageId)}/images/${index}` })) } : {}) };
}

const MESSAGE_LIST = /^\/api\/v1\/trips\/([^/]+)\/messages$/;
const MESSAGE_DETAIL = /^\/api\/v1\/trips\/([^/]+)\/messages\/([^/]+)$/;
/** 无旅行的通用对话：伴途不绑定具体行程也能直接聊。 */
const GENERAL_CHAT = /^\/api\/v1\/agent\/chat$/;
const GENERAL_MESSAGE_DETAIL = /^\/api\/v1\/agent\/chat\/([^/]+)$/;
const GENERAL_IMAGE = /^\/api\/v1\/agent\/chat\/([^/]+)\/images\/(\d+)$/;

export const messageRoutes: RouteHandler = async (ctx, req) => {
  const { path, method, url, request, response } = req;
  const conversationMatch = /^\/api\/v1\/agent\/conversations\/([^/]+)$/.exec(path);
  if (conversationMatch && ['PATCH', 'DELETE'].includes(method)) {
    const auth = ctx.requireAuth(request, response); if (!auth) return true;
    const conversationId = decodeURIComponent(conversationMatch[1]) === 'default' ? '' : decodeURIComponent(conversationMatch[1]);
    try { ctx.messageService.generalList(auth.actorId, conversationId); }
    catch { sendError(response, 404, 'RESOURCE_NOT_FOUND', '对话不存在或不属于当前账号。'); return true; }
    if (method === 'DELETE') {
      try {
        ctx.personalAgentTasks.deleteConversation(auth.actorId, conversationId);
        sendData(response, ctx.messageService.deleteGeneralConversation(auth.actorId, conversationId));
      } catch (error) { sendError(response, 409, 'REVISION_CONFLICT', error instanceof Error ? error.message : '无法删除对话。'); }
      return true;
    }
    const body = await readJson(request);
    try { sendData(response, ctx.messageService.renameGeneralConversation(auth.actorId, conversationId, body.title)); }
    catch (error) { sendError(response, 400, 'INVALID_INPUT', error instanceof Error ? error.message : '对话名称无效。'); }
    return true;
  }
  if (path === '/api/v1/agent/conversations' && ['GET', 'POST'].includes(method)) {
    const auth = ctx.requireAuth(request, response); if (!auth) return true;
    if (method === 'GET') sendData(response, ctx.messageService.generalConversations(auth.actorId));
    else { await readJson(request); sendData(response, ctx.messageService.createGeneralConversation(auth.actorId)); }
    return true;
  }
  if (path === '/api/v1/agent/task' && (method === 'GET' || method === 'DELETE')) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    if (method === 'GET') sendData(response, ctx.personalAgentTasks.current(auth.actorId, url.searchParams.get('conversationId') || ''));
    else {
      const body = await readJson(request);
      try {
        const task = ctx.personalAgentTasks.cancel(auth.actorId, String(body.taskId || ''), String(body.conversationId || ''));
        ctx.persistState(); sendData(response, task);
      } catch (error) { sendError(response, 409, 'REVISION_CONFLICT', error instanceof Error ? error.message : '无法停止任务'); }
    }
    return true;
  }
  const imageMatch = GENERAL_IMAGE.exec(path);
  if (imageMatch && method === 'GET') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const message = ctx.messageService.findGeneralMessage(auth.actorId, decodeURIComponent(imageMatch[1]));
    const image = message?.images?.[Number(imageMatch[2])];
    if (!image) { sendError(response, 404, 'RESOURCE_NOT_FOUND', '照片不存在或已删除。'); return true; }
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image.dataUrl);
    if (!match) { sendError(response, 404, 'RESOURCE_NOT_FOUND', '照片不可用。'); return true; }
    response.writeHead(200, { 'Content-Type': match[1], 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(Buffer.from(match[2], 'base64')); return true;
  }

  if (GENERAL_CHAT.exec(path)) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const modelProvider = ctx.modelProviderForActor(auth.actorId);
    if (method === 'GET') {
      try { sendData(response, ctx.messageService.generalList(auth.actorId, url.searchParams.get('conversationId') || '').map(messageView)); }
      catch { sendError(response, 404, 'RESOURCE_NOT_FOUND', '对话不存在或不属于当前账号。'); }
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const conversationId = body.conversationId === undefined ? '' : body.conversationId;
      if (typeof conversationId !== 'string') { sendError(response, 400, 'INVALID_INPUT', '对话编号无效。'); return true; }
      try { ctx.messageService.generalList(auth.actorId, conversationId); }
      catch { sendError(response, 404, 'RESOURCE_NOT_FOUND', '对话不存在或不属于当前账号。'); return true; }
      const text = String(body.text ?? '').trim();
      let images: Array<{ dataUrl: string; alt: string }>;
      try { images = normalizePostImages(body.images).map(image => ({ dataUrl: `data:${image.mimeType};base64,${image.data}`, alt: image.alt })); }
      catch (error) { sendError(response, 400, 'INVALID_INPUT', error instanceof Error ? error.message : '照片格式无效'); return true; }
      if (images.length && (!modelProvider || modelProvider.providerName === 'scripted')) {
        sendError(response, 400, 'INVALID_INPUT', '请先连接模型，再通过伴途发布照片。'); return true;
      }
      if (!text) { sendError(response, 400, 'INVALID_INPUT', '请输入消息内容。'); return true; }
      const clientMessageId = readClientMessageId(body, response);
      if (!clientMessageId) return true;
      let viewContext;
      try { viewContext = await resolveAgentViewContext(ctx, auth.actorId, body.viewContext); }
      catch (error) { sendError(response, 400, 'INVALID_INPUT', error instanceof Error ? error.message : '页面上下文无效。'); return true; }
      const scope = 'agent.general-chat';
      await sendIdempotentMessage(ctx, response, auth.actorId, scope, clientMessageId,
        { text, clientMessageId, ...(conversationId ? { conversationId } : {}), ...(images.length ? { images } : {}), ...(body.location ? { location: body.location } : {}), ...(body.companionRequest ? { companionRequest: body.companionRequest } : {}), ...(body.viewContext ? { viewContext: body.viewContext } : {}) }, async () => {
          const { userMessage: storedUserMessage, assistantMessage } = ctx.messageService.handleGeneral({
            actorId: auth.actorId, text, conversationId, clientMessageId, images,
          });
          const userMessage = messageView(storedUserMessage);
          if (body.companionRequest) {
            assistantMessage.agentMode = modelProvider && modelProvider.providerName !== 'scripted' ? 'tools' : 'rules';
            const limit = ctx.consumeTaskLimit(auth.actorId);
            if (!limit.allowed) {
              ctx.messageService.updateReply(assistantMessage, '这段时间的请求较多，请稍后重试调整。原安排已保留。');
              return { userMessage, assistantMessage, status: 'answered' };
            }
            try {
              const delegatedRequest = body.companionRequest as Record<string, unknown>;
              if (delegatedRequest.action === 'delegate' || delegatedRequest.action === 'cancel_delegate') {
                const delegation = resolveCompanionDelegation(ctx, auth.actorId, delegatedRequest, conversationId);
                assistantMessage.companionDelegation = delegation;
                if (delegatedRequest.action === 'cancel_delegate') {
                  delegation.status = 'cancelled';
                  const source = ctx.messageService.generalList(auth.actorId, conversationId).find(message => message.messageId === delegatedRequest.sourceMessageId);
                  if (source?.companionDelegation) source.companionDelegation.status = 'cancelled';
                  ctx.messageService.updateReply(assistantMessage, '已取消这次调整，保留原安排。');
                  return { userMessage, assistantMessage, status: 'answered', command: { handled: true, refresh: [] } };
                }
                if (!modelProvider || modelProvider.providerName === 'scripted') {
                  delegation.status = 'unavailable';
                  ctx.messageService.updateReply(assistantMessage, '尚未连接可用的 LLM，无法自动托管这次调整。请在 AI 设置中连接模型后重试；原安排已保留。');
                  return { userMessage, assistantMessage, status: 'answered', command: { handled: true, refresh: [] } };
                }
                const history = ctx.messageService.generalList(auth.actorId, conversationId)
                  .filter(message => message.messageId !== userMessage.messageId && message.messageId !== assistantMessage.messageId)
                  .map(message => ({ role: message.role as 'user' | 'assistant', content: message.text }));
                const result = await runPersonalAgent(ctx, auth.actorId, text, history, images, body.location, delegation, viewContext, conversationId);
                assistantMessage.companionDelegation = result.companionDelegation;
                const source = ctx.messageService.generalList(auth.actorId, conversationId).find(message => message.messageId === delegatedRequest.sourceMessageId);
                if (source?.companionDelegation) source.companionDelegation.status = 'superseded';
                ctx.messageService.updateReply(assistantMessage, result.reply);
                assistantMessage.resultLinks = [...agentResultLinks(result.refresh, result.date, result.steps.filter(step => step.ok).map(step => step.tool)), ...(result.detailLinks || [])];
                return { userMessage, assistantMessage, status: 'answered', command: { handled: true, refresh: result.refresh, date: result.date }, agent: { mode: 'tools', steps: result.steps, uiActions: result.uiActions || [] } };
              }
              const result = await runCompanionAgent(ctx, auth.actorId, body.companionRequest, body.location);
              assistantMessage.companionAdjustment = result.adjustment;
              ctx.messageService.updateReply(assistantMessage, result.reply);
              return { userMessage, assistantMessage, status: 'answered', command: { handled: true, refresh: result.refresh, date: result.adjustment.localDate } };
            } catch (error) {
              if (!(error instanceof CompanionContextError)) throw error;
              const request = body.companionRequest as Record<string, unknown>;
              const source = ctx.messageService.generalList(auth.actorId, conversationId).find(message => message.messageId === request.sourceMessageId && message.role === 'assistant');
              if (request.action === 'apply' && source?.companionAdjustment?.status === 'preview') {
                source.companionAdjustment = { ...source.companionAdjustment, status: 'unavailable', candidates: [], reasons: [error.message] };
                assistantMessage.companionAdjustment = structuredClone(source.companionAdjustment);
              }
              ctx.messageService.updateReply(assistantMessage, `${error.message} 请回首页重新核对；原安排未因这条请求而改变。`);
              return { userMessage, assistantMessage, status: 'answered', command: { handled: true, refresh: [] } };
            }
          }
          if (modelProvider && modelProvider.providerName !== 'scripted') {
            assistantMessage.agentMode = 'tools';
            const limit = ctx.consumeTaskLimit(auth.actorId);
            if (!limit.allowed) {
              const wait = limit.retryAfterSeconds < 60 ? `${limit.retryAfterSeconds} 秒` : `${Math.ceil(limit.retryAfterSeconds / 60)} 分钟`;
              ctx.messageService.updateReply(assistantMessage, `已达到对话请求限额，请在 ${wait} 后重新发送。这条请求尚未执行。`);
              return { userMessage, assistantMessage, status: 'answered' };
            }
            const history = ctx.messageService.generalList(auth.actorId, conversationId)
              .filter(message => message.messageId !== userMessage.messageId && message.messageId !== assistantMessage.messageId)
              .map(message => ({ role: message.role as 'user' | 'assistant', content: message.text }));
            const result = await runPersonalAgent(ctx, auth.actorId, text, history, images, body.location, undefined, viewContext, conversationId);
            assistantMessage.companionDelegation = result.companionDelegation;
            ctx.messageService.updateReply(assistantMessage, result.reply);
            const detailLinks = result.detailLinks || [];
            assistantMessage.resultLinks = [...agentResultLinks(result.refresh, result.date, result.steps.filter(step => step.ok).map(step => step.tool)), ...detailLinks];
            return { userMessage, assistantMessage, status: 'answered', command: { handled: true, refresh: result.refresh, date: result.date }, agent: { mode: 'tools', steps: result.steps, uiActions: result.uiActions || [] } };
          }
          let command: Awaited<ReturnType<typeof ctx.standaloneAgentService.handle>>;
          assistantMessage.agentMode = 'rules';
          try {
            command = await ctx.standaloneAgentService.handle(auth.actorId, text);
          } catch (error) {
            const message = error instanceof Error ? error.message : '地点或路线服务暂时不可用，请稍后重试。';
            ctx.messageService.updateReply(assistantMessage, `${message} 原话已保留，可以稍后重试。`);
            return {
              userMessage, assistantMessage, status: 'answered',
              command: { handled: true, refresh: [] },
            };
          }
          if (command.handled) {
            ctx.messageService.updateReply(assistantMessage, command.reply);
          } else {
              ctx.messageService.updateReply(assistantMessage,
                '你可以直接说“安排徐汇一日游”，或说“生成两天方案：第一天去武康大楼，第二天去龙华寺”。也可以让我查看当天路线、把地点加入某天计划、载入方案、把今天计划保存为方案、分享方案、调整停留时间、记录旅行记忆、发布帖子、点赞收藏或发表评论。');
          }
          return {
            userMessage, assistantMessage, status: 'answered',
            ...(command.handled ? { command: { handled: true, refresh: command.refresh || [], date: command.date } } : {}),
          };
        });
      return true;
    }
    return false;
  }

  const generalDetailMatch = GENERAL_MESSAGE_DETAIL.exec(path);
  if (generalDetailMatch && method === 'DELETE') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const redacted = ctx.messageService.redactGeneral(auth.actorId, decodeURIComponent(generalDetailMatch[1]));
    if (!redacted.ok) {
      sendServiceError(response, redacted);
      return true;
    }
    sendData(response, { messageId: redacted.value.message.messageId, redacted: true, sourceInvalidated: false });
    return true;
  }

  const listMatch = MESSAGE_LIST.exec(path);
  if (listMatch) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(listMatch[1]);
    if (!ctx.requireOwnedTrip(auth, tripId, response)) return true;

    if (method === 'GET') {
      const { limit } = parsePagination(url);
      const before = url.searchParams.get('before') || undefined;
      const page = ctx.messageService.page(tripId, limit, before);
      if (!page) {
        sendError(response, 400, 'INVALID_INPUT', '聊天记录位置已失效，请重新打开对话。');
        return true;
      }
      sendData(response, page.items, { nextCursor: page.nextCursor });
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const text = String(body.text ?? '');
      const clientMessageId = readClientMessageId(body, response);
      if (!clientMessageId) return true;
      const scope = `trip-chat:${tripId}`;
      await sendIdempotentMessage(ctx, response, auth.actorId, scope, clientMessageId,
        { tripId, text, proposalId: typeof body.proposalId === 'string' ? body.proposalId : undefined, clientMessageId },
        () => handleSend(ctx, auth.actorId, auth.sessionId, tripId, body, clientMessageId));
      return true;
    }
    return false;
  }

  const detailMatch = MESSAGE_DETAIL.exec(path);
  if (detailMatch && method === 'DELETE') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(detailMatch[1]);
    if (!ctx.requireOwnedTrip(auth, tripId, response)) return true;
    const redacted = ctx.messageService.redact(tripId, decodeURIComponent(detailMatch[2]));
    if (!redacted.ok) {
      sendServiceError(response, redacted);
      return true;
    }
    if (redacted.value.changed) {
      const invalidated = ctx.service.invalidateMessageSource(auth.actorId, tripId, redacted.value.message.messageId);
      if (!invalidated.ok) {
        sendServiceError(response, invalidated);
        return true;
      }
    }
    sendData(response, {
      messageId: redacted.value.message.messageId,
      redacted: true,
      sourceInvalidated: redacted.value.changed,
    });
    return true;
  }

  return false;
};

/**
 * 发一条消息。确定性确认（“可以，就这个”）会创建许可；
 * 如果该许可对应的 Agent 任务正等待审批，就在这里接着把它跑完，保证只提交一次。
 */
async function handleSend(
  ctx: ServerContext,
  actorId: string,
  sessionId: string,
  tripId: string,
  body: Record<string, unknown>,
  clientMessageId: string,
): Promise<Record<string, unknown>> {
  const replied = await ctx.messageService.handle({
    actorId,
    sessionId,
    tripId,
    text: String(body.text ?? ''),
    clientMessageId,
    proposalId: typeof body.proposalId === 'string' ? body.proposalId : undefined,
  });
  if (!replied.ok) {
    throw new MessageRouteFailure(replied);
  }

  let execution;
  let proposalView;
  let agentOperation;
  if (replied.value.status === 'answered' && ctx.modelProviderForActor(actorId)) {
    const limit = ctx.consumeTaskLimit(actorId);
    if (!limit.allowed) {
      ctx.messageService.updateReply(replied.value.assistantMessage, '请求有些频繁，请稍后再试。');
    } else {
      const current = ctx.service.getTrip(actorId, tripId);
      if (!current.ok) throw new MessageRouteFailure(current);
      const history = ctx.messageService.list(tripId)
        .filter((message) => message.messageId !== replied.value.userMessage.messageId && message.messageId !== replied.value.assistantMessage.messageId)
        .filter((message) => message.role === 'user' || message.role === 'assistant').slice(-12);
      const task = await ctx.agentService.start({
        actorId, sessionId, tripId,
        baseRevision: current.value.trip.revision,
        kind: current.value.snapshot.stops?.length ? 'replan' : 'initial',
        contextSnapshotId: current.value.trip.latestContextId,
        userText: replied.value.userMessage.text,
        conversation: history.map((message) => ({ role: message.role, content: message.text })),
      });
      agentOperation = task.operation;
      const proposalId = task.operation.result?.proposalId;
      if (typeof proposalId === 'string') {
        const found = ctx.service.getProposal(actorId, tripId, proposalId);
        if (found.ok) proposalView = found.value;
      }
      const answer = [...task.steps].reverse().find((step) => step.turn.text)?.turn.text;
      ctx.messageService.updateReply(replied.value.assistantMessage,
        task.operation.status === 'failed' ? '这次没有完成查询或规划，请稍后重试。当前行程未修改。'
          : answer || (proposalView ? '已生成候选，请查看具体安排后决定是否采用。' : '还需要更多信息，请补充你的旅行需求。'));
    }
  }
  const actionRequest = replied.value.actionRequest;
  if (actionRequest) {
    const actionRequestId = actionRequest.actionRequestId;
    const pending = ctx.agentService.findAwaitingOperationForAction(tripId, actionRequestId);
    const grant = ctx.service.authorization.getActiveGrant(actionRequestId);
    if (pending && grant) {
      const resumed = await ctx.agentService.resumeApply({
        operationId: pending.operation.operationId,
        actionRequestId,
        grantId: grant.grantId,
      });
      if (!resumed.ok) {
        throw new MessageRouteFailure(resumed);
      }
      execution = resumed.value.operation;
    } else if (grant && actionRequest.proposalId && actionRequest.candidateId) {
      const applied = ctx.service.applyProposal({
        actorId, sessionId, tripId,
        proposalId: actionRequest.proposalId, candidateId: actionRequest.candidateId,
        expectedRevision: actionRequest.baseRevision!, actionRequestId, grantId: grant.grantId,
        idempotencyKey: `chat-approval:${actionRequestId}`,
      });
      execution = applied.ok
        ? { status: 'succeeded', result: { mutationId: applied.value.mutationId } }
        : { status: 'failed', error: applied.error };
    }
    if (execution) ctx.messageService.updateReply(replied.value.assistantMessage,
      execution.status === 'succeeded' ? '已按你确认的方案更新行程，并保存了计划快照。你可以继续在这里告诉我下一步需求。' : '这次未能应用方案，请检查当前行程并重新生成方案。');
  }
  return { ...replied.value, execution, operation: agentOperation,
    proposal: proposalView?.proposal, actionRequests: proposalView?.actionRequests };
}

function readClientMessageId(body: Record<string, unknown>, response: RouteRequest['response']): string | null {
  if (body.clientMessageId !== undefined && (typeof body.clientMessageId !== 'string' || body.clientMessageId.length > 128)) {
    sendError(response, 400, 'INVALID_INPUT', 'clientMessageId 必须是 128 字符以内的文本。');
    return null;
  }
  const provided = typeof body.clientMessageId === 'string' ? body.clientMessageId.trim() : '';
  return provided || randomUUID();
}

async function sendIdempotentMessage(
  ctx: ServerContext,
  response: RouteRequest['response'],
  actorId: string,
  scope: string,
  key: string,
  requestBody: unknown,
  process: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<void> {
  const begin = ctx.service.idempotency.begin({ actorId, scope, key, requestBody, now: ctx.now() });
  if (begin.kind === 'conflict') {
    sendError(response, 409, 'IDEMPOTENCY_CONFLICT', '同一条消息标识不能用于不同内容。');
    return;
  }
  if (begin.kind === 'in_progress') {
    sendError(response, 409, 'OPERATION_IN_PROGRESS', '这条消息仍在处理中，请稍后重试。', undefined, true);
    return;
  }
  if (begin.kind === 'replay') {
    if (begin.record.status === 'completed') sendData(response, begin.record.response);
    else sendError(response, 409, 'MESSAGE_RETRY_REQUIRED', '上次消息处理未完成，请重新发送。', undefined, true);
    return;
  }

  try {
    const data = await process();
    ctx.service.idempotency.complete(actorId, scope, key, data, ctx.now());
    sendData(response, data);
  } catch (error) {
    if (error instanceof MessageRouteFailure) {
      ctx.service.idempotency.fail(actorId, scope, key,
        { code: error.result.error?.code ?? 'MESSAGE_REJECTED', message: error.result.error?.message ?? '消息请求未能完成。' }, ctx.now());
      sendServiceError(response, error.result);
      return;
    }
    ctx.service.idempotency.fail(actorId, scope, key,
      { code: 'MESSAGE_PROCESSING_FAILED', message: '消息处理未能完成。' }, ctx.now());
    throw error;
  }
}

class MessageRouteFailure extends Error {
  constructor(readonly result: Parameters<typeof sendServiceError>[1]) {
    super(result.error?.message ?? '消息请求未能完成。');
  }
}
