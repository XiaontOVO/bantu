/**
 * TripService 的对外契约：命令入参、结果与视图形状。
 *
 * 只放类型，不放实现：http 层、agent 层与测试都能引用契约，
 * 而不必把服务实现拉进依赖图。实现见 ../trip-service.ts。
 */

import type { ActionAuthorizationService } from '../../domain/authorization.js';
import type { MemoryResult, MemoryState } from '../../domain/memory.js';
import type { ExecutionEventType, PlanChange, PlanCheck, Proposal, TripSnapshot } from '../../domain/types.js';
import type { PlanVersion } from '../../domain/versioning.js';

export interface ServiceError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ServiceError };

export interface Principal {
  principalId: string;
  kind: 'anonymous' | 'account';
  createdAt: string;
  deletedAt: string | null;
}

export interface Session {
  sessionId: string;
  principalId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface TripRecord {
  tripId: string;
  ownerId: string;
  dataMode: 'online' | 'demo';
  lifecycle: 'draft' | 'active' | 'completed' | 'archived';
  revision: number;
  contentRevision: number;
  timezone: string;
  /** 日期待定的旅行没有 localDate；绑定日期后才有。 */
  localDate?: string;
  cityCode: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  latestContextId: string | null;
  snapshot: TripSnapshot;
  versions: PlanVersion[];
  proposals: Map<string, Proposal>;
  mutations: MutationView[];
  memories: MemoryState;
  shortlist: string[];
  feedback: FeedbackRecord[];
}

export interface FeedbackRecord {
  feedbackId: string;
  tripId: string;
  rating: number | null;
  reasonCode: string | null;
  note: string | null;
  operationId: string | null;
  createdAt: string;
}

export interface MutationView {
  mutationId: string;
  tripId: string;
  actorId: string;
  action: string;
  beforeRevision: number;
  afterRevision: number;
  reversesId: string | null;
  createdAt: string;
}

export interface TripView {
  trip: {
    tripId: string;
    dataMode: 'online' | 'demo';
    lifecycle: string;
    planningStatus: string;
    revision: number;
    contentRevision: number;
    timezone: string;
    localDate?: string;
    cityCode: string;
    latestContextId: string | null;
    deletedAt: string | null;
  };
  snapshot: TripSnapshot;
  versionCount: number;
  clock?: ReturnType<typeof import('../../domain/plan-boundaries.js').tripClock>;
  previousPlanRevision?: number | null;
  latestProposalId?: string | null;
  pendingActionRequests: Array<{
    actionRequestId: string;
    summary: string;
    status: string;
    expiresAt: string;
  }>;
}

export interface CreateTripInput {
  cityCode: string;
  /** 可缺省＝日期待定。 */
  localDate?: string;
  timezone?: string;
  dataMode: 'online' | 'demo';
  partySize?: number;
  budgetMinor?: number | null;
  budgetStrength?: 'hard' | 'soft';
}

export interface PatchTripInput {
  expectedRevision: number;
  /** 挂载方案专用：允许包含当天已过去时段的站点（不用于普通编辑）。 */
  allowPast?: boolean;
  cityCode?: string;
  localDate?: string;
  partySize?: number;
  partyNeeds?: Record<string, Record<string, unknown>>;
  constraints?: TripSnapshot['constraints'];
  budget?: TripSnapshot['budget'];
  stops?: TripSnapshot['stops'];
  routeLegs?: TripSnapshot['routeLegs'];
  plannedCharges?: TripSnapshot['plannedCharges'];
  dayStartMinutes?: number;
}

export interface CreateProposalInput {
  kind: 'initial' | 'replan';
  baseRevision: number;
  candidates: Array<{
    candidateId?: string;
    title: string;
    summary: string;
    snapshot: TripSnapshot;
    changes?: PlanChange[];
    checks?: PlanCheck[];
    evidenceRefs?: string[];
  }>;
  contextSnapshotId?: string | null;
  expiresAt?: string;
  proposalId?: string;
  algorithmVersion?: string;
  promptVersion?: string;
  generationKey?: string;
  /** 委托来源会话；省略时授权卡使用通配会话，仅用于内部/测试调用。 */
  sessionId?: string;
}

export interface ProposalView {
  proposal: Proposal;
  actionRequests: ReturnType<ActionAuthorizationService['getRequest']>[];
}

export interface ApplyProposalCommand {
  actorId: string;
  sessionId: string;
  tripId: string;
  proposalId: string;
  candidateId?: string;
  expectedRevision: number;
  actionRequestId: string;
  grantId: string;
  idempotencyKey: string;
  now?: string;
}

export interface AppliedProposalValue {
  trip: TripView;
  mutationId: string;
  revision: number;
  actionRequestId: string;
  grantId: string;
}

export interface UndoCommand {
  actorId: string;
  sessionId: string;
  tripId: string;
  mutationId: string;
  expectedRevision: number;
  idempotencyKey: string;
  now?: string;
}

export interface ExecutionCommand {
  actorId: string;
  sessionId: string;
  tripId: string;
  stopId: string;
  type: ExecutionEventType;
  occurredAt: string;
  expectedRevision?: number;
  now?: string;
}

export interface SpendCommand {
  actorId: string;
  tripId: string;
  amountMinor: number;
  completenessConfirmed: boolean;
  includedChargeIds?: string[];
  occurredAt: string;
  expectedRevision?: number;
  now?: string;
}

export interface MemoryCommandResult {
  trip: TripView;
  memory?: MemoryResult['entry'];
}
