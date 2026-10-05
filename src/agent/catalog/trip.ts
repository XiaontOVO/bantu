/**
 * 单趟旅行范围内的工具：读取状态、改偏好与约束、记执行事实、收藏、随手记。
 *
 * 共同点：都作用于**当前这趟旅行**（`context.tripId`），不产生跨旅行的副作用。
 * 除 `trip.read` 外都是写操作，都要用户许可。
 *
 * 两条容易写错的规则：
 *
 * - `preferences.update` 带 `expectedRevision`：偏好与约束也是计划的一部分，
 *   并发的两次修改不能后写覆盖先写；
 * - `progress.record` 记的是**用户明确报告的事实**，不是推断。
 *   `occurredAt` 缺省用 `context.now`（服务端时钟），不要用模型编的时间。
 */
import type { ToolCatalogDeps } from './deps.js';

export function registerTripTools(deps: ToolCatalogDeps): void {
  deps.gateway.register({
    name: 'trip.read',
    description: '读取当前旅行、版本和进度',
    inputSchema: {
      type: 'object',
      properties: { tripId: { type: 'string' } },
      required: ['tripId'],
    },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: (args, context) => {
      const tripId = String(args.tripId ?? context.tripId);
      const result = deps.tripService.getTrip(context.actorId, tripId);
      if (!result.ok) return { error: result.error };
      return { result: result.value, resourceRef: tripId };
    },
  });

  deps.gateway.register({
    name: 'preferences.update',
    description: '更新本次旅行的已确认偏好或约束',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: { type: 'number' },
        partyNeeds: { type: 'object' },
        constraints: { type: 'array' },
        budget: { type: 'object' },
      },
      required: ['expectedRevision'],
    },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    handler: (args, context) => {
      const result = deps.tripService.patchTrip(context.actorId, context.tripId, {
        expectedRevision: Number(args.expectedRevision),
        partyNeeds:
          args.partyNeeds && typeof args.partyNeeds === 'object'
            ? (args.partyNeeds as Record<string, Record<string, unknown>>)
            : undefined,
        constraints: Array.isArray(args.constraints)
          ? (args.constraints as never)
          : undefined,
        budget:
          args.budget && typeof args.budget === 'object'
            ? (args.budget as never)
            : undefined,
      });
      if (!result.ok) return { error: result.error };
      return { result: result.value, resourceRef: context.tripId };
    },
  });

  deps.gateway.register({
    name: 'progress.record',
    description: '记录用户明确报告的出发、到达、完成、跳过或中止',
    inputSchema: {
      type: 'object',
      properties: {
        stopId: { type: 'string' },
        type: { type: 'string' },
        occurredAt: { type: 'string' },
        expectedRevision: { type: 'number' },
      },
      required: ['stopId', 'type'],
    },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    handler: (args, context) => {
      const result = deps.tripService.recordExecution({
        actorId: context.actorId,
        sessionId: context.sessionId,
        tripId: context.tripId,
        stopId: String(args.stopId),
        type: String(args.type) as 'depart' | 'arrive' | 'complete' | 'skip' | 'abort',
        occurredAt: String(args.occurredAt ?? context.now),
        expectedRevision:
          typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined,
      });
      if (!result.ok) return { error: result.error };
      return { result: result.value, resourceRef: String(args.stopId) };
    },
  });

  deps.gateway.register({
    name: 'shortlist.add',
    description: '把一个已识别地点加入本次候选收藏',
    inputSchema: {
      type: 'object',
      properties: { placeId: { type: 'string' } },
      required: ['placeId'],
    },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    handler: (args, context) => {
      const result = deps.tripService.addShortlist(
        context.actorId,
        context.tripId,
        String(args.placeId),
      );
      if (!result.ok) return { error: result.error };
      return { result: result.value, resourceRef: String(args.placeId) };
    },
  });

  deps.gateway.register({
    name: 'shortlist.remove',
    description: '从候选收藏移除一个地点，不改正式计划',
    inputSchema: {
      type: 'object',
      properties: { placeId: { type: 'string' } },
      required: ['placeId'],
    },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    handler: (args, context) => {
      const result = deps.tripService.removeShortlist(
        context.actorId,
        context.tripId,
        String(args.placeId),
      );
      if (!result.ok) return { error: result.error };
      return { result: result.value, resourceRef: String(args.placeId) };
    },
  });

  deps.gateway.register({
    name: 'memory.create',
    description: '按用户原文保存一条随手记',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    handler: (args, context) => {
      const result = deps.tripService.createMemory(context.actorId, context.tripId, {
        userText: String(args.text),
      });
      if (!result.ok) return { error: result.error };
      return { result: result.value, resourceRef: result.value.memory?.memoryId };
    },
  });
}
