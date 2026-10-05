/**
 * HTTP 层的共享契约。
 *
 * 路由模块只依赖 `ServerContext`，不直接 import 具体服务实现细节之外的装配逻辑，
 * 因此新增一个功能模块＝新增一个 routes/*.ts 并注册到 router。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteLeg } from '../../domain/types.js';
import type { InMemoryTripService } from '../../services/trip-service.js';
import type { AgentService } from '../../services/agent-service.js';
import type { MessageService } from '../../services/message-service.js';
import type { InMemoryRateLimiter } from '../../services/rate-limiter.js';
import type { ModelProvider } from '../../providers/model.js';
import type { PlaceProvider, RouteProvider, WeatherProvider } from '../../providers/travel.js';
import type { StateStore } from '../../persistence/state-store.js';
import type { InMemoryEvidenceRegistry } from '../../domain/evidence.js';
import type { SessionBinding } from './request.js';
import type { SessionRegistry } from './session-registry.js';
import type { StandaloneAgentService } from '../../services/standalone-agent-service.js';

export interface HttpServerOptions {
  communityAdminToken?: string;
  modelSettings?: import('../../services/model-settings.js').ModelSettings;
  userModelSettings?: import('../../services/user-model-settings.js').UserModelSettings;
  now?: () => string;
  /** 启用离线地点目录与社区样例数据。 */
  seedDemo?: boolean;
  /** 显式注入在线/测试供应商；未提供时使用 demo/scripted 适配器。 */
  modelProvider?: ModelProvider;
  placeProvider?: PlaceProvider;
  /** Product catalogue excludes places without usable local impression artwork; standalone provider tests can opt out. */
  requirePlaceImpressions?: boolean;
  routeProvider?: RouteProvider;
  weatherProvider?: WeatherProvider;
  /** 逆地理编码服务（定位坐标→地名）；未提供时顶栏不显示定位地点。 */
  geoService?: import('../../providers/geo.js').GeoService;
  /** 本地持久化适配器；未提供时完全在内存运行。 */
  stateStore?: StateStore;
  stateKey?: string;
  /** 可注入关键证据注册表；未提供时应用不额外检查证据引用。 */
  evidenceRegistry?: InMemoryEvidenceRegistry;
  /** 可注入限流器，便于测试固定窗口与拒绝路径。 */
  rateLimiter?: InMemoryRateLimiter;
  agentRequestLimits?: { perMinute: number; perDay: number };
  /** 局域网邀请码门禁；未提供时按 HOST 环境变量自动决定是否启用。 */
  accessGate?: import('./access-gate.js').AccessGate;
}

/** 路线估算结果：成功是 RoutePlanResult，失败是 `{ error }`。 */
export interface RouteEstimate {
  leg?: RouteLeg;
  departureSupport?: string;
  error?: { code: string; message: string };
}

export interface RateLimitOutcome {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** 每个请求共享的运行时依赖。路由模块只通过它访问状态与副作用。 */
export interface ServerContext {
  personalAgentTasks: import('../../services/personal-agent-tasks.js').PersonalAgentTasks;
  accounts: import('../../services/account-service.js').AccountService;
  favoritesService: import('../../services/favorites-service.js').FavoritesService;
  personalMemoriesService: import('../../services/personal-memories-service.js').PersonalMemoriesService;
  communityService: import('../../services/community-service.js').CommunityService;
  placeRegistry: import('../../services/place-registry.js').PlaceNumberRegistry;
  planLibrary: import('../../services/plan-library.js').PlanLibraryService;
  now: () => string;
  options: HttpServerOptions;
  modelProviderForActor(actorId?: string): ModelProvider | undefined;
  service: InMemoryTripService;
  agentService: AgentService;
  messageService: MessageService;
  /** 无旅行实例也可直接操作日计划、方案、收藏与进度的自然语言入口。 */
  standaloneAgentService: StandaloneAgentService;
  /** Cookie token → 会话绑定；内部只用 SHA-256 摘要作索引。 */
  sessions: SessionRegistry;
  rateLimiter: InMemoryRateLimiter;
  stateStore?: StateStore;
  stateKey: string;
  fallbackPlaceProvider: PlaceProvider;
  fallbackRouteProvider: RouteProvider;
  /** 解析请求里的 token，不做有效性判断。 */
  currentAuth(request: IncomingMessage): SessionBinding | null;
  /** 鉴权；失败时已写出 401 并返回 null。 */
  requireAuth(request: IncomingMessage, response: ServerResponse): SessionBinding | null;
  /** 需要旅行归属的读取/写入统一走这里，避免各处漏判。 */
  requireOwnedTrip(
    binding: SessionBinding,
    tripId: string,
    response: ServerResponse,
  ): boolean;
  estimateRoute(body: Record<string, unknown>, dataMode: 'online' | 'demo'): Promise<RouteEstimate>;
  consumeTaskLimit(actorId: string, nowMs?: number): RateLimitOutcome;
  /** Stable snapshot of persisted services, used to skip no-op SQLite commits. */
  stateFingerprint(): string;
  persistState(): void;
}
