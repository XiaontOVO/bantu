import { createHash } from 'node:crypto';
import { AccountService } from '../../services/account-service.js';
import { UserModelSettings } from '../../services/user-model-settings.js';
/**
 * 运行时装配：把状态、服务、供应商和限流器组装成一个 ServerContext。
 *
 * 这里是唯一知道「具体用哪个实现」的地方；路由模块只看到接口。
 * 换成 PostgreSQL 状态存储或真实模型时，只改这个文件和 providers/factory。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryTripService } from '../../services/trip-service.js';
import { AgentService } from '../../services/agent-service.js';
import { MessageService } from '../../services/message-service.js';
import { CommunityService, communityPlaceProvider } from '../../services/community-service.js';
import { illustratedPlaceProvider } from '../../providers/illustrated-places.js';
import { PlaceNumberRegistry } from '../../services/place-registry.js';
import { PlanLibraryService } from '../../services/plan-library.js';
import { FavoritesService } from '../../services/favorites-service.js';
import { PersonalMemoriesService } from '../../services/personal-memories-service.js';
import { PersonalAgentTasks } from '../../services/personal-agent-tasks.js';
import { StandaloneAgentService } from '../../services/standalone-agent-service.js';
import { InMemoryRateLimiter } from '../../services/rate-limiter.js';
import { DemoPlaceProvider, DemoRouteProvider } from '../../providers/travel.js';
import type { RoutePlanInput } from '../../providers/travel.js';
import { clearSessionCookie, parseCookies, readTransportMode, type SessionBinding } from './request.js';
import { SessionRegistry } from './session-registry.js';
import { sendError, sendServiceError } from './respond.js';
import type {
  HttpServerOptions,
  RateLimitOutcome,
  RouteEstimate,
  ServerContext,
} from './context.js';

export function createServerContext(options: HttpServerOptions = {}): ServerContext {
  const now = options.now ?? (() => new Date().toISOString());
  const accounts = new AccountService();
  const placeRegistry = new PlaceNumberRegistry();
  const communityService = new CommunityService(now, placeRegistry);
  const favoritesService = new FavoritesService(now);
  favoritesService.setPostVisibilityResolver((id, actorId) => communityService.canReadPostSnapshot(id, actorId));
  const personalMemoriesService = new PersonalMemoriesService(now);
  const personalAgentTasks = new PersonalAgentTasks();
  const planLibrary = new PlanLibraryService(now, (actorId, plan, generatedBy, details) => {
    personalMemoriesService.createJourney(actorId, {
      plan,
      ...details,
      generatedBy,
    });
  }, (actorId, planId) => personalMemoriesService.markJourneyChanged(actorId, planId));
  const fallbackRouteProvider = new DemoRouteProvider();
  const fallbackPlaceProvider = new DemoPlaceProvider();
  options = { ...options, placeProvider: communityPlaceProvider(options.placeProvider ?? fallbackPlaceProvider, communityService, placeRegistry, fallbackPlaceProvider) };
  if (options.requirePlaceImpressions) options.placeProvider = illustratedPlaceProvider(options.placeProvider!);
  options.userModelSettings ??= new UserModelSettings();
  const modelProviderForActor = (actorId?: string) => options.userModelSettings!.providerFor(actorId, options.modelProvider);
  const service = new InMemoryTripService(now, {
    evidenceRegistry: options.evidenceRegistry,
    archiveExpiredPlanDay: input => { planLibrary.archiveExpiredTripDay(input); },
  });
  const agentService = new AgentService(service, {
    now,
    modelProvider: options.modelProvider,
    modelProviderForActor,
    placeProvider: options.placeProvider,
    routeProvider: options.routeProvider,
    weatherProvider: options.weatherProvider,
  });
  const messageService = new MessageService(service, now);
  const standaloneAgentService = new StandaloneAgentService(
    planLibrary,
    favoritesService,
    personalMemoriesService,
    options.placeProvider!,
    options.routeProvider ?? fallbackRouteProvider,
    now,
    communityService,
    actorId => accounts.nicknameOf(actorId),
    actorId => accounts.profile(actorId).kind === 'account',
  );
  const sessions = new SessionRegistry();
  const stateStore = options.stateStore;
  const stateKey = options.stateKey ?? 'bantu-trip-service';
  const rateLimiter = options.rateLimiter ?? new InMemoryRateLimiter();
  let legacySessionsNeedMigration = false;
  const hydratedRevision = stateStore?.getRevision?.();
  let stateRevision = hydratedRevision;

  hydrateFromStateStore();
  const currentStoreRevision = stateStore?.getRevision?.();
  if (hydratedRevision !== undefined && currentStoreRevision !== undefined && currentStoreRevision !== hydratedRevision) {
    throw new Error(`本地数据在恢复期间已被其他服务实例更新（${hydratedRevision} → ${currentStoreRevision}），请重新启动以加载完整快照。`);
  }

  function hydrateFromStateStore(): void {
    if (!stateStore) return;
    const savedService = stateStore.get(stateKey);
    if (savedService) service.loadSerialized(savedService);

    const savedSessions = stateStore.get(`${stateKey}:sessions`);
    if (savedSessions) {
      const format = sessions.restore(savedSessions);
      if (format === 'legacy') {
        legacySessionsNeedMigration = true;
        // 内存已迁移为摘要格式；延迟到带 revision 比较的完整快照提交时落盘。
        console.info('[bantu] 本地会话存储将在下次安全快照提交时迁移为 SHA-256 摘要格式。');
      } else if (format === 'invalid') {
        throw new Error('本地会话缓存格式无效，服务未启动；原始数据已保留，请先检查数据文件。');
      }
    }

    const restorers: Array<[string, (value: string) => void, string]> = [
      [`${stateKey}:accounts`, value => accounts.loadSerialized(value), '账号'],
      [`${stateKey}:agent`, (value) => agentService.loadSerialized(value), 'Agent 检查点'],
      [`${stateKey}:messages`, (value) => messageService.loadSerialized(value), '对话缓存'],
      [`${stateKey}:agent-conversations`, value => messageService.loadConversationMetadata(value), '对话名称'],
      [`${stateKey}:community`, (value) => communityService.loadSerialized(value), '社区内容'],
      [`${stateKey}:place-registry`, (value) => placeRegistry.loadSerialized(value), '地点编号'],
      [`${stateKey}:plan-library`, (value) => planLibrary.loadSerialized(value), '我的方案'],
      [`${stateKey}:favorites`, (value) => favoritesService.loadSerialized(value), '收藏地点'],
      [`${stateKey}:personal-memories`, (value) => personalMemoriesService.loadSerialized(value), '个人记忆'],
      [`${stateKey}:personal-agent-tasks`, value => personalAgentTasks.loadSerialized(value), '个人 Agent 任务'],
    ];
    if (options.evidenceRegistry) {
      restorers.push([
        `${stateKey}:evidence`,
        (value) => options.evidenceRegistry!.loadSerialized(value),
        '证据缓存',
      ]);
    }
    for (const [key, restore, label] of restorers) {
      const saved = stateStore.get(key);
      if (!saved) continue;
      try {
        restore(saved);
      } catch (error) {
        // 空状态会在首个 API 响应时写回并覆盖原数据；恢复失败时停止启动以保护原始快照。
        throw new Error(`本地${label}数据无法恢复，服务未启动；原始数据已保留（${key}）。`, { cause: error });
      }
    }
  }

  const serializeState = (): Array<[string, string]> => {
    const entries: Array<[string, string]> = [
      [stateKey, service.serialize()],
      [`${stateKey}:accounts`, accounts.serialize()],
      [`${stateKey}:sessions`, sessions.serialize()],
      [`${stateKey}:agent`, agentService.serialize()],
      [`${stateKey}:messages`, messageService.serialize()],
      [`${stateKey}:agent-conversations`, messageService.serializeConversationMetadata()],
      [`${stateKey}:community`, communityService.serialize()],
      [`${stateKey}:place-registry`, placeRegistry.serialize()],
      [`${stateKey}:plan-library`, planLibrary.serialize()],
      [`${stateKey}:favorites`, favoritesService.serialize()],
      [`${stateKey}:personal-memories`, personalMemoriesService.serialize()],
      [`${stateKey}:personal-agent-tasks`, personalAgentTasks.serialize()],
    ];
    if (options.evidenceRegistry) {
      entries.push([`${stateKey}:evidence`, options.evidenceRegistry.serialize()]);
    }
    return entries;
  };

  const stateFingerprint = (): string => {
    const hash = createHash('sha256');
    for (const [key, value] of serializeState()) {
      hash.update(key).update('\0').update(value).update('\0');
    }
    return hash.digest('hex');
  };

  const persistState = (): void => {
    if (!stateStore) return;
    const entries = serializeState();
    // 一次事务写完：避免崩溃后出现“会话恢复了但旅行没有”的撕裂恢复点。
    // 持久化错误必须交给 HTTP 入口处理，不能继续把响应标成成功。
    const committedRevision = stateStore.setMany(entries, stateRevision);
    if (committedRevision !== undefined) stateRevision = committedRevision;
  };

  if (legacySessionsNeedMigration) persistState();

  const agentLimits = options.agentRequestLimits || { perMinute: 30, perDay: 300 };
  if (![agentLimits.perMinute, agentLimits.perDay].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Agent 请求限额必须是正整数。');
  const consumeTaskLimit = (actorId: string, nowMs = Date.now()): RateLimitOutcome => {
    const minuteKey = `task:minute:${actorId}`, dayKey = `task:day:${actorId}`;
    const minute = rateLimiter.check(minuteKey, agentLimits.perMinute, 60, nowMs);
    if (!minute.allowed) return { allowed: false, retryAfterSeconds: minute.retryAfterSeconds };
    const day = rateLimiter.check(dayKey, agentLimits.perDay, 24 * 60 * 60, nowMs);
    if (!day.allowed) return { allowed: false, retryAfterSeconds: day.retryAfterSeconds };
    rateLimiter.consume(minuteKey, agentLimits.perMinute, 60, nowMs);
    rateLimiter.consume(dayKey, agentLimits.perDay, 24 * 60 * 60, nowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  };

  const estimateRoute = async (
    body: Record<string, unknown>,
    dataMode: 'online' | 'demo',
  ): Promise<RouteEstimate> => {
    const provider = options.routeProvider ?? fallbackRouteProvider;
    const origin = body.from ?? body.origin;
    const destination = body.to ?? body.destination;
    if (!origin || !destination) {
      return {
        error: { code: 'INVALID_INPUT', message: '需要起点和终点坐标或地点引用。' },
      };
    }
    return provider.plan({
      origin: origin as RoutePlanInput['origin'],
      destination: destination as RoutePlanInput['destination'],
      transportMode: readTransportMode(body.transportMode),
      cityCode: typeof body.cityCode === 'string' && body.cityCode.trim()
        ? body.cityCode.trim()
        : (typeof origin === 'object' && origin !== null && 'cityCode' in origin && typeof origin.cityCode === 'string' ? origin.cityCode : undefined)
          ?? (typeof destination === 'object' && destination !== null && 'cityCode' in destination && typeof destination.cityCode === 'string' ? destination.cityCode : undefined),
      dataMode,
    });
  };

  const currentAuth = (request: IncomingMessage): SessionBinding | null => {
    const token = parseCookies(request).bantu_session;
    if (!token) return null;
    return sessions.get(token) ?? null;
  };

  const requireAuth = (
    request: IncomingMessage,
    response: ServerResponse,
  ): SessionBinding | null => {
    const binding = currentAuth(request);
    if (!binding) {
      sendError(response, 401, 'SESSION_EXPIRED', '请先创建匿名会话。');
      return null;
    }
    // token → binding 的映射只增不减，因此必须回到领域层确认会话未撤销、未过期；
    // 否则过期 token 会永久有效，TTL 形同虚设。
    const token = parseCookies(request).bantu_session;
    if (!service.validateSession(binding.actorId, binding.sessionId, token)) {
      if (token) sessions.delete(token);
      clearSessionCookie(response);
      sendError(response, 401, 'SESSION_EXPIRED', '会话已过期，请重新创建会话。');
      return null;
    }
    return binding;
  };

  const requireOwnedTrip = (
    binding: SessionBinding,
    tripId: string,
    response: ServerResponse,
  ): boolean => {
    const result = service.getTrip(binding.actorId, tripId);
    if (!result.ok) {
      sendServiceError(response, result);
      return false;
    }
    return true;
  };

  return {
    favoritesService,
    personalMemoriesService,
    placeRegistry,
    planLibrary,
    accounts, communityService,
    now,
    options,
    modelProviderForActor,
    service,
    agentService,
    messageService,
    standaloneAgentService,
    personalAgentTasks,
    sessions,
    rateLimiter,
    stateStore,
    stateKey,
    fallbackPlaceProvider,
    fallbackRouteProvider,
    currentAuth,
    requireAuth,
    requireOwnedTrip,
    estimateRoute,
    consumeTaskLimit,
    stateFingerprint,
    persistState,
  };
}
