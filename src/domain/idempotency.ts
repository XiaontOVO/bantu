import { digestArgs } from './authorization.js';

export type IdempotencyStatus = 'in_progress' | 'completed' | 'failed';

export interface IdempotencyRecord<T = unknown> {
  actorId: string;
  scope: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  response?: T;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type BeginIdempotencyResult<T> =
  | { kind: 'new'; record: IdempotencyRecord<T> }
  | { kind: 'replay'; record: IdempotencyRecord<T> }
  | { kind: 'in_progress'; record: IdempotencyRecord<T> }
  | { kind: 'conflict'; record: IdempotencyRecord<T> };

function compositeKey(actorId: string, scope: string, key: string): string {
  return `${actorId}\u0000${scope}\u0000${key}`;
}

/**
 * docs/03 §3.3 的 HTTP 幂等与业务动作幂等基础。
 * 同键同请求返回原结果；同键不同请求体返回冲突；进行中的请求不会被第二次执行。
 */
export class IdempotencyStore<T = unknown> {
  private readonly records = new Map<string, IdempotencyRecord<T>>();
  private beginCount = 0;

  private pruneExpired(now: string): void {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return;
    for (const [id, record] of this.records) {
      if (record.expiresAt && Date.parse(record.expiresAt) <= nowMs) this.records.delete(id);
    }
  }

  begin(input: {
    actorId: string;
    scope: string;
    key: string;
    requestBody: unknown;
    now: string;
    ttlSeconds?: number;
  }): BeginIdempotencyResult<T> {
    // Keep abandoned chat and mutation keys from accumulating forever. Sweep infrequently
    // to avoid scanning the whole store on every request.
    this.beginCount += 1;
    if (this.beginCount % 64 === 0) this.pruneExpired(input.now);
    const id = compositeKey(input.actorId, input.scope, input.key);
    const requestHash = digestArgs(input.requestBody);
    const existing = this.records.get(id);

    if (existing) {
      if (existing.expiresAt && Date.parse(existing.expiresAt) <= Date.parse(input.now)) {
        this.records.delete(id);
      } else if (existing.requestHash !== requestHash) {
        return { kind: 'conflict', record: existing };
      } else if (existing.status === 'completed' || existing.status === 'failed') {
        return { kind: 'replay', record: existing };
      } else {
        return { kind: 'in_progress', record: existing };
      }
    }

    const ttl = input.ttlSeconds ?? 24 * 60 * 60;
    const record: IdempotencyRecord<T> = {
      actorId: input.actorId,
      scope: input.scope,
      key: input.key,
      requestHash,
      status: 'in_progress',
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: new Date(Date.parse(input.now) + ttl * 1000).toISOString(),
    };
    this.records.set(id, record);
    return { kind: 'new', record };
  }

  complete(
    actorId: string,
    scope: string,
    key: string,
    response: T,
    now: string,
  ): IdempotencyRecord<T> {
    const id = compositeKey(actorId, scope, key);
    const existing = this.records.get(id);
    if (!existing) {
      throw new Error('idempotency record not found');
    }
    const next: IdempotencyRecord<T> = {
      ...existing,
      status: 'completed',
      response,
      error: undefined,
      updatedAt: now,
    };
    this.records.set(id, next);
    return next;
  }

  fail(
    actorId: string,
    scope: string,
    key: string,
    error: { code: string; message: string },
    now: string,
  ): IdempotencyRecord<T> {
    const id = compositeKey(actorId, scope, key);
    const existing = this.records.get(id);
    if (!existing) throw new Error('idempotency record not found');
    const next: IdempotencyRecord<T> = {
      ...existing,
      status: 'failed',
      error,
      updatedAt: now,
    };
    this.records.set(id, next);
    return next;
  }

  get(actorId: string, scope: string, key: string): IdempotencyRecord<T> | undefined {
    return this.records.get(compositeKey(actorId, scope, key));
  }

  serialize(): string {
    return JSON.stringify([...this.records.entries()]);
  }

  loadSerialized(serialized: string): void {
    const entries = JSON.parse(serialized) as Array<[string, IdempotencyRecord<T>]>;
    this.records.clear();
    for (const [key, record] of entries) this.records.set(key, record);
  }
}

/** 只有已成功的历史结果才能对“已删除资源”安全重放；否则返回特殊标记。 */
export function canReplayResponse<T>(
  record: IdempotencyRecord<T> | undefined,
  resourceDeleted: boolean,
): boolean {
  return Boolean(record?.status === 'completed' && !resourceDeleted);
}
