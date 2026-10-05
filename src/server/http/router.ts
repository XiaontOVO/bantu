/**
 * 极简路由表：按注册顺序依次询问每个模块，谁先命中谁处理。
 *
 * 每个模块导出 `(ctx, req) => Promise<boolean>`，返回 true 表示已经写出响应。
 * 新增功能只需新增一个 routes/*.ts 并登记到这里，不必改动其他模块。
 *
 * 注意：本函数**不负责**最终 404。没命中时返回 false，由调用方决定
 * 是继续尝试后续路由还是回落到兜底 404（迁移期间两者都需要）。
 */
import type { RouteRequest } from './request.js';
import type { ServerContext } from './context.js';
import { sendError } from './respond.js';

export type RouteHandler = (ctx: ServerContext, req: RouteRequest) => Promise<boolean>;

export function createRouter(
  routes: readonly RouteHandler[],
): (ctx: ServerContext, req: RouteRequest) => Promise<boolean> {
  return async (ctx, req) => {
    // Validate encoded path segments once before a route calls decodeURIComponent.
    // URIError otherwise escapes route handlers and is reported as an internal 500.
    try {
      decodeURIComponent(req.path);
    } catch {
      sendError(req.response, 400, 'INVALID_INPUT', '资源路径编码无效。');
      return true;
    }

    // Cookies are shared across tabs. An old page must not read or write using
    // a newly selected account. This is a consistency check, never identity or
    // authorization supplied by the client; the cookie remains authoritative.
    const expectedPrincipal = req.request.headers['x-bantu-principal'];
    if (req.path.startsWith('/api/') && expectedPrincipal !== undefined && req.path !== '/api/v1/session/guest') {
      if (typeof expectedPrincipal !== 'string' || !/^\S{1,128}$/.test(expectedPrincipal)) {
        sendError(req.response, 400, 'INVALID_INPUT', '页面身份标识无效，请刷新页面。');
        return true;
      }
      const binding = ctx.requireAuth(req.request, req.response);
      if (!binding) return true;
      if (binding.actorId !== expectedPrincipal) {
        sendError(req.response, 409, 'SESSION_CHANGED', '账号已在其他页面切换，此页操作已暂停。请切回原账号或刷新页面。');
        return true;
      }
    }

    for (const route of routes) {
      if (await route(ctx, req)) return true;
    }
    return false;
  };
}
