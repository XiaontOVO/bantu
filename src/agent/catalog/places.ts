/**
 * 目录、路线与天气工具：全部是**只读**的外部资料获取。
 *
 * 这三个是模型回答"这里有什么、怎么走、天气如何"的唯一来源。共同特点：
 * 结果里必须带来源（`evidence`），不可用时返回明确错误，**不允许模型自己编**。
 *
 * `weather.read` 只在真的配了供应商时登记——没配就整条工具不存在，
 * 模型看到的能力清单里也就不会出现它（比"登记了但总是失败"更诚实）。
 */
import type { ToolCatalogDeps } from './deps.js';
import { OFFICIAL_PLACE_TAGS } from '../../domain/place-tags.js';

export function registerPlaceTools(deps: ToolCatalogDeps): void {
  deps.gateway.register({
    name: 'places.search',
    description: '在试点城市目录内搜索有来源的地点',
    inputSchema: {
      type: 'object',
      properties: {
        cityCode: { type: 'string' },
        query: { type: 'string' },
        category: { type: 'string' },
        tag: { type: 'string', enum: OFFICIAL_PLACE_TAGS.map(tag => tag.id), description: OFFICIAL_PLACE_TAGS.map(tag => `${tag.id}：${tag.label}`).join('，') },
        limit: { type: 'number' },
      },
    },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: async (args) => {
      const result = await deps.placeProvider.search({
        // 伴途当前默认目录是上海徐汇；只有用户明确提供城市时才切换城市。
        // 这里不能沿用旧的杭州默认值，否则 Agent 搜索会把方案城市写错。
        cityCode: String(args.cityCode ?? '310100'),
        query: typeof args.query === 'string' ? args.query : undefined,
        category: typeof args.category === 'string' ? args.category : undefined,
        tag: typeof args.tag === 'string' ? args.tag : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      if (result.error) return { error: result.error };
      return { result };
    },
  });

  deps.gateway.register({
    name: 'routes.estimate',
    description: '估计两个地点之间的路线、时间和步行量',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'object' },
        destination: { type: 'object' },
        transportMode: { type: 'string' },
      },
    },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: async (args) => {
      if (!args.origin || !args.destination) {
        return { error: { code: 'INVALID_INPUT', message: '需要起终点。' } };
      }
      const result = await deps.routeProvider.plan({
        origin: args.origin as never,
        destination: args.destination as never,
        transportMode:
          args.transportMode === 'transit' || args.transportMode === 'driving'
            ? args.transportMode
            : 'walking',
        dataMode: 'demo',
      });
      if (result.error) return { error: result.error };
      return { result };
    },
  });

  if (deps.weatherProvider && deps.weatherProvider.providerName !== 'weather_disabled') {
    deps.gateway.register({
      name: 'weather.read',
      description: '读取区域天气资料；不可用时仍支持用户报告触发事件',
      inputSchema: {
        type: 'object',
        properties: {
          cityCode: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['cityCode'],
      },
      effect: 'read',
      permissionPolicy: 'auto',
      handler: async (args) => {
        const result = await deps.weatherProvider!.read({
          cityCode: String(args.cityCode),
          date: String(args.date ?? new Date().toISOString().slice(0, 10)),
        });
        if (!result.available) {
          return { error: result.error ?? { code: 'WEATHER_UNAVAILABLE', message: '天气资料不可用。' } };
        }
        return { result };
      },
    });
  }

  deps.gateway.register({
    name: 'places.detail',
    description: '读取一个已识别地点的目录详情与来源',
    inputSchema: {
      type: 'object',
      properties: { placeId: { type: 'string' } },
      required: ['placeId'],
    },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: async (args) => {
      const place = await deps.placeProvider.detail(String(args.placeId));
      if (!place) return { error: { code: 'PLACE_NOT_FOUND', message: '地点不存在。' } };
      return { result: place, resourceRef: place.placeId };
    },
  });
}
