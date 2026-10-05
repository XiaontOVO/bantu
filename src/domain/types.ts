/**
 * 核心领域类型。
 *
 * 命名与语义以 docs/03-数据模型与接口契约.md 为权威来源。
 * 为兼容早期纯领域原型，时间字段同时保留 plannedXxx 与 XxxMinutes 两套别名；
 * 新增代码应优先使用 docs/03 中的字段，并通过 normalize 工具读取。
 */

export type TravelMode = 'online' | 'demo';
export type DataMode = TravelMode;
export type TravelLifecycle = 'draft' | 'active' | 'completed' | 'archived';
export type PlanningStatus = 'empty' | 'needs_review' | 'validated';
export type StopStatus = 'planned' | 'en_route' | 'visiting' | 'completed' | 'skipped';
export type TransportMode = 'walking' | 'transit' | 'driving';

export type ConstraintKind =
  | 'visit_window'
  | 'retain_stop'
  | 'lock_time'
  | 'walking_limit'
  | 'budget_limit'
  | 'facility_required'
  | 'preference';

export type ConstraintStrength = 'hard' | 'soft';
export type ConstraintSource = 'user_form' | 'user_confirmed_chat' | 'template';
export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface TimeRange {
  startMinutes: number;
  endMinutes: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  source: string;
}

export interface PlaceRef {
  placeId: string;
  name: string;
  coordinates: GeoPoint | null;
  facilityCodes: string[];
  /** 同名地点、入口坐标、目录版本等可追溯信息。 */
  provider?: string;
  providerPlaceId?: string;
  cityCode?: string;
  /** Administrative district used to keep map catalogs inside the selected area. */
  districtAdcode?: string;
  dataMode?: DataMode;
  evidenceIds?: string[];
}

export interface PlanStop {
  stopId: string;
  /** 该站点所属日期（YYYY-MM-DD）；缺省为旅行起始日。多日行程按此字段分天。 */
  date?: string;
  /** 推荐路径；兼容旧测试可直接提供 placeId。 */
  place?: PlaceRef;
  placeId?: string;
  /** 计划到达（分钟，00:00 起） */
  plannedArrivalMinutes?: number;
  /** 前往本站的出发时间；departureMinutes 表示离开本站。 */
  travelStartMinutes?: number;
  /** 计划从起点前往本站的出发时间，与离开本站的 departureMinutes 分开。 */
  plannedTravelStartMinutes?: number;
  /** 执行前的相对顺序；中止后恢复待执行队列使用。 */
  originalPlanOrder?: number;
  /** 已向后传播的出发延误，中止后保留计数，避免重新出发或到达时重复顺延。 */
  propagatedDepartureDelayMinutes?: number;
  /** 计划开始活动（分钟） */
  startMinutes?: number;
  plannedStartMinutes?: number;
  /** 计划结束（分钟） */
  endMinutes?: number;
  /** 计划离开（分钟，含缓冲） */
  departureMinutes?: number;
  plannedDepartureMinutes?: number;
  /** 秒口径（docs/03）；与分钟字段二选一。 */
  durationSeconds?: number;
  minDurationSeconds?: number;
  /** 分钟口径。 */
  minDurationMinutes?: number;
  plannedDurationMinutes?: number;
  priority?: number;
  visitWindow?: TimeRange;
  retain?: boolean;
  retainStop?: boolean;
  lockTime?: boolean;
  timeLocked?: boolean;
  openingIntervals?: TimeRange[];
  status?: StopStatus;
  evidenceRefs?: string[];
  /** 应用前/后快照中保留的来源版本。 */
  baseRevision?: number;
  /** 出发时按实际路线估算的交通耗时，参与预计到达与预测排期。 */
  estimatedTravelMinutes?: number;
  estimatedTransportMode?: TransportMode;
  /** User's planned transport choice; persists independently of live route estimates and aborts. */
  preferredTransportMode?: TransportMode;
  /** 仅为展示推导的预测与实际时间，不作为已发生的执行事实持久化。 */
  forecastStartMinutes?: number;
  forecastEndMinutes?: number;
  actualArrivalMinutes?: number;
  actualCompletionMinutes?: number;
  transferTimeUnknown?: boolean;
  executionOverdue?: boolean;
  forecastConflict?: boolean;
}

export interface RouteLeg {
  geometry?: { lat: number; lng: number }[];
  geometryCrs?: 'GCJ02' | 'WGS84';
  instructions?: string[];
  legId: string;
  fromStopId: string;
  toStopId: string;
  transportMode: TransportMode;
  /** 兼容分钟口径；新增数据优先 durationSeconds。 */
  durationMinutes?: number;
  durationSeconds?: number;
  walkingMinutes?: number;
  walkingMeters?: number;
  distanceMeters?: number;
  /** 等待/换乘缓冲分钟 */
  bufferMinutes?: number;
  /** docs/03 route_legs 字段 */
  departureSupport?: 'scheduled' | 'live' | 'current_only' | 'demo';
  departureAt?: string;
  evidenceId?: string;
  expiresAt?: string | null;
  costEstimate?: CostEstimate;
  walkingCertainty?: 'known' | 'bounded' | 'unknown';
}

export interface BudgetSetting {
  currency: string;
  limitMinor: number | null;
  strength: ConstraintStrength;
  scope: 'trip' | 'day';
}

export interface DepartureBasis {
  plannedDepartureAt: string;
  timeBasis: 'scheduled' | 'live' | 'demo';
}

export interface PlanSettings {
  cityCode?: string;
  localDate?: string;
  timezone?: string;
  partySize?: number;
  startPlaceRef?: string | PlaceRef | null;
  dayStartAt?: string | number;
  /** 旧版兼容字段，不再限制计划时间。 */
  dayEndAt?: string | number;
  [key: string]: unknown;
}

export interface TripSnapshot {
  schemaVersion?: number;
  tripId: string;
  dataMode?: TravelMode;
  lifecycle?: TravelLifecycle;
  planningStatus?: PlanningStatus;
  timezone?: string;
  travelDate?: string;
  localDate?: string;
  dayStartMinutes?: number;
  /** 旧版兼容字段，不再限制计划时间。 */
  dayEndMinutes?: number;
  tripSettings?: PlanSettings;
  partyNeeds?: Record<string, Record<string, unknown>>;
  budget?: BudgetSetting | null;
  spendRef?: string | null;
  walkingRef?: string | null;
  constraints?: Constraint[];
  stops?: PlanStop[];
  routeLegs?: RouteLeg[];
  plannedCharges?: PlannedCharge[];
  departureBasis?: DepartureBasis;
  validationSummary?: ValidationSummary;
  /** 已累计的真实全团花费，单位分。null/undefined 表示未知。 */
  actualSpendMinor?: number | null;
  actualSpendComplete?: boolean;
  /** 已知的累计实际步行米数。 */
  actualWalkingMeters?: number | null;
  actualWalkingComplete?: boolean;
  executionEvents?: ExecutionEvent[];
  spendEvents?: SpendEvent[];
  walkingEvents?: WalkingEvent[];
  version?: number;
  contextSnapshotId?: string | null;
}

interface ConstraintBase {
  constraintId: string;
  strength?: ConstraintStrength;
  source?: ConstraintSource;
  memberIds?: string[];
  confirmedAt?: string | null;
  /** docs/03 subjectId 的可选别名。 */
  subjectId?: string | null;
}

export interface VisitWindowConstraint extends ConstraintBase {
  kind: 'visit_window';
  payload: {
    stopId?: string;
    /** docs/03 字段 */
    earliestStartAt?: string | number;
    latestArrivalAt?: string | number;
    durationSeconds?: number;
    /** 早期分钟字段 */
    earliestStartMinutes?: number;
    latestStartMinutes?: number;
    latestArrivalMinutes?: number;
    earliestEndMinutes?: number;
    latestEndMinutes?: number;
  };
}

export interface RetainStopConstraint extends ConstraintBase {
  kind: 'retain_stop';
  payload: { stopId: string };
}

export interface LockTimeConstraint extends ConstraintBase {
  kind: 'lock_time';
  payload: {
    stopId: string;
    startMinutes?: number;
    endMinutes?: number;
    visitWindow?: TimeRange;
    originalStartMinutes?: number;
    originalEndMinutes?: number;
  };
}

export interface WalkingLimitConstraint extends ConstraintBase {
  kind: 'walking_limit';
  payload: {
    scope: 'leg' | 'day';
    memberId?: string;
    /** 早期分钟字段 */
    maxWalkingMinutes?: number;
    /** docs/03 米字段 */
    maxWalkingMeters?: number;
    /** 兼容单位别名 */
    meters?: number;
    maxMeters?: number;
  };
}

export interface BudgetLimitConstraint extends ConstraintBase {
  kind: 'budget_limit';
  payload: {
    scope: 'trip' | 'day';
    currency: string;
    limitMinor: number;
    includedChargeIds?: string[];
  };
}

export interface FacilityRequiredConstraint extends ConstraintBase {
  kind: 'facility_required';
  payload: {
    stopId?: string;
    scopeStopIds?: string[];
    facilityCode: string;
  };
}

export interface PreferenceConstraint extends ConstraintBase {
  kind: 'preference';
  payload: {
    key: string;
    value: string | number | boolean;
    priorityRank?: number;
  };
}

export type Constraint =
  | VisitWindowConstraint
  | RetainStopConstraint
  | LockTimeConstraint
  | WalkingLimitConstraint
  | BudgetLimitConstraint
  | FacilityRequiredConstraint
  | PreferenceConstraint;

export interface PlanCheck {
  explanation?: string;
  constraintId: string;
  status: CheckStatus;
  reasonCode?: string;
  affectedStopIds?: string[];
}

export interface ValidationSummary {
  planningStatus: PlanningStatus;
  checks: PlanCheck[];
  checkedAt: string;
  contextSnapshotId: string | null | undefined;
}

export interface PlanChange {
  type: 'insert' | 'remove' | 'replace' | 'move' | 'update';
  stopId: string;
  summary: string;
  before?: PlanStop;
  after?: PlanStop;
}

export type CandidateApplicability = 'applicable' | 'needs_verification';

export interface ProposalCandidate {
  candidateId: string;
  kind?: 'initial' | 'replan';
  title: string;
  summary: string;
  changes?: PlanChange[];
  checks?: PlanCheck[];
  snapshot: TripSnapshot;
  applicability?: CandidateApplicability;
  plannedDepartureAt?: string | null;
  contextSnapshotId?: string | null;
  evidenceRefs?: string[];
  metrics?: {
    totalCostMinor?: number | null;
    totalWalkingMeters?: number | null;
    totalDurationMinutes?: number | null;
    arrivalAtTargetMinutes?: number | null;
    [key: string]: unknown;
  };
}

export type ProposalStatus = 'ready' | 'applied' | 'expired' | 'rejected';

export interface Proposal {
  proposalId: string;
  tripId: string;
  /** docs/03 为必填；早期测试可省略，由候选推导。 */
  kind?: 'initial' | 'replan';
  status: ProposalStatus;
  baseRevision: number;
  contextSnapshotId?: string | null;
  createdAt: string;
  expiresAt: string;
  candidates: ProposalCandidate[];
  algorithmVersion?: string;
  promptVersion?: string;
  evidenceRefs?: string[];
}

export type ActionRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'cancelled'
  | 'executed';

export interface ActionRequest {
  actionRequestId: string;
  tripId: string;
  /** 早期通用 action 字段；具体写工具使用 toolName。 */
  action?: string;
  toolName?: string;
  canonicalArgs?: unknown;
  argsDigest?: string;
  status: ActionRequestStatus;
  actorId: string;
  sessionId: string;
  actionKey: string;
  summary: string;
  approvalGroupId?: string;
  baseRevision?: number;
  contextSnapshotId?: string | null;
  proposalId?: string;
  candidateId?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string | null;
}

export interface Grant {
  grantId: string;
  actionRequestId: string;
  status: 'active' | 'consumed' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  actorId?: string;
  sessionId?: string;
  confirmationSource?: 'button' | 'chat' | 'direct_command' | string;
}

export interface CommandEnvelope {
  actorId: string;
  sessionId: string;
  tripId: string;
  expectedRevision: number | null;
  idempotencyKey: string;
  actionRequestId?: string;
  grantId?: string;
  source?: 'ui' | 'agent';
}

/** docs/03 §4.3 CostEstimate。 */
export type CostBasis = 'party' | 'per_person' | 'per_vehicle';
export type Certainty = 'known' | 'bounded' | 'unknown';

export interface CostEstimate {
  currency: string;
  basis: CostBasis;
  lowerMinor: number;
  upperMinor: number | null;
  certainty: Certainty;
  sourceRef?: string | null;
  participantCount?: number | null;
}

export interface PlannedCharge {
  chargeId: string;
  stopId?: string;
  routeLegRef?: string;
  quantity: number;
  costEstimate: CostEstimate;
  paymentStatus: 'unpaid' | 'paid' | 'unknown';
  includedSpendEventId?: string | null;
}

export interface SpendEvent {
  spendEventId: string;
  tripId: string;
  amountMinor: number;
  currency: string;
  basis: 'party' | 'per_person';
  occurredAt: string;
  recordedAt: string;
  completenessConfirmed: boolean;
  includedChargeIds: string[];
  correctsEventId?: string | null;
}

export interface WalkingEvent {
  walkingEventId: string;
  tripId: string;
  walkingMeters: number;
  occurredAt: string;
  recordedAt: string;
  completenessConfirmed: boolean;
  correctsEventId?: string | null;
}

export type ExecutionEventType = 'depart' | 'arrive' | 'complete' | 'skip' | 'abort';

export interface ExecutionEvent {
  statusOverride?: StopStatus;
  correctionReason?: string;
  executionEventId: string;
  /** Either a trip execution record or an account-owned dated plan. */
  tripId?: string;
  planId?: string;
  stopId: string;
  type: ExecutionEventType;
  occurredAt: string;
  recordedAt: string;
  correctsEventId?: string | null;
  /** 用户报告时为 true；模型/导航不能代替。 */
  userReported?: boolean;
}

export interface ContextSnapshot {
  contextSnapshotId: string;
  tripId: string;
  dataMode: TravelMode;
  capturedAt: string;
  clockRef: string;
  locationRef?: string | null;
  event?: Record<string, unknown>;
  executionRevision?: number | null;
  expiresAt?: string | null;
}

export type OperationStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'cancelled';

export interface Operation {
  operationId: string;
  tripId: string;
  actorId: string;
  sessionId: string;
  kind: string;
  status: OperationStatus;
  phase?: string;
  baseRevision?: number | null;
  expectedRevision?: number | null;
  contextId?: string | null;
  checkpointRef?: string | null;
  leaseToken?: string | null;
  leaseUntil?: string | null;
  availableAt?: string;
  wallDeadlineAt?: string | null;
  inputExpiresAt?: string | null;
  approvalExpiresAt?: string | null;
  cancelRequestedAt?: string | null;
  resultRef?: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable?: boolean } | null;
  retryOf?: string | null;
  usageTotals?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export type ToolExecutionStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface ToolExecution {
  toolExecutionId: string;
  operationId: string;
  stepIndex: number;
  callId: string;
  invocationKey: string;
  toolName: string;
  argsDigest: string;
  actionRequestId?: string | null;
  grantId?: string | null;
  actionKey?: string | null;
  status: ToolExecutionStatus;
  resultRef?: string | null;
  error?: { code: string; message: string } | null;
  mutationId?: string | null;
  committedAt?: string | null;
}

export interface MemoryEntry {
  memoryId: string;
  tripId: string;
  type: 'note' | 'recap';
  entryVersion: number;
  userText: string;
  sourceEventIds: string[];
  sourceMessageIds: string[];
  sourceMemoryIds: string[];
  sourceContentRevision: number;
  provenanceRefs: string[];
  status: 'draft' | 'saved';
  originOperationId: string | null;
  /** 随手记对应的行程当地日期；多日旅行中用于正确标注当天。 */
  localDate?: string;
  /** 已完成行程的冻结快照；过期进度清理后仍可完整展示。 */
  journey?: JourneyMemorySnapshot;
  staleAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JourneyMemoryPlace {
  stopId: string;
  placeId?: string | null;
  name: string;
  arrivedAt?: string | null;
  completedAt?: string | null;
  visitMinutes?: number | null;
  transferMode?: TransportMode | null;
  /** 路线计划中的预计接驳时间，不作为实际旅行总耗时。 */
  transferMinutes?: number | null;
}

export interface JourneyMemorySnapshot {
  localDate: string;
  timezone: string;
  cityCode: string;
  generatedBy: 'manual' | 'expiry';
  firstEventAt: string | null;
  completedAt: string | null;
  /** 从当天首条未被纠正的有效进度到最后一站完成的记录跨度；缺少起止时为 null。 */
  elapsedMinutes: number | null;
  places: JourneyMemoryPlace[];
}

export interface MutationRecord {
  mutationId: string;
  tripId: string;
  actorId: string;
  action: string;
  beforeRevision: number;
  afterRevision: number;
  reversesId?: string | null;
  createdAt: string;
}

export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'SESSION_EXPIRED'
  | 'RESOURCE_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PROPOSAL_EXPIRED'
  | 'UNDO_CONFLICT'
  | 'SOURCE_CHANGED'
  | 'OPERATION_TERMINAL'
  | 'ACTION_AUTHORIZATION_REQUIRED'
  | 'ACTION_AUTHORIZATION_INVALID'
  | 'ACTION_ALREADY_EXECUTED'
  | 'INVALID_TRIP_STATE'
  | 'HARD_CONSTRAINT_VIOLATION'
  | 'EVIDENCE_INSUFFICIENT'
  | 'WRITE_BATCH_NOT_SUPPORTED'
  | 'BUDGET_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'OPERATION_TIMEOUT';
