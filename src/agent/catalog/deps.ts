/**
 * 工具目录的依赖契约。
 *
 * 单独成文件的原因：分区模块（`trip.ts`／`planning.ts`／`places.ts`）都要拿到同一份依赖，
 * 而这个接口是**唯一**允许它们触碰外部世界的地方——工具本身必须是薄适配层，
 * 业务规则一律留在服务层与领域层。
 *
 * 新增依赖时注意：它必须由 `AgentService` 在构造时注入（`agent-service.ts`），
 * 否则运行时静默变成 `undefined`。
 */
import type { ToolGateway } from '../tools.js';
import type { InMemoryTripService } from '../../services/trip-service.js';
import type { PlaceProvider, RouteProvider, WeatherProvider } from '../../providers/travel.js';

/** 工具目录需要的全部依赖；由 AgentService 在构造时注入。 */
export interface ToolCatalogDeps {
  gateway: ToolGateway;
  tripService: InMemoryTripService;
  placeProvider: PlaceProvider;
  routeProvider: RouteProvider;
  weatherProvider?: WeatherProvider;
}
