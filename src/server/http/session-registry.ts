import { digestOpaqueToken } from '../../domain/token-hash.js';
import type { SessionBinding } from './request.js';

type PersistedSessionRegistry = {
  version: 2;
  entries: Array<[string, SessionBinding]>;
};

export type SessionRestoreFormat = 'legacy' | 'current' | 'invalid';

/** Map-like cookie-token lookup that keeps only token digests in memory and on disk. */
export class SessionRegistry {
  private readonly bindings = new Map<string, SessionBinding>();

  get(token: string): SessionBinding | undefined {
    return this.bindings.get(digestOpaqueToken(token));
  }

  set(token: string, binding: SessionBinding): this {
    this.bindings.set(digestOpaqueToken(token), binding);
    return this;
  }

  delete(token: string): boolean {
    return this.bindings.delete(digestOpaqueToken(token));
  }

  prune(isValid: (binding: SessionBinding) => boolean): number {
    let removed = 0;
    for (const [digest, binding] of this.bindings) {
      if (isValid(binding)) continue;
      this.bindings.delete(digest);
      removed += 1;
    }
    return removed;
  }

  serialize(): string {
    const value: PersistedSessionRegistry = {
      version: 2,
      entries: [...this.bindings.entries()],
    };
    return JSON.stringify(value);
  }

  restore(serialized: string): SessionRestoreFormat {
    this.bindings.clear();
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return 'invalid';
    }

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !isSessionBinding(entry[1])) continue;
        this.set(entry[0], entry[1]);
      }
      return 'legacy';
    }

    if (!parsed || typeof parsed !== 'object') return 'invalid';
    const value = parsed as Partial<PersistedSessionRegistry>;
    if (value.version !== 2 || !Array.isArray(value.entries)) return 'invalid';
    for (const entry of value.entries) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(entry[0]) ||
        !isSessionBinding(entry[1])
      ) continue;
      this.bindings.set(entry[0], entry[1]);
    }
    return 'current';
  }
}

function isSessionBinding(value: unknown): value is SessionBinding {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as SessionBinding).actorId === 'string' &&
    typeof (value as SessionBinding).sessionId === 'string',
  );
}
