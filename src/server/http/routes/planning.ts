/**
 * 生成/重算方案：把一次规划请求交给持久化 Agent 任务，并回传它产出的提案与许可。
 *
 * 两条入口共用同一段编排，只有 `kind`、默认事件和上下文来源不同：
 * - `initial-plans`：草稿旅行的初次排程；
 * - `replans`：行程中因为休息/下雨/延误而局部重排。
 *
 * 响应里同时带上 `steps`，前端才能展示"它查了什么、算了什么"。
 */
import { readJson } from '../request.js';
import { sendData, sendError, sendServiceError } from '../respond.js';
import type { RouteHandler } from '../router.js';
import type { ServerContext } from '../context.js';
import type { RouteRequest } from '../request.js';

const INITIAL_PLANS = /^\/api\/v1\/trips\/([^/]+)\/initial-plans$/;
const REPLANS = /^\/api\/v1\/trips\/([^/]+)\/replans$/;

export const planningRoutes: RouteHandler = async (ctx, req) => {
  const { path, method } = req;

  const initialMatch = INITIAL_PLANS.exec(path);
  const replanMatch = REPLANS.exec(path);
  if (method !== 'POST') return false;

  if (initialMatch) {
    await startPlanning(ctx, req, decodeURIComponent(initialMatch[1]), 'initial');
    return true;
  }
  if (replanMatch) {
    await startPlanning(ctx, req, decodeURIComponent(replanMatch[1]), 'replan');
    return true;
  }
  return false;
};

async function startPlanning(
  ctx: ServerContext,
  req: RouteRequest,
  tripId: string,
  kind: 'initial' | 'replan',
): Promise<void> {
  const { request, response } = req;
  const auth = ctx.requireAuth(request, response);
  if (!auth) return;

  // 先读完请求体：限流提前返回时留着未消费的 body 会影响 keep-alive 连接复用。
  const body = await readJson(request);

  const current = ctx.service.getTrip(auth.actorId, tripId);
  if (!current.ok) {
    sendServiceError(response, current);
    return;
  }

  // 任务创建限流独立于匿名会话限流：一个主体不应把额度用在并发起多个 Agent 任务上。
  const taskLimit = ctx.consumeTaskLimit(auth.actorId);
  if (!taskLimit.allowed) {
    sendError(response, 429, 'RATE_LIMITED', '新任务创建过于频繁，请稍后重试。', {
      retryAfterSeconds: taskLimit.retryAfterSeconds,
    });
    return;
  }

  const baseRevision = Number(body.baseRevision ?? current.value.trip.revision);
  const contextSnapshotId =
    typeof body.contextSnapshotId === 'string'
      ? body.contextSnapshotId
      : current.value.trip.latestContextId;

  const operationView = await ctx.agentService.start({
    actorId: auth.actorId,
    sessionId: auth.sessionId,
    tripId,
    baseRevision,
    kind,
    contextSnapshotId,
    ...(kind === 'replan'
      ? {
          event:
            body.event && typeof body.event === 'object'
              ? (body.event as Record<string, unknown>)
              : { type: 'rest_requested' },
        }
      : {}),
  });

  const proposalId = operationView.operation.result?.proposalId;
  const proposal =
    typeof proposalId === 'string'
      ? ctx.service.getProposal(auth.actorId, tripId, proposalId)
      : null;

  sendData(
    response,
    {
      operationId: operationView.operation.operationId,
      status: operationView.operation.status,
      result: operationView.operation.result,
      proposal: proposal?.ok ? proposal.value.proposal : null,
      actionRequests: proposal?.ok ? proposal.value.actionRequests : [],
      steps: operationView.steps.map((step) => ({
        stepIndex: step.stepIndex,
        toolResults: step.toolResults,
      })),
    },
    { dataMode: current.value.trip.dataMode, responseSource: 'computed_template' },
  );
}
