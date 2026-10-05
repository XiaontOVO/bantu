import type { ServerContext } from '../server/http/context.js';
import type { ExecutionEvent, PlanStop, TransportMode } from '../domain/types.js';
const readTransportMode = (value: unknown): TransportMode => value === 'transit' || value === 'driving' ? value : 'walking';

/** 校验实际路线估算所需的起终点坐标。 */
function validCoordinates(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== 'object') return null;
  const coords = ((value as Record<string, unknown>).coordinates ?? value) as Record<string, unknown>;
  const lat = coords.lat;
  const lng = coords.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * 出发时按用户选择的交通方式和实时起点规划路线。缺少坐标或路线服务失败时，
 * 只记录交通方式，不编造一个固定分钟数。
 */
export async function estimateDepartTravel(
  ctx: ServerContext,
  actorId: string,
  planId: string,
  body: Record<string, unknown>,
): Promise<{ estimatedTravelMinutes?: number; estimatedTransportMode: TransportMode }> {
  const stopId = String(body.stopId || '');
  let requestedMode = readTransportMode(body.transportMode);
  const noRouteEstimate = (mode: TransportMode) => ({ estimatedTransportMode: mode });
  try {
    const plan = ctx.planLibrary.get(actorId, planId) as { stops?: unknown; routeLegs?: unknown; executionEvents?: unknown; cityCode?: string };
    const stops = (Array.isArray(plan.stops) ? plan.stops : []) as PlanStop[];
    const active = stops.filter(stop => stop && typeof stop === 'object' && stop.status !== 'skipped');
    const index = active.findIndex(stop => stop.stopId === stopId);
    if (index < 0) return noRouteEstimate(requestedMode);
    const legs = (Array.isArray(plan.routeLegs) ? plan.routeLegs : []) as Array<{ toStopId?: string; transportMode?: TransportMode }>;
    const mode: TransportMode = typeof body.transportMode === 'string'
      ? requestedMode
      : active[index].preferredTransportMode ?? legs.find(leg => leg?.toStopId === stopId)?.transportMode ?? 'walking';
    requestedMode = mode;
    if (body.skipRouteEstimate === true) return noRouteEstimate(mode);
    const events = (Array.isArray(plan.executionEvents) ? plan.executionEvents : []) as ExecutionEvent[];
    let lastVisited: PlanStop | null = null;
    for (const event of events) {
      if ((event.type === 'arrive' || event.type === 'complete') && event.stopId !== stopId) {
        lastVisited = active.find(stop => stop.stopId === event.stopId) ?? lastVisited;
      }
    }
    const previous = index > 0 ? active[index - 1] : null;
    const origin = validCoordinates(body.origin) ?? validCoordinates(lastVisited?.place) ?? validCoordinates(previous?.place);
    const destination = validCoordinates(active[index].place);
    if (!origin || !destination) return noRouteEstimate(mode);
    const providerName = (ctx.options.routeProvider ?? ctx.fallbackRouteProvider).providerName;
    const placeId = active[index].place?.placeId;
    const estimate = await ctx.estimateRoute({
      from: origin,
      to: placeId ? { ...destination, placeId } : destination,
      transportMode: mode,
      ...(plan.cityCode ? { cityCode: plan.cityCode } : {}),
    }, providerName === 'demo_route_estimator' ? 'demo' : 'online');
    if (estimate.error) return noRouteEstimate(mode);
    const leg = estimate.leg;
    const seconds = Number(leg?.durationSeconds);
    const minutes = Number.isFinite(seconds) && seconds > 0
      ? seconds / 60
      : Number(leg?.durationMinutes) > 0
        ? Number(leg?.durationMinutes) + Math.max(0, Number(leg?.bufferMinutes) || 0)
        : NaN;
    if (!Number.isFinite(minutes) || minutes <= 0) return noRouteEstimate(mode);
    return { estimatedTravelMinutes: Math.max(1, Math.ceil(minutes)), estimatedTransportMode: mode };
  } catch {
    return noRouteEstimate(requestedMode);
  }
}

