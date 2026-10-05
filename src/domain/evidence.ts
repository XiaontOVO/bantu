export type EvidenceStatus = 'active' | 'paused' | 'expired';

export interface EvidenceRecord {
  evidenceId: string;
  sourceType: string;
  sourceUrl?: string | null;
  observedAt?: string | null;
  retrievedAt: string;
  validFrom?: string | null;
  validUntil?: string | null;
  dataMode: 'online' | 'demo';
  verificationStatus: string;
  status?: EvidenceStatus;
  payloadRef?: unknown;
  erasedAt?: string | null;
}

export interface EvidenceValidation {
  ok: boolean;
  code?: string;
  evidenceId?: string;
  message?: string;
}

/**
 * 关键证据注册表。
 * 生产实现对应 docs/03 evidence／catalog 行锁；这里提供纯内存语义与测试。
 */
export class InMemoryEvidenceRegistry {
  private readonly records = new Map<string, EvidenceRecord>();

  upsert(record: EvidenceRecord): void {
    this.records.set(record.evidenceId, {
      ...record,
      status: record.status ?? 'active',
      erasedAt: record.erasedAt ?? null,
    });
  }

  get(evidenceId: string): EvidenceRecord | undefined {
    return this.records.get(evidenceId);
  }

  list(): EvidenceRecord[] {
    return [...this.records.values()];
  }

  serialize(): string {
    return JSON.stringify([...this.records.values()]);
  }

  loadSerialized(serialized: string): void {
    const records = JSON.parse(serialized) as EvidenceRecord[];
    this.records.clear();
    for (const record of records) {
      this.records.set(record.evidenceId, record);
    }
  }

  pause(evidenceId: string): boolean {
    const record = this.records.get(evidenceId);
    if (!record) return false;
    this.records.set(evidenceId, { ...record, status: 'paused' });
    return true;
  }

  resume(evidenceId: string): boolean {
    const record = this.records.get(evidenceId);
    if (!record) return false;
    this.records.set(evidenceId, { ...record, status: 'active' });
    return true;
  }

  expire(evidenceId: string): boolean {
    const record = this.records.get(evidenceId);
    if (!record) return false;
    this.records.set(evidenceId, { ...record, status: 'expired' });
    return true;
  }

  validateRefs(evidenceIds: readonly string[], now: string): EvidenceValidation {
    for (const evidenceId of evidenceIds) {
      const record = this.records.get(evidenceId);
      if (!record) {
        return {
          ok: false,
          code: 'EVIDENCE_INSUFFICIENT',
          evidenceId,
          message: '关键证据不存在或已被擦除。',
        };
      }
      if (record.status !== 'active') {
        return {
          ok: false,
          code: 'EVIDENCE_INSUFFICIENT',
          evidenceId,
          message: `关键证据当前状态为 ${record.status}。`,
        };
      }
      if (record.validFrom && Date.parse(now) < Date.parse(record.validFrom)) {
        return {
          ok: false,
          code: 'EVIDENCE_INSUFFICIENT',
          evidenceId,
          message: '关键证据尚未生效。',
        };
      }
      if (record.validUntil && Date.parse(now) > Date.parse(record.validUntil)) {
        return {
          ok: false,
          code: 'PROPOSAL_EXPIRED',
          evidenceId,
          message: '关键证据已经过期。',
        };
      }
    }
    return { ok: true };
  }
}
