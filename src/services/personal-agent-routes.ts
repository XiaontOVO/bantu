import { randomUUID } from 'node:crypto';
import type { ServerContext } from '../server/http/context.js';
import type { PlanStop, RouteLeg, TransportMode, PlannedCharge } from '../domain/types.js';
import { getStopStart, getStopEnd } from '../domain/normalize.js';
import type { PlaceProvider } from '../providers/travel.js';

export async function planAgentRoutes(ctx: ServerContext, actorId: string, args: Record<string, unknown>, resolveDirectoryPlace?: PlaceProvider['detail']) {
  const plan = ctx.planLibrary.list(actorId).find(p => p.id === args.planId);
  if (!plan || (plan.revision || 0) !== args.expectedRevision) throw new Error('计划不存在或已有更新，请重新读取。');
  if (args.mode !== undefined && !['walking', 'driving', 'transit'].includes(String(args.mode))) throw new Error('交通方式无效。');
  if (args.toStopId !== undefined && args.mode === undefined) throw new Error('请选择该地点的交通方式。');
  const days = structuredClone(plan.days || []);
  const day = plan.kind === 'scheme' ? days.find(d => d.dayIndex === args.dayIndex) : structuredClone(plan);
  if (!day) throw new Error('请指定方案中的第几天。');
  const stops = (day.stops as PlanStop[]).sort((a, b) => getStopStart(a) - getStopStart(b));
  const directory = ctx.options.placeProvider || ctx.fallbackPlaceProvider;
  const routes = ctx.options.routeProvider || ctx.fallbackRouteProvider;
  if (routes.providerName === 'demo_route_estimator') throw new Error('尚未连接实际路线服务，不能将样例路线保存到计划。');
  const legs = structuredClone(day.routeLegs || []) as RouteLeg[];
  const updated: RouteLeg[] = [];
  const routeStops = stops.filter(stop => stop.status !== 'skipped');
  const selectedIndex = args.toStopId === undefined ? -1 : routeStops.findIndex(stop => stop.stopId === args.toStopId);
  if (args.toStopId !== undefined && (selectedIndex < 1 || (routeStops[selectedIndex].status && routeStops[selectedIndex].status !== 'planned'))) throw new Error('请选择有上一站且尚未执行的目标节点。');
  const destinations = new Set(routeStops.filter((stop, index) => index > 0 && (!stop.status || stop.status === 'planned') && (selectedIndex < 0 || index === selectedIndex)).map(stop => stop.stopId));
  const replacedLegIds = new Set(legs.filter(leg => destinations.has(leg.toStopId)).map(leg => leg.legId));
  const charges = (day.plannedCharges || []) as PlannedCharge[];
  if (charges.some(charge => charge.routeLegRef && replacedLegIds.has(charge.routeLegRef) && (charge.paymentStatus === 'paid' || charge.includedSpendEventId))) throw new Error('这段交通已有付款记录，请先处理对应费用，不能直接改写已付款路线。');
  // 相邻路段共享中间节点（第 i 站的终点是第 i+1 站的起点），按 placeId 记忆化，
  // 避免对同一地点重复请求高德详情—— bursts 下重复请求会触发限流，导致整段路线规划失败。
  const detailCache = new Map<string, Awaited<ReturnType<typeof directory.detail>>>();
  const resolvePlace = (placeId: string) => {
    const cached = detailCache.get(placeId);
    if (cached !== undefined) return Promise.resolve(cached);
    return (resolveDirectoryPlace || (id => directory.detail(id)))(placeId).then(resolved => { detailCache.set(placeId, resolved); return resolved; });
  };
  for (let i = 1; i < routeStops.length; i++) {
    const from = routeStops[i - 1], to = routeStops[i];
    if (to.status && to.status !== 'planned') continue;
    if (selectedIndex >= 0 && i !== selectedIndex) {
      if (i > selectedIndex) {
        const retained = legs.find(leg => leg.fromStopId === from.stopId && leg.toStopId === to.stopId);
        const minutes = retained ? (retained.durationSeconds !== undefined ? Math.ceil(retained.durationSeconds / 60) : retained.durationMinutes || 0) + (retained.bufferMinutes || 0) : 0;
        if (!Number.isFinite(minutes) || minutes < 0) throw new Error('后续路线时间无效，请先重新规划后续路线。');
        const start = getStopStart(to), end = getStopEnd(to), arrival = Math.max(start, getStopEnd(from) + minutes);
        if (arrival > start) Object.assign(to, { startMinutes: arrival, plannedArrivalMinutes: arrival, plannedStartMinutes: arrival, endMinutes: arrival + end - start, departureMinutes: arrival + end - start, plannedDepartureMinutes: arrival + end - start, ...(retained ? { travelStartMinutes: arrival - minutes } : {}) });
      }
      continue;
    }
    const origin = await resolvePlace(String(from.placeId || from.place?.placeId || ''));
    const destination = await resolvePlace(String(to.placeId || to.place?.placeId || ''));
    if (!origin?.coordinates || !destination?.coordinates) throw new Error('路线地点缺少目录坐标，尚未修改计划。');
    const old = legs.find(l => l.fromStopId === from.stopId && l.toStopId === to.stopId);
    const mode = (args.mode || to.preferredTransportMode || old?.transportMode || 'walking') as TransportMode;
    if (!['walking', 'driving', 'transit'].includes(mode)) throw new Error('地点交通方式无效，尚未修改计划。');
    const result = await routes.plan({ origin, destination, cityCode: origin.cityCode, transportMode: mode });
    if (result.error || !result.leg || result.departureSupport === 'demo') throw new Error(result.error?.message || '未取得实际路线，尚未修改计划。');
    if (result.leg.transportMode !== mode) throw new Error('路线服务返回的交通方式与请求不一致，尚未修改计划。');
    const duration = result.leg.durationSeconds !== undefined ? Math.ceil(result.leg.durationSeconds / 60) : result.leg.durationMinutes;
    const buffer = result.leg.bufferMinutes || 0;
    if (!Number.isFinite(duration) || duration! < 0 || !Number.isFinite(buffer) || buffer < 0) throw new Error('路线时间无效，尚未修改计划。');
    updated.push({ ...result.leg, departureSupport: result.departureSupport, legId: old?.legId || `leg_${randomUUID()}`, fromStopId: from.stopId, toStopId: to.stopId });
    const start = getStopStart(to), end = getStopEnd(to);
    const arrival = Math.max(start, getStopEnd(from) + duration! + buffer);
    Object.assign(to, { preferredTransportMode: mode, startMinutes: arrival, plannedArrivalMinutes: arrival, plannedStartMinutes: arrival, endMinutes: arrival + end - start, departureMinutes: arrival + end - start, plannedDepartureMinutes: arrival + end - start, travelStartMinutes: arrival - duration! - buffer });
    delete to.estimatedTravelMinutes;
    delete to.estimatedTransportMode;
  }
  if (!updated.length) throw new Error('至少需要两个相邻地点，且终点尚未执行，才能保存路线。');
  if ((ctx.planLibrary.get(actorId, plan.id).revision || 0) !== args.expectedRevision) throw new Error('查询路线期间计划已有更新，请重新读取后再规划。');
  // A planned destination has only one incoming route. Remove stale edges from skipped origins.
  day.routeLegs = [...legs.filter(l => !updated.some(n => n.toStopId === l.toStopId)), ...updated];
  // An old fare estimate cannot be silently attached to a newly calculated route.
  day.plannedCharges = [
    ...charges.filter(charge => !charge.routeLegRef || !replacedLegIds.has(charge.routeLegRef)),
    ...updated.filter(leg => leg.costEstimate).map(leg => ({ chargeId: `charge_${randomUUID()}`, routeLegRef: leg.legId, quantity: 1, costEstimate: structuredClone(leg.costEstimate!), paymentStatus: 'unpaid' as const })),
  ];
  day.stops = stops;
  const saved = ctx.planLibrary.update(actorId, plan.id, { name: plan.name, localDate: plan.localDate, timezone: plan.timezone,
    ...(plan.kind === 'scheme' ? { days } : { snapshot: { stops, routeLegs: day.routeLegs, plannedCharges: day.plannedCharges } }) });
  return ctx.planLibrary.list(actorId).find(item => item.id === saved.id)!;
}
