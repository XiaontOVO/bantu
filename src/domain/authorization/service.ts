/**
 * 一次性动作许可的状态机。
 *
 * 四条不变量：
 * 1. **许可来自具体动作**：请求由服务端创建并冻结参数摘要，客户端不能自行声明。
 * 2. **一次性**：`consumeGrant` 之后该许可不可再用；重复消费必须失败。
 * 3. **审批组互斥**：同一组内批准一个候选，其余自动失效——避免"两个方案都生效"。
 * 4. **撤销与范围失效**：`revoke` 单条失效，`invalidateScope` 让某次会话或整趟旅行
 *    名下所有许可一起作废（删旅行时用）。
 */
import type { ActionRequest, Grant } from '../types.js';
import { digestArgs } from './digest.js';
import { resolveDisplayedAction, type ConfirmationDecision } from './text.js';
import type { DisplayedAction } from './text.js';

export interface CreateActionRequestInput {
  actionRequestId: string;
  tripId: string;
  actorId: string;
  sessionId: string;
  toolName: string;
  canonicalArgs: unknown;
  summary: string;
  createdAt: string;
  expiresAt: string;
  approvalGroupId?: string;
  baseRevision?: number;
  contextSnapshotId?: string | null;
  proposalId?: string;
  candidateId?: string;
}

export interface AuthorizationMutationResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}

export class ActionAuthorizationService {
  private readonly requests = new Map<string, ActionRequest>();

  private readonly grants = new Map<string, Grant>();

  createRequest(input: CreateActionRequestInput): AuthorizationMutationResult<ActionRequest> {
    if (this.requests.has(input.actionRequestId)) {
      return { ok: false, error: { code: 'ACTION_REQUEST_EXISTS', message: '动作请求已存在。' } };
    }
    const argsDigest = digestArgs(input.canonicalArgs);
    const request: ActionRequest = {
      actionRequestId: input.actionRequestId,
      tripId: input.tripId,
      toolName: input.toolName,
      action: input.toolName,
      canonicalArgs: input.canonicalArgs,
      argsDigest,
      status: 'pending',
      actorId: input.actorId,
      sessionId: input.sessionId,
      actionKey: `${input.toolName}:${input.actionRequestId}`,
      summary: input.summary,
      approvalGroupId: input.approvalGroupId,
      baseRevision: input.baseRevision,
      contextSnapshotId: input.contextSnapshotId ?? null,
      proposalId: input.proposalId,
      candidateId: input.candidateId,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      usedAt: null,
    };
    this.requests.set(request.actionRequestId, request);
    return { ok: true, value: request };
  }

  getRequest(actionRequestId: string): ActionRequest | undefined {
    return this.requests.get(actionRequestId);
  }

  listRequests(): ActionRequest[] {
    return [...this.requests.values()];
  }

  discardPendingRequest(actionRequestId: string): boolean {
    const request = this.requests.get(actionRequestId);
    if (!request || request.status !== 'pending' || this.getActiveGrant(actionRequestId)) return false;
    return this.requests.delete(actionRequestId);
  }

  getActiveGrant(actionRequestId: string): Grant | undefined {
    return [...this.grants.values()].find(
      (grant) => grant.actionRequestId === actionRequestId && grant.status === 'active',
    );
  }

  getGrant(grantId: string): Grant | undefined {
    return this.grants.get(grantId);
  }

  private expireIfNeeded<T extends { status: string; expiresAt?: string }>(
    item: T,
    now: string,
  ): T {
    if (
      (item.status === 'pending' || item.status === 'active') &&
      item.expiresAt !== undefined &&
      Date.parse(item.expiresAt) <= Date.parse(now)
    ) {
      return { ...item, status: item.status === 'pending' ? 'expired' : 'expired' } as T;
    }
    return item;
  }

  /** approve 才会创建 grant；模型自报 approved 没有入口。 */
  decide(
    actionRequestId: string,
    decision: 'approve' | 'reject',
    input: {
      now: string;
      digest?: string;
      confirmationSource?: Grant['confirmationSource'];
      grantId?: string;
      actorId?: string;
      sessionId?: string;
    },
  ): AuthorizationMutationResult<{ request: ActionRequest; grant?: Grant }> {
    const request = this.requests.get(actionRequestId);
    if (!request) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '动作请求不存在。' } };
    }
    const current = this.expireIfNeeded(request, input.now);
    this.requests.set(actionRequestId, current);
    if (current.status !== 'pending') {
      return {
        ok: false,
        error: { code: 'ACTION_AUTHORIZATION_INVALID', message: '动作请求已不在等待确认状态。' },
      };
    }
    if (input.digest !== undefined && input.digest !== current.argsDigest) {
      return { ok: false, error: { code: 'ACTION_AUTHORIZATION_INVALID', message: '动作参数已变化。' } };
    }
    if (input.actorId && input.actorId !== current.actorId) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '动作请求不存在。' } };
    }
    if (input.sessionId && current.sessionId !== '*' && input.sessionId !== current.sessionId) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '动作请求不存在。' } };
    }

    if (decision === 'reject') {
      const rejected: ActionRequest = { ...current, status: 'rejected' };
      this.requests.set(actionRequestId, rejected);
      return { ok: true, value: { request: rejected } };
    }

    // 同审批组互斥：只有一个请求可以拿到 active grant。
    if (current.approvalGroupId) {
      for (const sibling of this.requests.values()) {
        if (
          sibling.actionRequestId !== actionRequestId &&
          sibling.approvalGroupId === current.approvalGroupId &&
          sibling.status === 'pending'
        ) {
          this.requests.set(sibling.actionRequestId, { ...sibling, status: 'cancelled' });
        }
      }
    }

    const grant: Grant = {
      grantId: input.grantId ?? `grant_${actionRequestId}`,
      actionRequestId,
      status: 'active',
      createdAt: input.now,
      expiresAt: current.expiresAt,
      consumedAt: null,
      actorId: current.actorId,
      sessionId: current.sessionId,
      confirmationSource: input.confirmationSource ?? 'button',
    };
    const approved: ActionRequest = { ...current, status: 'approved' };
    this.requests.set(actionRequestId, approved);
    this.grants.set(grant.grantId, grant);
    return { ok: true, value: { request: approved, grant } };
  }

  /** 从文字确认解析并执行同一个授权状态机。 */
  confirmFromText(input: {
    actorId: string;
    sessionId: string;
    text: string;
    displayed: readonly DisplayedAction[];
    now: string;
    replyToActionRequestId?: string;
    digest?: string;
    grantId?: string;
  }): AuthorizationMutationResult<{ request: ActionRequest; grant?: Grant; decision: ConfirmationDecision }> {
    const resolution = resolveDisplayedAction(
      input.text,
      input.displayed,
      input.now,
      input.replyToActionRequestId,
    );
    if (resolution.decision.kind !== 'approve' || !resolution.resolvedActionRequestId) {
      return {
        ok: false,
        error: {
          code: 'ACTION_AUTHORIZATION_REQUIRED',
          message: resolution.reason ?? '需要明确、唯一的用户确认。',
        },
      };
    }
    const result = this.decide(
      resolution.resolvedActionRequestId,
      'approve',
      {
        now: input.now,
        digest: input.digest,
        grantId: input.grantId,
        actorId: input.actorId,
        sessionId: input.sessionId,
        confirmationSource: 'chat',
      },
    );
    if (!result.ok || !result.value) {
      return {
        ok: false,
        error: result.error ?? { code: 'ACTION_AUTHORIZATION_INVALID', message: '许可无效。' },
      };
    }
    return {
      ok: true,
      value: { ...result.value, decision: resolution.decision },
    };
  }

  revoke(
    actionRequestId: string,
    now: string,
  ): AuthorizationMutationResult<{ request: ActionRequest; revokedGrant?: Grant }> {
    const request = this.requests.get(actionRequestId);
    if (!request) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '动作请求不存在。' } };
    }
    if (request.status === 'executed') {
      return { ok: false, error: { code: 'ACTION_ALREADY_EXECUTED', message: '动作已执行，不能撤回。' } };
    }
    if (request.status === 'rejected' || request.status === 'cancelled') {
      return { ok: false, error: { code: 'ACTION_AUTHORIZATION_INVALID', message: '动作请求已终结。' } };
    }
    const grant = [...this.grants.values()].find((item) => item.actionRequestId === actionRequestId);
    let revokedGrant: Grant | undefined;
    if (grant && grant.status === 'active') {
      revokedGrant = { ...grant, status: 'revoked' };
      this.grants.set(grant.grantId, revokedGrant);
    }
    const next: ActionRequest = { ...request, status: 'cancelled' };
    this.requests.set(actionRequestId, next);
    return { ok: true, value: { request: next, revokedGrant } };
  }

  /**
   * 只校验许可是否可用于当前动作，不消费。
   * 供需要把消费放进业务事务的统一命令处理器使用。
   */
  validateGrant(input: {
    grantId: string;
    actionRequestId?: string;
    actorId?: string;
    sessionId?: string;
    digest?: string;
    now: string;
  }): AuthorizationMutationResult<{ request: ActionRequest; grant: Grant }> {
    const grant = this.grants.get(input.grantId);
    if (!grant || grant.status !== 'active' || Date.parse(grant.expiresAt) <= Date.parse(input.now)) {
      return { ok: false, error: { code: 'ACTION_AUTHORIZATION_INVALID', message: '许可无效或已过期。' } };
    }
    const request = this.requests.get(grant.actionRequestId);
    if (!request || request.status !== 'approved') {
      return { ok: false, error: { code: 'ACTION_AUTHORIZATION_INVALID', message: '动作请求状态无效。' } };
    }
    if (input.actionRequestId && input.actionRequestId !== request.actionRequestId) {
      return { ok: false, error: { code: 'ACTION_AUTHORIZATION_INVALID', message: '许可与动作不匹配。' } };
    }
    if (input.actorId && input.actorId !== request.actorId) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '许可不存在。' } };
    }
    if (input.sessionId && request.sessionId !== '*' && input.sessionId !== request.sessionId) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '许可不存在。' } };
    }
    if (input.digest && input.digest !== request.argsDigest) {
      return { ok: false, error: { code: 'ACTION_AUTHORIZATION_INVALID', message: '动作参数已变化。' } };
    }
    return { ok: true, value: { request, grant } };
  }

  /**
   * 统一消费许可。只有参数摘要一致、未过期、未使用且 actor/session 匹配才能成功。
   * 成功返回 consumed 状态，调用方必须与业务写入放入同一事务。
   */
  consumeGrant(input: {
    grantId: string;
    actionRequestId?: string;
    actorId?: string;
    sessionId?: string;
    digest?: string;
    now: string;
  }): AuthorizationMutationResult<{ request: ActionRequest; grant: Grant }> {
    const validated = this.validateGrant(input);
    if (!validated.ok || !validated.value) return validated;
    const { request, grant } = validated.value;
    const consumed: Grant = { ...grant, status: 'consumed', consumedAt: input.now };
    const executed: ActionRequest = { ...request, status: 'executed', usedAt: input.now };
    this.grants.set(consumed.grantId, consumed);
    this.requests.set(executed.actionRequestId, executed);
    return { ok: true, value: { request: executed, grant: consumed } };
  }

  /** 供本地备份／恢复演练使用；生产实现应使用数据库事务和行锁。 */
  serialize(): string {
    return JSON.stringify({
      requests: [...this.requests.values()],
      grants: [...this.grants.values()],
    });
  }

  loadSerialized(serialized: string): void {
    const parsed = JSON.parse(serialized) as {
      requests?: ActionRequest[];
      grants?: Grant[];
    };
    this.requests.clear();
    this.grants.clear();
    for (const request of parsed.requests ?? []) this.requests.set(request.actionRequestId, request);
    for (const grant of parsed.grants ?? []) this.grants.set(grant.grantId, grant);
  }

  /** 会话退出/删除旅行时批量失效。 */
  invalidateScope(input: {
    now: string;
    actorId?: string;
    sessionId?: string;
    tripId?: string;
  }): number {
    let count = 0;
    for (const [id, request] of this.requests) {
      const matchesActor = input.actorId !== undefined && request.actorId === input.actorId;
      const matchesSession = input.sessionId !== undefined && request.sessionId === input.sessionId;
      const matchesTrip = input.tripId !== undefined && request.tripId === input.tripId;
      if (!matchesActor && !matchesSession && !matchesTrip) continue;
      if (request.status === 'pending' || request.status === 'approved') {
        this.requests.set(id, { ...request, status: 'cancelled' });
        count += 1;
      }
      const grant = [...this.grants.values()].find((item) => item.actionRequestId === id);
      if (grant?.status === 'active') {
        this.grants.set(grant.grantId, { ...grant, status: 'revoked' });
      }
    }
    return count;
  }
}
