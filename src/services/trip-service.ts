/**
 * 内存版 TripService 门面。
 *
 * 它只做两件事：持有共享状态，把每个命令转发给 `trip/` 下的功能分区模块。
 * 业务规则一律不在这里——这样新增能力时是往对应分区加函数，而不是改动一个巨型类。
 *
 * 有意不依赖数据库/框架，便于在受限环境运行质量检查；
 * 生产适配层应保持相同命令语义，把版本、授权、幂等记录和业务写入放进同一事务。
 * 结构说明见 docs/09-代码模块地图.md。
 */

import type { ContextSnapshot, StopStatus, ExecutionEventType, Proposal } from '../domain/types.js';
import { ActionAuthorizationService } from '../domain/authorization.js';
import { IdempotencyStore } from '../domain/idempotency.js';
import type { InMemoryEvidenceRegistry } from '../domain/evidence.js';
import type { MemoryResult } from '../domain/memory.js';
import type { ExpiredTripPlanDay } from './plan-library.js';

export * from './trip/contracts.js';
import type {
  AppliedProposalValue,
  ApplyProposalCommand,
  CreateProposalInput,
  CreateTripInput,
  ExecutionCommand,
  FeedbackRecord,
  MemoryCommandResult,
  PatchTripInput,
  Principal,
  ProposalView,
  ServiceResult,
  Session,
  SpendCommand,
  TripRecord,
  TripView,
  UndoCommand,
} from './trip/contracts.js';
import * as memoryOps from './trip/memories.js';
import * as executionOps from './trip/execution.js';
import * as trips from './trip/trips.js';
import * as proposalOps from './trip/proposals.js';
import * as applyOps from './trip/apply.js';
import * as controls from './trip/controls.js';
import * as persistence from './trip/persistence.js';
import { activePrincipal, createAnonymousSession, pruneInactiveSessions, revokeSession, sessionExpiry } from './trip/identity.js';
import type { TripState } from './trip/state.js';

export class InMemoryTripService {
  private readonly principals = new Map<string, Principal>();

  private readonly sessions = new Map<string, Session>();

  private readonly trips = new Map<string, TripRecord>();

  readonly authorization = new ActionAuthorizationService();

  readonly idempotency = new IdempotencyStore<unknown>();

  /** 功能分区模块看到的共享状态；与上面的字段指向同一批 Map。 */
  private readonly state: TripState;

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly options: {
      evidenceRegistry?: InMemoryEvidenceRegistry;
      archiveExpiredPlanDay?: (input: ExpiredTripPlanDay) => void;
    } = {},
  ) {
    this.state = {
      principals: this.principals,
      sessions: this.sessions,
      trips: this.trips,
      authorization: this.authorization,
      idempotency: this.idempotency,
      now: this.now,
      options: this.options,
    };
  }

  // ---------- identity ----------

  createAnonymousSession(ttlSeconds = 30 * 24 * 60 * 60, existingPrincipalId?: string): {
    principal: Principal;
    session: Session;
    token: string;
  } {
    return createAnonymousSession(this.state, ttlSeconds, existingPrincipalId);
  }

  revokeSession(sessionId: string): ServiceResult<true> {
    return revokeSession(this.state, sessionId);
  }

  /** HTTP 入口先核验会话，写操作再核验资源归属；撤销/过期令牌不能继续使用。 */
  validateSession(actorId: string, sessionId: string, token?: string): boolean {
    return this.activePrincipal(actorId, sessionId, token).ok;
  }

  sessionExpiry(actorId: string, sessionId: string) { return sessionExpiry(this.state, actorId, sessionId); }

  private activePrincipal(actorId: string, sessionId?: string, token?: string): ServiceResult<Principal> {
    return activePrincipal(this.state, actorId, sessionId, token);
  }

  // ---------- trips ----------

  createTrip(actorId: string, input: CreateTripInput): ServiceResult<TripView> {
    return trips.createTrip(this.state, actorId, input);
  }

  getTrip(actorId: string, tripId: string): ServiceResult<TripView> {
    return trips.getTrip(this.state, actorId, tripId);
  }

  getVersion(actorId: string, tripId: string, revision: number) {
    return trips.getVersion(this.state, actorId, tripId, revision);
  }

  listTrips(actorId: string): ServiceResult<TripView[]> {
    return trips.listTrips(this.state, actorId);
  }

  /** Purge expired dated plans and their execution progress, including trips not currently opened. */
  purgePastProgress(): number {
    return trips.purgePastProgressForAll(this.state) + pruneInactiveSessions(this.state);
  }

  listVersions(
    actorId: string,
    tripId: string,
  ): ServiceResult<
    Array<{
      revision: number;
      reason: string;
      createdAt: string;
      mutationId: string | null;
      action: string | null;
    }>
  > {
    return trips.listVersions(this.state, actorId, tripId);
  }

  listShortlist(actorId: string, tripId: string): ServiceResult<string[]> {
    return trips.listShortlist(this.state, actorId, tripId);
  }

  addShortlist(actorId: string, tripId: string, placeId: string): ServiceResult<string[]> {
    return trips.addShortlist(this.state, actorId, tripId, placeId);
  }

  removeShortlist(actorId: string, tripId: string, placeId: string): ServiceResult<string[]> {
    return trips.removeShortlist(this.state, actorId, tripId, placeId);
  }

  /** 自愿反馈不改变规划 revision，也不参与 Agent 授权。 */
  recordFeedback(
    actorId: string,
    tripId: string,
    input: Parameters<typeof trips.recordFeedback>[3],
  ): ServiceResult<FeedbackRecord> {
    return trips.recordFeedback(this.state, actorId, tripId, input);
  }

  patchTrip(actorId: string, tripId: string, input: PatchTripInput): ServiceResult<TripView> {
    return trips.patchTrip(this.state, actorId, tripId, input);
  }

  /** 位置/现场更新 latestContextId，不改变 revision。 */
  captureContext(
    actorId: string,
    tripId: string,
    input: Parameters<typeof trips.captureContext>[3],
  ): ServiceResult<ContextSnapshot> {
    return trips.captureContext(this.state, actorId, tripId, input);
  }

  // ---------- proposals & authorization ----------

  createProposal(
    actorId: string,
    tripId: string,
    input: CreateProposalInput,
  ): ServiceResult<ProposalView> {
    return proposalOps.createProposal(this.state, actorId, tripId, input);
  }

  getProposal(actorId: string, tripId: string, proposalId: string): ServiceResult<ProposalView> {
    return proposalOps.getProposal(this.state, actorId, tripId, proposalId);
  }

  rejectProposal(actorId: string, tripId: string, proposalId: string): ServiceResult<Proposal> {
    return proposalOps.rejectProposal(this.state, actorId, tripId, proposalId);
  }

  // 提案生成与查询在 trip/proposals.ts；许可、应用与撤销在 trip/apply.ts。
  decideAction(
    input: Parameters<typeof applyOps.decideAction>[1],
  ): ServiceResult<ReturnType<ActionAuthorizationService['getRequest']>> {
    return applyOps.decideAction(this.state, input);
  }

  confirmFromText(
    input: Parameters<typeof applyOps.confirmFromText>[1],
  ): ServiceResult<ReturnType<ActionAuthorizationService['getRequest']>> {
    return applyOps.confirmFromText(this.state, input);
  }

  applyProposal(command: ApplyProposalCommand): ServiceResult<AppliedProposalValue> {
    return applyOps.applyProposal(this.state, command);
  }

  undo(command: UndoCommand): ServiceResult<AppliedProposalValue> {
    return applyOps.undo(this.state, command);
  }

  // ---------- execution & facts ----------

  recordExecution(command: ExecutionCommand): ServiceResult<TripView> {
    return executionOps.recordExecution(this.state, command);
  }

  recordExecutionCorrection(command: {
    actorId: string;
    tripId: string;
    eventIdToCorrect: string;
    statusOverride?: StopStatus;
    correctionReason?: string;
    type: ExecutionEventType;
    occurredAt?: string;
    expectedRevision?: number;
    now?: string;
  }): ServiceResult<TripView> {
    return executionOps.recordExecutionCorrection(this.state, command);
  }

  startTrip(actorId: string, tripId: string, expectedRevision: number): ServiceResult<TripView> {
    return executionOps.startTrip(this.state, actorId, tripId, expectedRevision);
  }

  finishTrip(actorId: string, tripId: string, expectedRevision: number): ServiceResult<TripView> {
    return executionOps.finishTrip(this.state, actorId, tripId, expectedRevision);
  }

  archiveTrip(actorId: string, tripId: string, expectedRevision: number): ServiceResult<TripView> {
    return executionOps.archiveTrip(this.state, actorId, tripId, expectedRevision);
  }

  recordSpend(command: SpendCommand): ServiceResult<TripView> {
    return executionOps.recordSpend(this.state, command);
  }

  recordWalking(command: {
    actorId: string;
    tripId: string;
    walkingMeters: number;
    completenessConfirmed: boolean;
    occurredAt: string;
    expectedRevision?: number;
    now?: string;
  }): ServiceResult<TripView> {
    return executionOps.recordWalking(this.state, command);
  }

  // ---------- memories ----------

  createMemory(
    actorId: string,
    tripId: string,
    input: Parameters<typeof memoryOps.createMemory>[3],
  ): ServiceResult<MemoryCommandResult> {
    return memoryOps.createMemory(this.state, actorId, tripId, input);
  }

  patchMemory(
    actorId: string,
    tripId: string,
    memoryId: string,
    input: Parameters<typeof memoryOps.patchMemory>[4],
  ): ServiceResult<MemoryCommandResult> {
    return memoryOps.patchMemory(this.state, actorId, tripId, memoryId, input);
  }

  generateRecap(
    actorId: string,
    tripId: string,
    input: Parameters<typeof memoryOps.generateRecap>[3],
  ): ServiceResult<MemoryCommandResult> {
    return memoryOps.generateRecap(this.state, actorId, tripId, input);
  }

  generateJourneyMemory(
    actorId: string,
    tripId: string,
    localDate: string,
  ): ServiceResult<MemoryCommandResult> {
    return memoryOps.generateJourneyMemory(this.state, actorId, tripId, localDate);
  }

  deleteMemory(actorId: string, tripId: string, memoryId: string): ServiceResult<MemoryCommandResult> {
    return memoryOps.deleteMemory(this.state, actorId, tripId, memoryId);
  }

  invalidateMessageSource(actorId: string, tripId: string, messageId: string): ServiceResult<true> { return memoryOps.invalidateMessageSource(this.state, actorId, tripId, messageId); }

  listMemories(actorId: string, tripId: string): ServiceResult<MemoryResult['entry'][]> {
    return memoryOps.listMemories(this.state, actorId, tripId);
  }

  // ---------- trip controls ----------

  deleteTrip(actorId: string, tripId: string): ServiceResult<true> {
    return controls.deleteTrip(this.state, actorId, tripId);
  }

  cloneTrip(actorId: string, tripId: string): ServiceResult<TripView> {
    return controls.cloneTrip(this.state, actorId, tripId);
  }

  /** 本地备份演练：导出内存状态为 JSON；生产环境使用 PostgreSQL 备份与删除清单。 */
  serialize(): string {
    return persistence.serialize(this.state);
  }

  /** 从同一代码版本的 JSON 备份恢复；恢复后仍要重放删除清单并重新校验。 */
  loadSerialized(serialized: string): void {
    persistence.loadSerialized(this.state, serialized);
  }
}
