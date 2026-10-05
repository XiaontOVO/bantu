import type { ServerContext } from '../server/http/context.js';
import type { ModelToolDefinition } from '../providers/model.js';
import { customTagNames } from '../domain/place-tags.js';

export function personalPlaceTagTools(ctx: ServerContext, actorId: string, refresh: Set<string>) {
  const directory = ctx.options.placeProvider || ctx.fallbackPlaceProvider;
  const resolve = async (id: unknown) => {
    const place = await directory.detail(String(id));
    if (!place) throw new Error('地点不存在或尚未公开，请先查询地点目录。');
    return place;
  };
  const definitions: Array<ModelToolDefinition & { writes?: boolean; run: (args: Record<string, unknown>) => Promise<unknown> }> = [
    { name: 'places.my_tags', description: '读取某个目录地点仅当前账号可见的自定义标签，不包含官方分类。', inputSchema: { type: 'object', properties: { placeId: { type: 'string' } }, required: ['placeId'], additionalProperties: false }, run: async a => {
      const place = await resolve(a.placeId);
      return { placeId: place.placeId, name: place.name, customTags: ctx.communityService.myTags(place.placeId, actorId) };
    } },
    { name: 'places.edit_tags', writes: true, description: '按用户要求添加、移除或替换自己的地点标签。add/remove 保留其他标签；replace 仅用于用户明确要求整体替换或清空。标签只对自己可见，每地点最多8个、每个20字。先查询目录获取placeId。', inputSchema: { type: 'object', properties: { placeId: { type: 'string' }, action: { type: 'string', enum: ['add', 'remove', 'replace'] }, tags: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 20 } } }, required: ['placeId', 'action', 'tags'], additionalProperties: false }, run: async a => {
      const place = await resolve(a.placeId);
      const tags = customTagNames(a.tags);
      // Read after network lookup so an additive edit preserves concurrent tags.
      const current = ctx.communityService.myTags(place.placeId, actorId);
      const next = a.action === 'add' ? [...new Set([...current, ...tags])] : a.action === 'remove' ? current.filter(tag => !tags.includes(tag)) : a.action === 'replace' ? tags : undefined;
      if (!next) throw new Error('标签操作无效。');
      const saved = ctx.communityService.saveTags(place.placeId, actorId, next);
      refresh.add('places'); refresh.add('community');
      return { placeId: place.placeId, name: place.name, ...saved };
    } },
  ];
  return definitions;
}
