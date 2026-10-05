/** 匿名会话：创建/恢复、当前身份、退出。 */
import {
  readJson, clearSessionCookie, clientIp,
  parseCookies,
  setSessionCookie,
} from '../request.js';
import { RequestBodyTooLargeError } from '../errors.js';
import { sendData, sendError, sendRateLimited } from '../respond.js';
import type { RouteHandler } from '../router.js';

/** 每个 IP 每小时允许创建多少个匿名会话；本机回环地址放宽，避免自测/单机使用被限频。 */
const GUEST_LIMIT_PER_HOUR = 10;
const GUEST_LIMIT_LOOPBACK_PER_HOUR = 120;

function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.0.0.1');
}

export const sessionRoutes: RouteHandler = async (ctx, req) => {
  const { path, method, request, response } = req;

  if (['/api/v1/account/register', '/api/v1/account/login'].includes(path) && method === 'POST') {
    const limit = ctx.rateLimiter.consume(`account:${clientIp(request)}`, 15, 60);
    if (!limit.allowed) { sendRateLimited(response, limit.retryAfterSeconds, '尝试过于频繁，请稍后重试。'); return true; }
    try {
      const body = await readJson(request);
      const oldToken = parseCookies(request).bantu_session;
      const old = oldToken ? ctx.sessions.get(oldToken) : undefined;
      let actorId: string;
      if (path.endsWith('/register')) {
        if (!old || !ctx.service.validateSession(old.actorId, old.sessionId, oldToken)) { sendError(response,401,'SESSION_EXPIRED','请刷新页面后注册。'); return true; }
        actorId = ctx.accounts.register(body.username, body.password, old.actorId);
      } else actorId = ctx.accounts.login(body.username, body.password);
      const issued = ctx.service.createAnonymousSession(undefined, actorId);
      if (old) { ctx.service.revokeSession(old.sessionId); ctx.sessions.delete(oldToken!); }
      ctx.sessions.set(issued.token, {actorId,sessionId:issued.session.sessionId});
      setSessionCookie(response,issued.token);
      sendData(response,{...ctx.accounts.profile(actorId),principalId:actorId});
    } catch(error) { if (error instanceof RequestBodyTooLargeError) throw error; sendError(response,400,'ACCOUNT_INVALID', error instanceof Error ? error.message : '登录失败。'); }
    return true;
  }

  if (path === '/api/v1/session/guest' && method === 'POST') {
    const token = parseCookies(request).bantu_session;
    const existing = token ? ctx.sessions.get(token) : undefined;
    if (existing && ctx.service.validateSession(existing.actorId, existing.sessionId, token)) {
      // 同一个浏览器的重复调用应该复用会话，而不是不断产生新的匿名身份。
      sendData(response, {
        principalId: existing.actorId,
        sessionId: existing.sessionId,
        restored: true,
      });
      return true;
    }
    if (token && existing) ctx.sessions.delete(token);
    const ip = clientIp(request);
    const guestLimit = isLoopbackIp(ip) ? GUEST_LIMIT_LOOPBACK_PER_HOUR : GUEST_LIMIT_PER_HOUR;
    const limit = ctx.rateLimiter.consume(
      `guest:${ip}`,
      guestLimit,
      60 * 60,
    );
    if (!limit.allowed) {
      sendRateLimited(response, limit.retryAfterSeconds, '匿名会话创建过于频繁，请稍后重试。');
      return true;
    }
    const { principal, session, token: issued } = ctx.service.createAnonymousSession();
    ctx.sessions.set(issued, {
      actorId: principal.principalId,
      sessionId: session.sessionId,
    });
    setSessionCookie(response, issued);
    sendData(response, {
      principalId: principal.principalId,
      sessionId: session.sessionId,
      restored: false,
      previousSessionInvalid: Boolean(token),
    });
    return true;
  }

  if (path === '/api/v1/me' && method === 'GET') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    sendData(response, {
      principalId: auth.actorId,
      sessionId: auth.sessionId,
      expiresAt: ctx.service.sessionExpiry(auth.actorId, auth.sessionId),
      ...ctx.accounts.profile(auth.actorId),
    });
    return true;
  }

  // 社区昵称属于账号资料：改一次，发帖/评论/评价全站生效。
  if (path === '/api/v1/me' && method === 'PATCH') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    try {
      const body = await readJson(request);
      sendData(response, { ...ctx.accounts.profile(auth.actorId), ...ctx.accounts.setNickname(auth.actorId, body.nickname) });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
      sendError(response, 400, 'ACCOUNT_INVALID', error instanceof Error ? error.message : '昵称保存失败。');
    }
    return true;
  }

  if (path === '/api/v1/session' && method === 'DELETE') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    ctx.service.revokeSession(auth.sessionId);
    ctx.sessions.delete(parseCookies(request).bantu_session ?? '');
    clearSessionCookie(response);
    sendData(response, { revoked: true });
    return true;
  }

  return false;
};
