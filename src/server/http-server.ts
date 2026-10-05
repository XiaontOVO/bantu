/**
 * P0 原型 HTTP 入口（Node 内置 http，无框架依赖）。
 *
 * 本文件只做三件事：建服务器、把请求交给路由表、在 API 响应发出前落盘。
 * 端点实现按功能模块放在 `http/routes/`，基础封装放在 `http/`，
 * 装配（服务、供应商、状态存储、限流器）在 `http/bootstrap.ts`。
 * 见 docs/09-代码模块地图.md。
 */

import { createServer } from 'node:http';
import { createServerContext } from './http/bootstrap.js';
import { createRouter, type RouteHandler } from './http/router.js';
import { InvalidJsonBodyError, RequestBodyTooLargeError, ResponseSentError } from './http/errors.js';
import { sendError } from './http/respond.js';
import { PlaceProviderUnavailableError } from '../providers/travel.js';
import { isStaticPath, serveStatic } from './http/static.js';
import { healthRoutes } from './http/routes/health.js';
import { communityRoutes } from './http/routes/community.js';
import { planLibraryRoutes } from './http/routes/plans.js';
import { achievementRoutes } from './http/routes/achievements.js';
import { companionRoutes } from './http/routes/companion.js';
import { modelSettingsRoutes } from './http/routes/model-settings.js';
import { userModelSettingsRoutes } from './http/routes/user-model-settings.js';
import { sessionRoutes } from './http/routes/session.js';
import { tripRoutes } from './http/routes/trips.js';
import { lifecycleRoutes } from './http/routes/lifecycle.js';
import { planningRoutes } from './http/routes/planning.js';
import { placeRoutes } from './http/routes/places.js';
import { arrivalGuideRoutes } from './http/routes/arrival-guide.js';
import { operationRoutes } from './http/routes/operations.js';
import { messageRoutes } from './http/routes/messages.js';
import { memoryRoutes } from './http/routes/memories.js';
import { proposalRoutes } from './http/routes/proposals.js';
import { demoRoutes } from './http/routes/demo.js';
import { DEMO_SHANGHAI_PLACES } from '../demo/demo-data.js';
import { seedCommunitySamples } from '../demo/community-samples.js';
import { StateStoreConflictError } from '../persistence/state-store.js';
import type { HttpServerOptions } from './http/context.js';
import { createAccessGate } from './http/access-gate.js';

export type { HttpServerOptions } from './http/context.js';
export { InMemoryTripService } from '../services/trip-service.js';

/**
 * 路由清单，按顺序匹配，命中即返回。
 * 新增功能模块＝新增一个 routes/*.ts 并在这里登记一行，不需要改动其它模块。
 * 顺序只在有重叠前缀时才有意义（例如 trips 的通配子路由排在具体子路由之后）。
 */
const ROUTES: readonly RouteHandler[] = [
  healthRoutes,
  communityRoutes,
  modelSettingsRoutes,
  userModelSettingsRoutes,
  sessionRoutes,
  placeRoutes,
  arrivalGuideRoutes,
  companionRoutes,
  planLibraryRoutes,
  achievementRoutes,
  operationRoutes,
  tripRoutes,
  lifecycleRoutes,
  planningRoutes,
  messageRoutes,
  memoryRoutes,
  proposalRoutes,
  demoRoutes,
];

export function createHttpServer(options: HttpServerOptions = {}): ReturnType<typeof createServer> {
  const ctx = createServerContext(options);
  const { stateStore } = ctx;
  const accessGate = options.accessGate ?? createAccessGate();
  const router = createRouter(ROUTES);
  let persistenceFault = false;

  const runMaintenance = () => {
    try {
      const cleanedTrips = ctx.service.purgePastProgress();
      const removedPlans = ctx.planLibrary.purgePastDatedPlans();
      const removedBindings = ctx.sessions.prune(binding => ctx.service.validateSession(binding.actorId, binding.sessionId));
      if (removedPlans || cleanedTrips || removedBindings) ctx.persistState();
    } catch (error) {
      persistenceFault = true;
      console.error('[bantu] Automatic past-plan cleanup failed:', error);
    }
  };

  // Run once after hydration, then periodically so past plans disappear even when no page is open.
  runMaintenance();
  const maintenance = setInterval(runMaintenance, 60_000);
  maintenance.unref();

  const server = createServer(async (request, response) => {
    let path = '/';
    try {
      const method = (request.method ?? 'GET').toUpperCase();
      const url = new URL(request.url ?? '/', 'http://localhost');
      path = url.pathname;

      // 局域网邀请码门禁：放在最外层，任何路由/静态资源/持久化逻辑之前。
      if (await accessGate.intercept(request, response, method, path)) return;

      // StateStore 故障后内存状态可能领先于磁盘快照；暂停 API 直到重启，避免继续读写不一致状态。
      if (stateStore && path.startsWith('/api/')) {
        if (persistenceFault) {
          sendError(response, 503, 'PERSISTENCE_FAILED', '本地数据保存失败，API 已暂停；修复存储后请重启伴途。');
          return;
        }

        // 当前 API 都走 sendJson：先缓存 writeHead，确保落盘成功后才把成功状态发给客户端。
        // 新增流式 API 必须先补齐这里的提交边界，不能直接 write/flushHeaders。
        const requestStateFingerprint = ctx.stateFingerprint();
        const originalWriteHead = response.writeHead.bind(response);
        const originalEnd = response.end.bind(response);
        let pendingWriteHead: unknown[] | null = null;
        response.writeHead = ((...args: unknown[]) => {
          pendingWriteHead = args;
          return response;
        }) as typeof response.writeHead;
        response.end = ((...args: unknown[]) => {
          response.writeHead = originalWriteHead as typeof response.writeHead;
          response.end = originalEnd as typeof response.end;
          try {
            // GET 也可能清理过期进度、迁移收藏或撤销无效会话；比较实际服务快照，
            // 只有状态变化时才提交，避免每次读取都重写整库并触发陈旧实例冲突。
            if (ctx.stateFingerprint() !== requestStateFingerprint) ctx.persistState();
          } catch (error) {
            persistenceFault = true;
            console.error(`[bantu] SQLite persistence failed for ${method} ${path}:`, error);
            if (response.headersSent) {
              response.destroy();
              return response;
            }
            response.removeHeader('set-cookie');
            if (error instanceof StateStoreConflictError) {
              sendError(response, 409, 'STATE_STORE_CONFLICT', '数据已被其他服务实例更新，本实例已暂停；请重启伴途以加载最新数据。', {
                expectedRevision: error.expectedRevision,
                actualRevision: error.actualRevision,
              });
            } else {
              sendError(response, 503, 'PERSISTENCE_FAILED', '本地数据保存失败，API 已暂停；修复存储后请重启伴途。');
            }
            return response;
          }

          if (pendingWriteHead) {
            (originalWriteHead as (...innerArgs: unknown[]) => unknown)(...pendingWriteHead);
          }
          return (originalEnd as (...innerArgs: unknown[]) => unknown)(...args);
        }) as typeof response.end;
      }

      // 静态外壳：HTML 与 sw.js 不缓存，避免修好的页面被旧副本挡住。
      if (method === 'GET' && isStaticPath(path)) {
        await serveStatic(response, path);
        return;
      }

      if (await router(ctx, { method, path, url, request, response })) return;

      // 全局 POST /feedback 曾是返回 { recorded: true } 但什么都不写的空壳，且不在 docs/03 契约里；
      // 反馈的唯一入口是 POST /trips/:tripId/feedback（真实落库、不改规划版本）。
      sendError(response, 404, 'RESOURCE_NOT_FOUND', `没有匹配的接口：${method} ${path}`);
    } catch (error) {
      if (error instanceof ResponseSentError || response.headersSent) return;
      if (error instanceof PlaceProviderUnavailableError) {
        sendError(response, 503, 'PROVIDER_UNAVAILABLE', error.message, { providerCode: error.providerCode }, true);
        return;
      }
      if (error instanceof InvalidJsonBodyError) {
        sendError(response, 400, 'INVALID_INPUT', '请求体不是有效 JSON。');
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        sendError(response, 413, 'REQUEST_TOO_LARGE', '请求体超过 2 MiB 限制。');
        return;
      }
      // 真实 500 必须在服务端可见；响应体不返回异常文本，避免泄漏内部实现。
      console.error(`[bantu] ${request.method ?? 'GET'} ${path} failed:`, error);
      sendError(response, 500, 'INTERNAL_ERROR', '服务内部错误。', { path });
    }
  });

  // 内置地点目录属于平台资料，不应随社区样例开关消失。
  for (const place of DEMO_SHANGHAI_PLACES) ctx.placeRegistry.ensure(place.placeId);
  if (options.seedDemo) {
    seedCommunitySamples(ctx.communityService);
  } else if (ctx.communityService.hasSamples()) {
    // 关闭演示模式时清掉旧版本留下的样例内容，但不触碰用户自己的帖子/地点。
    ctx.communityService.clearSamples();
    ctx.persistState();
  }

  server.on('close', () => clearInterval(maintenance));

  return server;
}
