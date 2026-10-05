/**
 * 身份与会话：匿名主体的创建、会话校验与撤销。
 *
 * 会话是"能不能访问"的唯一依据，因此校验必须同时看存在性、归属、撤销和过期——
 * 少看一项，过期 token 就会永久有效（见 http 层 requireAuth 的调用点）。
 */
import { randomUUID } from 'node:crypto';
import { digestOpaqueToken } from '../../domain/token-hash.js';
import { hashToken, id, serviceError } from './helpers.js';
import type { Principal, ServiceResult, Session } from './contracts.js';
import type { TripState } from './state.js';

export interface AnonymousSession {
  principal: Principal;
  session: Session;
  token: string;
}

export function createAnonymousSession(
  state: TripState,
  ttlSeconds: number,
  existingPrincipalId?: string,
): AnonymousSession {
  const createdAt = state.now();
  if (existingPrincipalId && !activePrincipal(state, existingPrincipalId).ok) throw new Error('账号身份不可用。');
  const principal: Principal = (existingPrincipalId ? state.principals.get(existingPrincipalId) : undefined) ?? {
    principalId: id('principal'),
    kind: 'anonymous',
    createdAt,
    deletedAt: null,
  };
  const token = randomUUID();
  const session: Session = {
    sessionId: id('session'),
    principalId: principal.principalId,
    tokenHash: hashToken(token),
    createdAt,
    revokedAt: null,
    expiresAt: new Date(Date.parse(createdAt) + ttlSeconds * 1000).toISOString(),
  };
  state.principals.set(principal.principalId, principal);
  state.sessions.set(session.sessionId, session);
  return { principal, session, token };
}

export function revokeSession(state: TripState, sessionId: string): ServiceResult<true> {
  const session = state.sessions.get(sessionId);
  if (!session) {
    return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '会话不存在。') };
  }
  state.sessions.set(sessionId, { ...session, revokedAt: state.now() });
  // 撤销会话后，该会话名下的所有一次性许可立即失效。
  state.authorization.invalidateScope({ sessionId, now: state.now() });
  return { ok: true, value: true };
}

/** 主体是否存在且未被删除；给了 sessionId 时还要会话可用。 */
export function activePrincipal(
  state: TripState,
  actorId: string,
  sessionId?: string,
  token?: string,
): ServiceResult<Principal> {
  const principal = state.principals.get(actorId);
  if (!principal || principal.deletedAt) {
    return { ok: false, error: serviceError('RESOURCE_NOT_FOUND', '主体不存在。') };
  }
  if (sessionId) {
    const session = state.sessions.get(sessionId);
    const expiresAt = session ? Date.parse(session.expiresAt) : Number.NaN;
    const now = Date.parse(state.now());
    if (
      !session ||
      session.principalId !== actorId ||
      session.revokedAt ||
      (token !== undefined && session.tokenHash !== digestOpaqueToken(token)) ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(now) ||
      expiresAt <= now
    ) {
      return { ok: false, error: serviceError('SESSION_EXPIRED', '会话已过期。') };
    }
  }
  return { ok: true, value: principal };
}

/** HTTP 入口用：确认 actor/session 组合仍然有效（存在、未撤销、未过期）。 */
/** Remove expired or revoked session rows while invalidating their one-time grants. */
export function pruneInactiveSessions(state: TripState): number {
  const now = state.now();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return 0;
  let removed = 0;
  for (const [sessionId, session] of state.sessions) {
    const expiresAt = Date.parse(session.expiresAt);
    if (!session.revokedAt && Number.isFinite(expiresAt) && expiresAt > nowMs) continue;
    state.authorization.invalidateScope({ sessionId, now });
    state.sessions.delete(sessionId);
    removed += 1;
  }
  return removed;
}

/** 只返回当前主体有效会话的期限，不暴露令牌或其他主体的会话资料。 */
export function sessionExpiry(state: TripState, actorId: string, sessionId: string): string | undefined {
  return activePrincipal(state, actorId, sessionId).ok ? state.sessions.get(sessionId)?.expiresAt : undefined;
}
