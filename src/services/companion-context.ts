/** 随行只读视图：道路和天气结果不写执行事件，也不改计划版本。 */
import type { ServerContext } from '../server/http/context.js';
import type { PlanStop, TransportMode } from '../domain/types.js';
import { usableAgentLocation } from './personal-agent-location.js';

export class CompanionContextError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

export async function readCompanionContext(ctx: ServerContext, actorId: string, planId: string, body: Record<string, unknown>) {
  const plans = ctx.planLibrary.list(actorId).filter(plan => plan.kind === 'plan');
  const plan = plans.find(plan => plan.id === planId);
  if (!plan) throw new CompanionContextError('PLAN_NOT_FOUND', '计划已不存在，请重新选择。', 404);
  const revision = plan.revision || 0;
  if (body.expectedRevision !== revision) throw new CompanionContextError('COMPANION_STALE', '计划刚刚有变化，请重新查看下一步。');
  if (plans.filter(item => item.localDate === plan.localDate).length !== 1) throw new CompanionContextError('COMPANION_CONFLICT', '这个日期有重复安排，请先核对计划。');
  const active = plans.flatMap(item => (item.stops as PlanStop[]).filter(stop => ['en_route', 'visiting'].includes(stop.status || 'planned')).map(stop => ({ planId: item.id, stopId: stop.stopId })));
  if (active.length > 1 || active.length === 1 && active[0].planId !== plan.id) throw new CompanionContextError('COMPANION_CONFLICT', '请先结束仍在进行的地点。');
  const stops = plan.stops as PlanStop[];
  const next = stops.find(stop => ['en_route', 'visiting'].includes(stop.status || 'planned')) || stops.find(stop => (stop.status || 'planned') === 'planned');
  if (!next || body.stopId !== next.stopId) throw new CompanionContextError('COMPANION_STALE', '当前站点已变化，请重新查看下一步。');
  const mode = body.transportMode as TransportMode;
  if (!['walking', 'transit', 'driving'].includes(mode)) throw new CompanionContextError('INVALID_INPUT', '请选择有效交通方式。', 400);
  const provider = ctx.options.placeProvider || ctx.fallbackPlaceProvider;
  const placeId = next.placeId || next.place?.placeId;
  const place = placeId ? await provider.detail(placeId, 'online').catch(() => null) : null;
  const destination = place || next.place;
  const now = ctx.now();
  const position = usableAgentLocation(body.position, now);
  const origin = position && position.accuracyMeters > 0 && Date.parse(now) - position.measuredAt >= 0 && Date.parse(now) - position.measuredAt <= 120000 ? position : null;
  let route: Awaited<ReturnType<ServerContext['estimateRoute']>> | null = null;
  let routeReason = '需要两分钟内、误差不超过 200 米的设备定位，才能估算道路时间。';
  const routeProvider = ctx.options.routeProvider || ctx.fallbackRouteProvider;
  if (next.status === 'visiting') routeReason = '已由你确认到达，请查看场地导览。';
  else if (origin && destination?.coordinates) {
    if (routeProvider.providerName === 'demo_route_estimator') routeReason = '当前只有演示路线供应商，预计时间保持待估。';
    else {
      route = await ctx.estimateRoute({ origin, destination, transportMode: mode, cityCode: plan.cityCode }, 'online').catch(() => null);
      routeReason = route?.error?.message || '道路服务未返回可用路线，预计时间保持待估。';
    }
  } else if (!destination?.coordinates) routeReason = '目的地坐标待核实，预计时间保持待估。';
  const leg = route?.leg;
  const duration = leg && (Number.isFinite(leg.durationMinutes) ? leg.durationMinutes! : Number(leg.durationSeconds) / 60);
  const validRoute = !!leg && !route?.error && route?.departureSupport !== 'demo' && leg.transportMode === mode && Number.isFinite(duration) && duration! >= 0 && (!leg.expiresAt || Date.parse(leg.expiresAt) >= Date.parse(now));
  const previewOnly = plan.localDate! > new Intl.DateTimeFormat('en-CA', { timeZone: plan.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const weather = ctx.options.weatherProvider && destination?.coordinates
    ? await ctx.options.weatherProvider.read({ cityCode: plan.cityCode, date: plan.localDate!, center: destination.coordinates }).catch(() => ({ available: false }))
    : { available: false };
  const currentPlans = ctx.planLibrary.list(actorId);
  const latest = currentPlans.find(item => item.id === planId);
  if (!latest || latest.revision !== plan.revision || latest.localDate !== plan.localDate) throw new CompanionContextError('COMPANION_STALE', '查询期间进度已变化，请重新查看下一步。');
  if (currentPlans.some(item => item.id !== planId && item.kind === 'plan' && (item.stops as PlanStop[]).some(stop => ['en_route', 'visiting'].includes(stop.status || 'planned'))) || currentPlans.filter(item => item.kind === 'plan' && item.localDate === plan.localDate).length !== 1) throw new CompanionContextError('COMPANION_STALE', '查询期间其他安排已变化，请重新查看下一步。');
  return {
    planId, revision, stopId: next.stopId, mode, timezone: plan.timezone || 'Asia/Shanghai',
    phase: next.status === 'visiting' ? 'visit' : next.status === 'en_route' ? 'travel' : 'ready',
    route: validRoute ? route : null, routeUnknown: !validRoute, routeReason: validRoute ? '' : routeReason,
    originLabel: '当前位置', destinationLabel: destination?.name || '当前目的地',
    routeSource: routeProvider.providerName.includes('osrm') ? 'OpenStreetMap 道路路线' : routeProvider.providerName.includes('amap') ? '高德道路路线' : '道路供应商',
    origin: origin ? { lat: origin.lat, lng: origin.lng } : null, destination: destination?.coordinates || null,
    previewOnly,
    validUntil: validRoute ? new Date(Math.min(origin!.measuredAt + 120000, leg?.expiresAt ? Date.parse(leg.expiresAt) : Infinity)).toISOString() : null,
    eta: validRoute && !previewOnly ? new Date(Date.parse(now) + duration! * 60000).toISOString() : null,
    retrievedAt: now, weather,
  };
}
