/**
 * P0 工具目录：把每个工具的 schema、权限策略与处理函数集中登记到网关。
 *
 * 这里是模型能触达的**全部**能力边界。三条规则：
 *
 * 1. **白名单**：只有登记过的工具可被调用；网关还会按任务的 allowedTools 再过滤一层。
 * 2. **写工具必须走许可**：permissionPolicy 为 requires_user_grant 的调用会先创建
 *    actionRequest，用户批准后才执行；服务端校验，不依赖模型自觉。
 * 3. **参数照着 inputSchema 写**：网关会在授权与业务写入之前按它校验，
 *    缺字段或 NaN 会变成 INVALID_INPUT，而不是一路传到领域层变成误导性的冲突错误。
 *
 * 读取类工具可以直接执行（查资料、算路线）；任何会改正式计划的都在写工具那一组。
 *
 * 目录按"改哪一类工具"分成三个模块，本文件只负责**顺序**与转发：
 * `trip.ts` 单趟旅行、`planning.ts` 计划闭环、`places.ts` 外部资料。
 * 新增工具时应落进对应模块，而不是加回这里——这里一旦重新变长，
 * "能力边界只有一处定义"就名存实亡了。
 */
import type { ToolCatalogDeps } from './deps.js';
import { registerTripTools } from './trip.js';
import { registerPlanningTools } from './planning.js';
import { registerPlaceTools } from './places.js';

export type { ToolCatalogDeps } from './deps.js';

/**
 * 登记全部工具。
 *
 * 登记顺序决定模型看到的工具清单顺序，因此这里按"先看有什么 → 再改计划 → 再记状态"排列：
 * 外部资料（只读）→ 计划闭环（提案／应用／撤销）→ 旅行状态（读取与写入）。
 * 顺序本身不影响权限——每一处策略都在各自模块里写明，不靠先后。
 */
export function registerToolCatalog(deps: ToolCatalogDeps): void {
  registerPlaceTools(deps);
  registerPlanningTools(deps);
  registerTripTools(deps);
}
