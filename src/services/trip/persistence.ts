/**
 * 本地备份的序列化与恢复。
 *
 * 这是**离线恢复演练**用的实现，不替代生产 PostgreSQL 备份；两者必须保持同一套语义：
 * 恢复后仍然要重放删除清单、重新校验证据引用，并且**不能**把已删除的旅行复活。
 *
 * `proposals` 与 `shortlist`／`feedback` 在内存里分别是 Map 与数组，
 * JSON 会把 Map 变成 `{}`，所以这里显式在两侧做转换。
 */
import type { Proposal } from '../../domain/types.js';
import type { Principal, Session, TripRecord } from './contracts.js';
import type { TripState } from './state.js';

interface SerializedService {
  principals: Principal[];
  sessions: Session[];
  trips: Array<Omit<TripRecord, 'proposals'> & { proposals: Array<[string, Proposal]> }>;
  authorization: string;
  idempotency: string;
}

export function serialize(state: TripState): string {
  const payload: SerializedService = {
    principals: [...state.principals.values()],
    sessions: [...state.sessions.values()],
    trips: [...state.trips.values()].map((record) => ({
      ...record,
      proposals: [...record.proposals.entries()],
    })),
    authorization: state.authorization.serialize(),
    idempotency: state.idempotency.serialize(),
  };
  return JSON.stringify(payload);
}

export function loadSerialized(state: TripState, serialized: string): void {
  const parsed = JSON.parse(serialized) as Partial<SerializedService>;

  state.principals.clear();
  for (const principal of parsed.principals ?? []) {
    state.principals.set(principal.principalId, principal);
  }

  state.sessions.clear();
  for (const session of parsed.sessions ?? []) {
    state.sessions.set(session.sessionId, session);
  }

  state.trips.clear();
  for (const serializedTrip of parsed.trips ?? []) {
    const { proposals, ...rest } = serializedTrip;
    const legacy = rest as TripRecord;
    const contentRevision = Number.isInteger(legacy.contentRevision)
      ? legacy.contentRevision
      : Number.isInteger(legacy.revision) ? legacy.revision : 0;
    state.trips.set(serializedTrip.tripId, {
      ...legacy,
      proposals: new Map(proposals),
      // Older local backups predate these fields; fill them before any trip route runs.
      shortlist: rest.shortlist ?? [],
      feedback: rest.feedback ?? [],
      contentRevision,
      memories: legacy.memories && Array.isArray(legacy.memories.entries)
        ? { ...legacy.memories, tripId: serializedTrip.tripId, contentRevision }
        : { tripId: serializedTrip.tripId, contentRevision, entries: [] },
    });
  }

  if (parsed.authorization) state.authorization.loadSerialized(parsed.authorization);
  if (parsed.idempotency) state.idempotency.loadSerialized(parsed.idempotency);
}
