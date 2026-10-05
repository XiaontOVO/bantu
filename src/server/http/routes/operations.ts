/**
 * 持久化任务（Agent operation）的读取、取消与补答。
 *
 * 每个入口都要确认任务属于当前主体，否则任何会话都能凭 operationId 读到别人的任务。
 */
import { sendData, sendError, statusFor } from '../respond.js';
import type { RouteHandler } from '../router.js';
import type { ServerContext } from '../context.js';
import type { RouteRequest } from '../request.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** 取本主体拥有的任务视图；不存在或不属于本主体时已写出 404。 */
function ownedOperation(ctx: ServerContext, req: RouteRequest, operationId: string, actorId: string) {
  const view = ctx.agentService.get(operationId);
  if (!view || view.operation.actorId !== actorId) {
    sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '任务不存在。');
    return null;
  }
  return view;
}

export const operationRoutes: RouteHandler = async (ctx, req) => {
  const { path, method, request, response } = req;

  if (!path.startsWith('/api/v1/operations')) return false;

  if (path === '/api/v1/operations' && method === 'GET') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    // 内存 AgentService 没有公开全量列表；客户端通常按 operationId 查询。
    sendData(response, []);
    return true;
  }

  const operationMatch = path.match(/^\/api\/v1\/operations\/([^/]+)$/);
  if (operationMatch && method === 'GET') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const view = ownedOperation(ctx, req, decodeURIComponent(operationMatch[1]), auth.actorId);
    if (!view) return true;
    sendData(response, view.operation);
    return true;
  }

  const toolMatch = path.match(/^\/api\/v1\/operations\/([^/]+)\/tool-executions$/);
  if (toolMatch && method === 'GET') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const view = ownedOperation(ctx, req, decodeURIComponent(toolMatch[1]), auth.actorId);
    if (!view) return true;
    sendData(response, view.toolExecutions);
    return true;
  }

  const cancelMatch = path.match(/^\/api\/v1\/operations\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const operationId = decodeURIComponent(cancelMatch[1]);
    if (!ownedOperation(ctx, req, operationId, auth.actorId)) return true;
    const cancelled = ctx.agentService.operations.cancel(operationId, ctx.now());
    if (!cancelled.ok) {
      sendError(
        response,
        statusFor(cancelled.error?.code),
        cancelled.error?.code ?? 'OPERATION_TERMINAL',
        cancelled.error?.message ?? '任务已经结束。',
      );
      return true;
    }
    sendData(response, cancelled.operation);
    return true;
  }

  const answerMatch = path.match(/^\/api\/v1\/operations\/([^/]+)\/answers$/);
  if (answerMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const operationId = decodeURIComponent(answerMatch[1]);
    const view = ownedOperation(ctx, req, operationId, auth.actorId);
    if (!view) return true;
    if (TERMINAL.has(view.operation.status)) {
      sendError(response, 409, 'OPERATION_TERMINAL', '任务已经结束，不能补答。');
      return true;
    }
    if (view.operation.status !== 'awaiting_input') {
      // 不在等待输入的状态，原样返回当前任务，不产生副作用。
      sendData(response, view.operation);
      return true;
    }
    const resumed = ctx.agentService.operations.resume(operationId, ctx.now(), 'awaiting_input');
    if (!resumed.ok) {
      sendError(
        response,
        statusFor(resumed.error?.code),
        resumed.error?.code ?? 'OPERATION_TIMEOUT',
        resumed.error?.message ?? '补答失败。',
      );
      return true;
    }
    sendData(response, resumed.operation);
    return true;
  }

  // 前缀匹配但没有具体子路由命中：交给后续模块，避免误吞 /operations/... 之外的新路径。
  return false;
};
