import { randomUUID } from 'node:crypto';
import type { ServerContext } from '../server/http/context.js';
import type { PlanStop, RouteLeg } from '../domain/types.js';
import { getStopStart } from '../domain/normalize.js';

export async function editAgentPlan(ctx: ServerContext, actorId: string, args: Record<string, unknown>) {
  // Resolve network-backed data first; read the latest revision immediately before mutation.
  const directory = ctx.options.placeProvider || ctx.fallbackPlaceProvider;
  const needsPlace = args.action === 'add_place' || args.action === 'replace_place';
  const place = needsPlace ? await directory.detail(String(args.placeId || '')) : undefined;
  if (needsPlace && !place) throw new Error('地点不存在，请先查询地点目录。');
  const plan = ctx.planLibrary.list(actorId).find(p => p.id === args.planId);
  if (!plan) throw new Error('找不到这个方案，或它不属于当前身份。');
  if ((plan.revision || 0) !== args.expectedRevision) throw new Error('计划已有更新，请重新读取后再修改。');
  const days = structuredClone(plan.days || []);
  const day = plan.kind === 'scheme' ? days.find(d => d.dayIndex === args.dayIndex) : {
    stops: structuredClone(plan.stops), routeLegs: structuredClone(plan.routeLegs), plannedCharges: structuredClone(plan.plannedCharges),
  };
  if (!['rename', 'set_days', 'reschedule'].includes(String(args.action)) && !day) throw new Error('请指定要修改的第几天，dayIndex 从 0 开始。');
  const changedDays = new Set<NonNullable<typeof day>>();
  let name = plan.name;
  let localDate = plan.localDate;
  if (args.action === 'rename') {
    if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('请提供新的方案名称。');
    name = args.name.trim();
  } else if (args.action === 'reschedule') {
    if (plan.kind !== 'plan') throw new Error('改期用于日计划；多日方案请使用 plans.load 选择载入日期。');
    if (typeof args.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.localDate)) throw new Error('请提供目标日期，格式为 YYYY-MM-DD。');
    localDate = args.localDate;
  } else if (args.action === 'set_days') {
    if (plan.kind !== 'scheme') throw new Error('只有多日方案可以调整总天数。');
    if (!Number.isInteger(args.dayCount) || Number(args.dayCount) < 1 || Number(args.dayCount) > 30) throw new Error('方案天数应为 1 至 30 天。');
    const count = Number(args.dayCount);
    if (days.length > count) days.splice(count);
    while (days.length < count) days.push({ dayIndex: days.length, stops: [], routeLegs: [], plannedCharges: [] });
  } else if (args.action === 'move_stop') {
    if (plan.kind !== 'scheme') throw new Error('跨天移动目前用于多日方案，请先读取方案。');
    const target = days.find(d => d.dayIndex === args.targetDayIndex);
    if (!target) throw new Error('目标日期不存在，请先调整方案天数。');
    if (target === day) throw new Error('目标与原日期相同；只改时间请用 plans.adjust_stop。');
    if (target.stops.length >= 40) throw new Error('目标日期最多安排 40 个地点。');
    const stop = (day!.stops as PlanStop[]).find(s => s.stopId === args.stopId);
    if (!stop) throw new Error('找不到要移动的节点。');
    if (stop.status && stop.status !== 'planned') throw new Error('不能移动已有进度的节点。');
    if (args.startMinutes !== undefined) {
      if (!Number.isInteger(args.startMinutes) || Number(args.startMinutes) < 0 || Number(args.startMinutes) > 2879) throw new Error('目标时间无效。');
      const delta = Number(args.startMinutes) - getStopStart(stop);
      for (const field of ['startMinutes', 'plannedArrivalMinutes', 'endMinutes', 'departureMinutes', 'plannedStartMinutes', 'plannedDepartureMinutes'] as const) {
        if (typeof stop[field] === 'number') stop[field] += delta;
      }
    }
    if (args.durationMinutes !== undefined) {
      if (!Number.isInteger(args.durationMinutes) || Number(args.durationMinutes) < 1 || Number(args.durationMinutes) > 1440) throw new Error('游览时长应为 1 至 1440 分钟。');
      const end = getStopStart(stop) + Number(args.durationMinutes);
      Object.assign(stop, { endMinutes: end, departureMinutes: end, plannedDepartureMinutes: end, minDurationMinutes: Number(args.durationMinutes), plannedDurationMinutes: Number(args.durationMinutes) });
    }
    delete stop.travelStartMinutes;
    day!.stops = day!.stops.filter(s => (s as PlanStop).stopId !== stop.stopId);
    target.stops.push(stop);
    const charges = (day!.plannedCharges || []).filter(c => (c as { stopId?: string; routeLegRef?: string }).stopId === stop.stopId && !(c as { routeLegRef?: string }).routeLegRef);
    target.plannedCharges = [...(target.plannedCharges || []), ...charges];
    changedDays.add(target);
  } else if (args.action === 'add_place') {
    if (!Number.isInteger(args.startMinutes) || Number(args.startMinutes) < 0 || Number(args.startMinutes) > 2879 || !Number.isInteger(args.durationMinutes) || Number(args.durationMinutes) < 1 || Number(args.durationMinutes) > 1440) throw new Error('添加地点需要有效的起始时间和游览时长。');
    if (day!.stops.length >= 40) throw new Error('一天最多安排 40 个地点。');
    const start = Number(args.startMinutes), duration = Number(args.durationMinutes);
    const stop: PlanStop = {
      stopId: `stop_${randomUUID()}`, placeId: place!.placeId,
      place: { placeId: place!.placeId, name: place!.name, coordinates: place!.coordinates, facilityCodes: place!.facilityCodes, cityCode: place!.cityCode },
      status: 'planned', startMinutes: start, plannedArrivalMinutes: start,
      endMinutes: start + duration, departureMinutes: start + duration,
      minDurationMinutes: duration, plannedDurationMinutes: duration,
    };
    day!.stops.push(stop);
  } else if (args.action === 'replace_place') {
    const index = day!.stops.findIndex(s => (s as PlanStop).stopId === args.stopId);
    if (index < 0) throw new Error('找不到要替换的节点。');
    const stop = day!.stops[index] as PlanStop;
    if (stop.status && stop.status !== 'planned') throw new Error('不能替换正在进行或已有进度的地点。');
    if ((stop.placeId || stop.place?.placeId) === place!.placeId) return plan;
    const replacedLegs = new Set(day!.routeLegs.filter(value => {
      const leg = value as RouteLeg;
      return leg.fromStopId === stop.stopId || leg.toStopId === stop.stopId;
    }).map(value => (value as RouteLeg).legId));
    if ((day!.plannedCharges || []).some(value => {
      const charge = value as { stopId?: string; routeLegRef?: string; paymentStatus?: string };
      return charge.paymentStatus === 'paid' && (charge.stopId === stop.stopId || Boolean(charge.routeLegRef && replacedLegs.has(charge.routeLegRef)));
    })) throw new Error('原地点或交通已有付款记录，请先处理对应费用，不能直接替换并删除付款记录。');
    const replacement: PlanStop = { ...stop, stopId: `stop_${randomUUID()}`, placeId: place!.placeId,
      place: { placeId: place!.placeId, name: place!.name, coordinates: place!.coordinates, facilityCodes: place!.facilityCodes, cityCode: place!.cityCode } };
    delete replacement.travelStartMinutes;
    delete replacement.openingIntervals;
    delete replacement.evidenceRefs;
    delete replacement.baseRevision;
    day!.stops[index] = replacement;
  } else if (args.action === 'remove_stop') {
    const stop = (day!.stops as PlanStop[]).find(s => s.stopId === args.stopId);
    if (!stop) throw new Error('找不到要移除的节点，请重新读取计划。');
    if (stop.status && stop.status !== 'planned') throw new Error('不能移除正在进行或已有进度的节点。');
    day!.stops = day!.stops.filter(s => (s as PlanStop).stopId !== stop.stopId);
  } else throw new Error('不支持的修改操作。');

  if (day && !['rename', 'set_days', 'reschedule'].includes(String(args.action))) changedDays.add(day);
  for (const changed of changedDays) {
    changed.stops.sort((a, b) => getStopStart(a as PlanStop) - getStopStart(b as PlanStop));
    const ids = changed.stops.map(s => (s as PlanStop).stopId);
    // Insertion/removal invalidates routes that no longer connect consecutive stops.
    changed.routeLegs = changed.routeLegs.filter(value => {
      const leg = value as RouteLeg;
      const index = ids.indexOf(leg.toStopId);
      return index >= 0 && (index === 0 ? ['origin', 'my-location'].includes(leg.fromStopId) : leg.fromStopId === ids[index - 1]);
    });
    const legIds = new Set(changed.routeLegs.map(l => (l as RouteLeg).legId));
    changed.plannedCharges = (changed.plannedCharges || []).filter(value => {
      const charge = value as { stopId?: string; routeLegRef?: string };
      return (!charge.stopId || ids.includes(charge.stopId)) && (!charge.routeLegRef || legIds.has(charge.routeLegRef));
    });
  }
  return ctx.planLibrary.update(actorId, plan.id, { name, localDate, timezone: plan.timezone,
    ...(plan.kind === 'scheme' ? { days } : { snapshot: day }) });
}
