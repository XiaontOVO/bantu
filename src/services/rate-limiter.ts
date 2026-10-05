export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Counter {
  count: number;
  resetAtMs: number;
}

/**
 * 进程内固定窗口限流器。
 * 参数默认值来自 docs/06 §3；生产部署应替换为共享存储并记录限流原因。
 */
export class InMemoryRateLimiter {
  private readonly counters = new Map<string, Counter>();

  /** 超过该规模时顺带清理已过期窗口，避免每个不同 key 常驻内存。 */
  private static readonly PRUNE_THRESHOLD = 1000;

  private prune(nowMs: number): void {
    if (this.counters.size < InMemoryRateLimiter.PRUNE_THRESHOLD) return;
    for (const [key, counter] of this.counters) {
      if (counter.resetAtMs <= nowMs) this.counters.delete(key);
    }
  }

  check(key: string, limit: number, windowSeconds: number, nowMs = Date.now()): RateLimitDecision {
    const current = this.counters.get(key);
    if (!current || current.resetAtMs <= nowMs) {
      return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
    }
    const remaining = Math.max(0, limit - current.count);
    return {
      allowed: current.count < limit,
      remaining,
      retryAfterSeconds: current.count < limit ? 0 : Math.ceil((current.resetAtMs - nowMs) / 1000),
    };
  }

  consume(
    key: string,
    limit: number,
    windowSeconds: number,
    nowMs = Date.now(),
  ): RateLimitDecision {
    const current = this.counters.get(key);
    if (!current || current.resetAtMs <= nowMs) {
      const resetAtMs = nowMs + windowSeconds * 1000;
      this.counters.set(key, { count: 1, resetAtMs });
      this.prune(nowMs);
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((current.resetAtMs - nowMs) / 1000),
      };
    }
    current.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - current.count),
      retryAfterSeconds: 0,
    };
  }

  reset(key?: string): void {
    if (key) this.counters.delete(key);
    else this.counters.clear();
  }
}
