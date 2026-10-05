/**
 * TripService 的共享状态。
 *
 * 服务本身是一个门面：把状态收进这个对象后，各功能分区（身份、旅行、提案、
 * 执行、回忆……）可以作为独立模块接收 `TripState` 工作，而不必挤在同一个类里。
 */
import type { InMemoryEvidenceRegistry } from '../../domain/evidence.js';
import type { ActionAuthorizationService } from '../../domain/authorization.js';
import type { IdempotencyStore } from '../../domain/idempotency.js';
import type { Principal, Session, TripRecord } from './contracts.js';
import type { ExpiredTripPlanDay } from '../plan-library.js';

export interface TripState {
  principals: Map<string, Principal>;
  sessions: Map<string, Session>;
  trips: Map<string, TripRecord>;
  authorization: ActionAuthorizationService;
  idempotency: IdempotencyStore<unknown>;
  now: () => string;
  options: {
    evidenceRegistry?: InMemoryEvidenceRegistry;
    archiveExpiredPlanDay?: (input: ExpiredTripPlanDay) => void;
  };
}
