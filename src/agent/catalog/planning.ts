/**
 * 计划类工具：提案 → 应用 → 撤销。
 *
 * 三者的许可策略刻意不同，这是本文件最需要守住的东西：
 *
 * - `plan.propose` **不写正式计划**，只产出待选提案，所以可以自主执行；
 * - `plan.apply` 会改正式计划，必须 `requires_user_grant`，并自己消费许可
 *   （`grantConsumption: 'handler'`：许可在真正写入的那一步才消耗，失败不吞掉许可）；
 * - `plan.undo` 同样是写操作，也要许可——"撤销"不是免责操作。
 *
 * 如果哪天想把 propose 改成自动应用，先看 `docs/07`：那等于让模型绕过用户批准。
 */
import type { ToolCatalogDeps } from './deps.js';
import { buildDemoPlanSnapshot, buildEventReplanSnapshot } from '../../demo/demo-data.js';
import { tripClock } from '../../domain/plan-boundaries.js';

export function registerPlanningTools(deps: ToolCatalogDeps): void {
  // plan.propose 只创建待选提案，不写正式计划；因此可自主执行。
  deps.gateway.register({
    name: 'plan.propose',
    description: '根据冻结版本生成 initial/replan 待选提案',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['initial', 'replan'] },
        baseRevision: { type: 'number' },
        contextSnapshotId: { type: 'string' },
        eventType: { type: 'string' },
      },
      required: ['kind', 'baseRevision'],
    },
    effect: 'read',
    permissionPolicy: 'auto',
    handler: (args, context) => {
      const tripResult = deps.tripService.getTrip(context.actorId, context.tripId);
      if (!tripResult.ok) return { error: tripResult.error };
      const trip = tripResult.value;
      const clock = tripClock(trip.snapshot, context.now);
      const departure = Math.max(trip.snapshot.dayStartMinutes ?? 540, clock.relation === 'today' ? clock.minutes + 10 : 0);
      const kind = args.kind === 'replan' ? 'replan' : 'initial';
      const baseRevision = Number(args.baseRevision ?? trip.trip.revision);
      const contextSnapshotId =
        typeof args.contextSnapshotId === 'string'
          ? args.contextSnapshotId
          : context.metadata?.contextSnapshotId as string | undefined ?? trip.trip.latestContextId;
      const event =
        context.metadata?.event && typeof context.metadata.event === 'object'
          ? (context.metadata.event as Record<string, unknown>)
          : { type: String(args.eventType ?? 'rest_requested') };
      const candidateSnapshot =
        kind === 'initial'
          ? buildDemoPlanSnapshot({
              tripId: trip.trip.tripId,
              dataMode: trip.trip.dataMode,
              timezone: trip.trip.timezone,
              travelDate: trip.trip.localDate ?? new Date().toISOString().slice(0, 10),
              dayStartMinutes: departure,
              partySize: trip.snapshot.tripSettings?.partySize ?? 2,
              includeRest: false,
            })
          : buildEventReplanSnapshot({ ...trip.snapshot, dayStartMinutes: departure }, event);
      const relaxedSnapshot = kind === 'initial' ? buildDemoPlanSnapshot({
        tripId: trip.trip.tripId, dataMode: trip.trip.dataMode, timezone: trip.trip.timezone,
        travelDate: trip.trip.localDate ?? new Date().toISOString().slice(0, 10), dayStartMinutes: departure,
        partySize: trip.snapshot.tripSettings?.partySize ?? 2, includeRest: true,
      }) : structuredClone(candidateSnapshot);
      if (kind === 'initial' && !(candidateSnapshot.stops ?? []).length && !(relaxedSnapshot.stops ?? []).length) {
        return {
          error: {
            code: 'PLAN_TIME_OR_PROGRESS_CONFLICT',
            message: '当前没有可用地点，无法生成初始方案。',
          },
        };
      }
      const removable = kind === 'replan' ? (relaxedSnapshot.stops || []).filter(stop => stop.status === 'planned' && !stop.retain && !stop.retainStop && !stop.lockTime && !stop.timeLocked).at(-1) : undefined;
      if (removable) {
        relaxedSnapshot.stops = (relaxedSnapshot.stops || []).filter(stop => stop.stopId !== removable.stopId);
        relaxedSnapshot.routeLegs = (relaxedSnapshot.routeLegs || []).filter(leg => leg.fromStopId !== removable.stopId && leg.toStopId !== removable.stopId);
        relaxedSnapshot.plannedCharges = relaxedSnapshot.plannedCharges?.filter(charge => charge.stopId !== removable.stopId);
      }
      const proposal = deps.tripService.createProposal(context.actorId, context.tripId, {
        kind,
        baseRevision,
        contextSnapshotId,
        sessionId: context.sessionId,
        candidates: [
          ...(kind !== 'initial' || (candidateSnapshot.stops ?? []).length ? [{
            candidateId: kind === 'initial' ? 'initial_agent_1' : 'rest_agent_1',
              title: kind === 'initial' ? '经典游览安排' : String(event.type).includes('rain') ? '雨天室内调整' : String(event.type).includes('delay') ? '延误后重排安排' : '插入休息并保留后续安排',
            summary:
              kind === 'initial'
                ? '基于当前地点目录和路线估算生成的待核实方案。'
                : '按本次需求生成候选，确认后更新正式行程。',
            snapshot: candidateSnapshot,
          }] : []),
          ...(kind === 'initial' ? ((relaxedSnapshot.stops ?? []).length ? [{
            candidateId: 'initial_agent_2',
            title: '增加茶歇的慢游安排',
            summary: '在游览间增加休息点，对比交通和费用后选择。出发前请核对实际情况。',
            snapshot: relaxedSnapshot,
          }] : []) : removable ? [{
            candidateId: 'rest_agent_2',
            title: '减少一站，留出余裕',
            summary: `沿用本次调整，移除末尾可调整地点「${removable.place?.name || removable.stopId}」，留出更多自由时间。`,
            snapshot: relaxedSnapshot,
          }] : []),
        ],
      });
      if (!proposal.ok) return { error: proposal.error };
      return {
        result: {
          proposalId: proposal.value.proposal.proposalId,
          proposal: proposal.value.proposal,
          actionRequests: proposal.value.actionRequests,
        },
        resourceRef: proposal.value.proposal.proposalId,
      };
    },
  });

  deps.gateway.register({
    name: 'plan.apply',
    description: '应用已展示并通过具体许可的候选方案',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        candidateId: { type: 'string' },
        expectedRevision: { type: 'number' },
      },
      required: ['proposalId', 'candidateId', 'expectedRevision'],
    },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    grantConsumption: 'handler',
    handler: (args, context) => {
      const applied = deps.tripService.applyProposal({
        actorId: context.actorId,
        sessionId: context.sessionId,
        tripId: context.tripId,
        proposalId: String(args.proposalId),
        candidateId: typeof args.candidateId === 'string' ? args.candidateId : undefined,
        expectedRevision: Number(args.expectedRevision),
        actionRequestId: context.actionRequestId!,
        grantId: context.grantId!,
        idempotencyKey: String(
          context.metadata?.idempotencyKey ??
            `agent:${context.metadata?.operationId ?? 'op'}:${context.actionRequestId}`,
        ),
      });
      if (!applied.ok) return { error: applied.error };
      return {
        result: applied.value,
        mutationId: applied.value.mutationId,
        resourceRef: applied.value.mutationId,
      };
    },
  });

  deps.gateway.register({
    name: 'plan.undo',
    description: '撤销最近一次已应用的调整',
    inputSchema: {
      type: 'object',
      properties: {
        mutationId: { type: 'string' },
        expectedRevision: { type: 'number' },
      },
      required: ['mutationId', 'expectedRevision'],
    },
    effect: 'write',
    permissionPolicy: 'requires_user_grant',
    handler: (args, context) => {
      const result = deps.tripService.undo({
        actorId: context.actorId,
        sessionId: context.sessionId,
        tripId: context.tripId,
        mutationId: String(args.mutationId),
        expectedRevision: Number(args.expectedRevision),
        idempotencyKey: String(
          context.metadata?.idempotencyKey ??
            `agent-undo:${context.metadata?.operationId ?? 'op'}`,
        ),
      });
      if (!result.ok) return { error: result.error };
      return {
        result: result.value,
        mutationId: result.value.mutationId,
        resourceRef: result.value.mutationId,
      };
    },
  });
}
