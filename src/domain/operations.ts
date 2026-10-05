import type { Operation, OperationStatus } from './types.js';

export const TERMINAL_OPERATION_STATUSES: readonly OperationStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export function isTerminalOperationStatus(status: OperationStatus): boolean {
  return TERMINAL_OPERATION_STATUSES.includes(status);
}

export interface OperationMutationResult {
  ok: boolean;
  operation?: Operation;
  error?: { code: string; message: string };
}

/**
 * 内存版 Operation 状态与租约控制。
 * 语义对应 docs/03 §2.3/§3.5：终态不可覆盖，旧租约不能写结果。
 */
export class OperationStore {
  private readonly operations = new Map<string, Operation>();

  create(operation: Operation): OperationMutationResult {
    if (this.operations.has(operation.operationId)) {
      return { ok: false, error: { code: 'OPERATION_EXISTS', message: '任务已存在。' } };
    }
    const now = operation.updatedAt;
    const stored: Operation = {
      ...operation,
      status: operation.status ?? 'queued',
      createdAt: operation.createdAt || now,
      updatedAt: now,
      usageTotals: operation.usageTotals ?? {},
    };
    this.operations.set(stored.operationId, stored);
    return { ok: true, operation: stored };
  }

  get(operationId: string): Operation | undefined {
    return this.operations.get(operationId);
  }

  list(): Operation[] {
    return [...this.operations.values()];
  }

  serialize(): string {
    return JSON.stringify([...this.operations.values()]);
  }

  loadSerialized(serialized: string): void {
    const operations = JSON.parse(serialized) as Operation[];
    this.operations.clear();
    for (const operation of operations) {
      this.operations.set(operation.operationId, operation);
    }
  }

  private save(operation: Operation): Operation {
    this.operations.set(operation.operationId, operation);
    return operation;
  }

  private canClaim(operation: Operation, now: string): boolean {
    if (isTerminalOperationStatus(operation.status)) return false;
    if (operation.cancelRequestedAt) return false;
    if (operation.status === 'awaiting_input' || operation.status === 'awaiting_approval') return false;
    if (operation.status === 'queued') return true;
    if (operation.status === 'running') {
      return !operation.leaseUntil || Date.parse(operation.leaseUntil) <= Date.parse(now);
    }
    return false;
  }

  /** 领取租约是独立短事务；旧租约过期后新 worker 可以领取。 */
  claim(
    operationId: string,
    leaseToken: string,
    now: string,
    leaseSeconds = 15,
  ): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    if (!this.canClaim(operation, now)) {
      if (isTerminalOperationStatus(operation.status)) {
        return { ok: false, error: { code: 'OPERATION_TERMINAL', message: '任务已经结束。' } };
      }
      return { ok: false, error: { code: 'OPERATION_LEASED', message: '任务正被其他执行者处理。' } };
    }
    const next: Operation = {
      ...operation,
      status: 'running',
      leaseToken,
      leaseUntil: new Date(Date.parse(now) + leaseSeconds * 1000).toISOString(),
      updatedAt: now,
    };
    return { ok: true, operation: this.save(next) };
  }

  heartbeat(
    operationId: string,
    leaseToken: string,
    now: string,
    leaseSeconds = 15,
  ): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    if (operation.leaseToken !== leaseToken || operation.status !== 'running') {
      return { ok: false, error: { code: 'LEASE_LOST', message: '任务租约已失效。' } };
    }
    const next: Operation = {
      ...operation,
      leaseUntil: new Date(Date.parse(now) + leaseSeconds * 1000).toISOString(),
      updatedAt: now,
    };
    return { ok: true, operation: this.save(next) };
  }

  /** 终态写入以 leaseToken、running、未取消为条件；失败不影响已有终态。 */
  complete(
    operationId: string,
    leaseToken: string,
    result: Record<string, unknown>,
    now: string,
  ): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    if (isTerminalOperationStatus(operation.status)) {
      return { ok: false, error: { code: 'OPERATION_TERMINAL', message: '任务已经结束。' } };
    }
    if (operation.status !== 'running' || operation.leaseToken !== leaseToken) {
      return { ok: false, error: { code: 'LEASE_LOST', message: '任务租约已失效。' } };
    }
    if (operation.cancelRequestedAt) {
      // 取消请求必须在提交前落库：否则该任务既不能再次被领取（canClaim 拒绝 cancelRequestedAt），
      // 又永远停在 running／等待态，成为无法收敛的僵尸任务。
      this.save({
        ...operation,
        status: 'cancelled',
        leaseToken: null,
        leaseUntil: null,
        updatedAt: now,
      });
      return { ok: false, error: { code: 'OPERATION_CANCELLED', message: '任务已取消。' } };
    }
    const next: Operation = {
      ...operation,
      status: 'succeeded',
      result,
      resultRef: typeof result.ref === 'string' ? result.ref : operation.resultRef,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: now,
    };
    this.save(next);
    return { ok: true, operation: next };
  }

  fail(
    operationId: string,
    leaseToken: string | null,
    error: { code: string; message: string; retryable?: boolean },
    now: string,
  ): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    if (isTerminalOperationStatus(operation.status)) {
      return { ok: false, error: { code: 'OPERATION_TERMINAL', message: '任务已经结束。' } };
    }
    if (leaseToken !== null && operation.leaseToken !== leaseToken) {
      return { ok: false, error: { code: 'LEASE_LOST', message: '任务租约已失效。' } };
    }
    const next: Operation = {
      ...operation,
      status: 'failed',
      error,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: now,
    };
    this.save(next);
    return { ok: true, operation: next };
  }

  /**
   * 请求取消：queued 直接 cancelled；running 只写 cancelRequestedAt，
   * 由持有者在提交前检查，已提交动作不会被回滚。
   */
  cancel(operationId: string, now: string): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    if (isTerminalOperationStatus(operation.status)) {
      return { ok: false, error: { code: 'OPERATION_TERMINAL', message: '任务已经结束。' } };
    }
    if (operation.status === 'queued') {
      const next: Operation = {
        ...operation,
        status: 'cancelled',
        cancelRequestedAt: now,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: now,
      };
      return { ok: true, operation: this.save(next) };
    }
    return {
      ok: true,
      operation: this.save({ ...operation, cancelRequestedAt: now, updatedAt: now }),
    };
  }

  /** 需要追问或许可时释放 worker；等待态不占执行槽。 */
  pause(
    operationId: string,
    leaseToken: string,
    status: 'awaiting_input' | 'awaiting_approval',
    options: { now: string; waitUntil: string; checkpointRef?: string | null },
  ): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    if (isTerminalOperationStatus(operation.status)) {
      return { ok: false, error: { code: 'OPERATION_TERMINAL', message: '任务已经结束。' } };
    }
    if (operation.leaseToken !== leaseToken || operation.status !== 'running') {
      return { ok: false, error: { code: 'LEASE_LOST', message: '任务租约已失效。' } };
    }
    const next: Operation = {
      ...operation,
      status,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: options.now,
      checkpointRef: options.checkpointRef ?? operation.checkpointRef,
      inputExpiresAt: status === 'awaiting_input' ? options.waitUntil : operation.inputExpiresAt,
      approvalExpiresAt:
        status === 'awaiting_approval' ? options.waitUntil : operation.approvalExpiresAt,
    };
    return { ok: true, operation: this.save(next) };
  }

  /** 有效补充答案或许可回到队列；累计预算不重置。 */
  resume(
    operationId: string,
    now: string,
    expectedStatus: 'awaiting_input' | 'awaiting_approval',
  ): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    if (isTerminalOperationStatus(operation.status)) {
      return { ok: false, error: { code: 'OPERATION_TERMINAL', message: '任务已经结束。' } };
    }
    if (operation.status !== expectedStatus) {
      return {
        ok: false,
        error: { code: 'INVALID_OPERATION_STATE', message: '任务不在等待该输入的状态。' },
      };
    }
    const deadline =
      expectedStatus === 'awaiting_input' ? operation.inputExpiresAt : operation.approvalExpiresAt;
    if (operation.cancelRequestedAt) {
      // 取消请求必须在提交前落库：否则该任务既不能再次被领取（canClaim 拒绝 cancelRequestedAt），
      // 又永远停在 running／等待态，成为无法收敛的僵尸任务。
      this.save({
        ...operation,
        status: 'cancelled',
        leaseToken: null,
        leaseUntil: null,
        updatedAt: now,
      });
      return { ok: false, error: { code: 'OPERATION_CANCELLED', message: '任务已取消。' } };
    }
    if (deadline && Date.parse(deadline) <= Date.parse(now)) {
      const expired: Operation = {
        ...operation,
        status: 'failed',
        error: { code: 'OPERATION_TIMEOUT', message: '等待输入或许可已超时。' },
        updatedAt: now,
      };
      this.save(expired);
      return { ok: false, error: { code: 'OPERATION_TIMEOUT', message: '等待输入或许可已超时。' } };
    }
    const next: Operation = {
      ...operation,
      status: 'queued',
      availableAt: now,
      updatedAt: now,
    };
    return { ok: true, operation: this.save(next) };
  }

  /** 只有可恢复错误在预算内重试，用户任务创建新 operationId 并由调用方设置 retryOf。 */
  retry(operationId: string, now: string): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    if (operation.status !== 'failed') {
      return { ok: false, error: { code: 'INVALID_OPERATION_STATE', message: '只有失败任务可以重试。' } };
    }
    const next: Operation = {
      ...operation,
      operationId: `${operation.operationId}:retry:${Date.now().toString(36)}`,
      status: 'queued',
      retryOf: operation.operationId,
      attempt: (operation as Operation & { attempt?: number }).attempt ?? 0,
      error: null,
      result: undefined,
      resultRef: null,
      leaseToken: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
    } as Operation;
    return { ok: true, operation: this.save(next) };
  }

  recordUsage(
    operationId: string,
    usage: Record<string, number>,
    now: string,
  ): OperationMutationResult {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在。' } };
    }
    const totals = { ...(operation.usageTotals ?? {}) };
    for (const [key, value] of Object.entries(usage)) {
      totals[key] = (totals[key] ?? 0) + value;
    }
    return { ok: true, operation: this.save({ ...operation, usageTotals: totals, updatedAt: now }) };
  }
}
