import type { RouteLeg } from '../domain/types.js';
import type { RoutePlanInput, RoutePlanResult, RouteProvider } from './travel.js';
import { createRequire } from 'node:module';
import { RouteResultCache } from './route-cache.js';
const gcoord = createRequire(import.meta.url)('gcoord') as typeof import('gcoord')['default'];

const REQUEST_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 15_000;

interface OsrmStep {
  name?: string;
  maneuver?: {
    type?: string;
    modifier?: string;
    exit?: number;
  };
}

interface OsrmRouteResponse {
  code?: string;
  message?: string;
  waypoints?: Array<{ distance?: number; location?: [number, number] }>;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: { coordinates?: Array<[number, number]> };
    legs?: Array<{ steps?: OsrmStep[] }>;
  }>;
}

interface OsrmOptions {
  fetchImpl?: typeof fetch;
  walkingBaseUrl?: string;
  drivingBaseUrl?: string;
  timeoutMs?: number;
}

// FOSSGIS asks clients to make no more than one request per second. Keep one
// process-wide queue so separate provider instances cannot exceed that limit.
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function waitForSlot(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function withFossgisRequestSlot<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const ready = requestQueue.then(async () => {
    signal.throwIfAborted();
    const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt));
    if (waitMs > 0) await waitForSlot(waitMs, signal);
    signal.throwIfAborted();
    lastRequestStartedAt = Date.now();
  });
  // Limit request starts, not whole response lifetimes. A slow response must
  // not block every other traveler for its full timeout plus another second.
  requestQueue = ready.then(() => undefined, () => undefined);
  return ready.then(request);
}

function coordinatesOf(value: RoutePlanInput['origin']): { lat: number; lng: number } | null {
  const coordinates = 'coordinates' in value ? value.coordinates : value;
  if (!coordinates || !Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lng) || Math.abs(coordinates.lat)>90 || Math.abs(coordinates.lng)>180) return null;
  if ('source' in coordinates && coordinates.source === 'amap') {
    const [lng, lat] = gcoord.transform([coordinates.lng,coordinates.lat],gcoord.GCJ02,gcoord.WGS84);
    return { lat, lng };
  }
  return coordinates;
}

function distanceBetween(a: {lat:number;lng:number}, b: {lat:number;lng:number}) {
  const radians=(value:number)=>value*Math.PI/180;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(radians(b.lat-a.lat)/2)**2+Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(radians(b.lng-a.lng)/2)**2)));
}

function stopIdOf(value: RoutePlanInput['origin'], fallback: string): string {
  return 'placeId' in value && value.placeId ? value.placeId : fallback;
}

function instructionFor(step: OsrmStep): string | null {
  const type = step.maneuver?.type;
  const modifier = step.maneuver?.modifier?.toLowerCase();
  const name = step.name?.trim();
  const road = name ? `，沿${name}前行` : '';
  const turns: Record<string, string> = {
    left: '左转',
    'slight left': '向左前方行驶',
    'sharp left': '向左急转',
    right: '右转',
    'slight right': '向右前方行驶',
    'sharp right': '向右急转',
    straight: '直行',
    uturn: '掉头',
  };
  if (type === 'depart') return name ? `从起点出发，沿${name}前行` : '从起点出发';
  if (type === 'arrive') return '到达目的地';
  if (type === 'turn' || type === 'end of road' || type === 'fork' || type === 'off ramp' || type === 'on ramp') {
    const action = modifier ? turns[modifier] : undefined;
    return action ? `${action}${road}` : name ? `沿${name}继续前行` : '按路线继续前行';
  }
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
    const exit = step.maneuver?.exit;
    return Number.isInteger(exit) ? `进入环岛，从第${exit}个出口驶出${road}` : `进入环岛${road}`;
  }
  if (type === 'merge') return name ? `并入${name}` : '并入主路';
  if (type === 'continue' || type === 'new name' || type === 'notification') {
    return name ? `继续沿${name}前行` : '继续按路线前行';
  }
  return null;
}

function failedResult(
  input: RoutePlanInput,
  code: string,
  message: string,
): RoutePlanResult {
  const leg: RouteLeg = {
    legId: `osrm_${input.transportMode}_error`,
    fromStopId: stopIdOf(input.origin, 'origin'),
    toStopId: stopIdOf(input.destination, 'destination'),
    transportMode: input.transportMode,
    durationMinutes: 0,
    distanceMeters: 0,
    bufferMinutes: 5,
    departureSupport: 'current_only',
    evidenceId: 'fossgis_osrm',
  };
  return { departureSupport: 'current_only', leg, error: { code, message } };
}

/** Real OSM route geometry and estimates through the FOSSGIS OSRM service. */
export class FossgisOsrmRouteProvider implements RouteProvider {
  readonly providerName = 'fossgis_osrm_route';
  readonly supportedModes = ['walking', 'driving'] as const;

  private readonly fetchImpl: typeof fetch;
  private readonly walkingBaseUrl: string;
  private readonly drivingBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly cache = new RouteResultCache();

  constructor(options: OsrmOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.walkingBaseUrl = (options.walkingBaseUrl ?? 'https://routing.openstreetmap.de/routed-foot').replace(/\/$/, '');
    this.drivingBaseUrl = (options.drivingBaseUrl ?? 'https://routing.openstreetmap.de/routed-car').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async plan(input: RoutePlanInput): Promise<RoutePlanResult> {
    if (input.transportMode === 'transit') {
      return failedResult(input, 'TRANSIT_PROVIDER_UNAVAILABLE', '当前没有配置公交路线服务，请选择步行或驾车。');
    }
    const origin = coordinatesOf(input.origin);
    const destination = coordinatesOf(input.destination);
    if (!origin || !destination) {
      return failedResult(input, 'ROUTE_COORDINATES_UNKNOWN', '起点或终点缺少有效坐标，无法规划路线。');
    }
    if (!this.supportedModes.includes(input.transportMode as 'walking'|'driving')) return failedResult(input,'ROUTE_MODE_UNSUPPORTED','当前路线服务不支持这种交通方式。');
    const key=JSON.stringify([input.transportMode,origin.lng.toFixed(6),origin.lat.toFixed(6),destination.lng.toFixed(6),destination.lat.toFixed(6),input.departureAt||'']);
    return this.cache.read(key,input,()=>this.planUncached(input,origin,destination),input.transportMode==='walking'?60000:20000);
  }

  private async planUncached(input: RoutePlanInput, origin: {lat:number;lng:number}, destination: {lat:number;lng:number}): Promise<RoutePlanResult> {

    const baseUrl = input.transportMode === 'walking' ? this.walkingBaseUrl : this.drivingBaseUrl;
    const coordinates = `${Number(origin.lng.toFixed(6))},${Number(origin.lat.toFixed(6))};${Number(destination.lng.toFixed(6))},${Number(destination.lat.toFixed(6))}`;
    const radius = input.transportMode==='walking'?100:250;
    const url = `${baseUrl}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=true&radiuses=${radius};${radius}`;
    const controller = new AbortController();
    const deadline = setTimeout(()=>controller.abort(new DOMException('Route deadline exceeded','TimeoutError')),this.timeoutMs);
    try {
      const response = await abortable(withFossgisRequestSlot(() => this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      }),controller.signal),controller.signal);
      const payload = await abortable(response.json().catch(()=>null),controller.signal) as OsrmRouteResponse | null;
      if (payload?.code === 'NoRoute' || payload?.code === 'NoSegment') return failedResult(input,'OSRM_ROUTE_NOT_FOUND','没有找到可用路线，附近暂无可用的实际道路，请检查起终点或调整到现场入口。');
      if (!response.ok) {
        return failedResult(input, `FOSSGIS_HTTP_${response.status}`, `路线服务暂时不可用（HTTP ${response.status}），请稍后重试。`);
      }
      if (payload?.code !== 'Ok') return failedResult(input,'OSRM_ROUTE_ERROR','路线服务未能生成路线，请稍后重试。');
      const route = payload.routes?.[0];
      const distanceMeters = route?.distance;
      const durationSeconds = route?.duration;
      const rawCoordinates = route?.geometry?.coordinates;
      const nearbyMeters = Math.hypot((origin.lat-destination.lat)*111000,(origin.lng-destination.lng)*111000*Math.cos(origin.lat*Math.PI/180));
      const verifiedZero = distanceMeters === 0 && durationSeconds === 0 && nearbyMeters <= 50;
      if (!route || !Number.isFinite(distanceMeters) || distanceMeters! < 0 ||
          !Number.isFinite(durationSeconds) || durationSeconds! < 0 || (!verifiedZero && (distanceMeters === 0 || durationSeconds === 0)) || !rawCoordinates?.length) {
        return failedResult(input, 'OSRM_ROUTE_DATA_INCOMPLETE', '路线服务返回的数据不完整，请稍后重试。');
      }
      if (rawCoordinates.some(point=>!Array.isArray(point)||point.length<2||!Number.isFinite(point[0])||!Number.isFinite(point[1])||Math.abs(point[0])>180||Math.abs(point[1])>90)) return failedResult(input,'OSRM_ROUTE_DATA_INCOMPLETE','路线服务返回了无效坐标，请重试；不会跳过坏点拼接路线。');
      const geometry = rawCoordinates.map(([lng,lat])=>({lng,lat}));
      if (geometry.length < 2) {
        return failedResult(input, 'OSRM_ROUTE_DATA_INCOMPLETE', '路线服务没有返回有效的路线坐标，请稍后重试。');
      }
      if (distanceBetween(origin,geometry[0])>radius+10||distanceBetween(destination,geometry[geometry.length-1])>radius+10||payload.waypoints?.some(point=>!Number.isFinite(point.distance)||point.distance!<0||point.distance!>radius+10)) return failedResult(input,'ROUTE_ENDPOINT_OFF_ROAD','起点或终点离可用道路过远，请调整到现场入口；不会返回偏离地点的路线。');
      const instructions = (route.legs ?? [])
        .flatMap((leg) => leg.steps ?? [])
        .map(instructionFor)
        .filter((instruction): instruction is string => Boolean(instruction));
      const meters = Math.round(distanceMeters!);
      const leg: RouteLeg = {
        legId: `osrm_${input.transportMode}_${meters}_${Math.round(durationSeconds!)}`,
        fromStopId: stopIdOf(input.origin, 'origin'),
        toStopId: stopIdOf(input.destination, 'destination'),
        transportMode: input.transportMode,
        durationSeconds: durationSeconds!,
        durationMinutes: Math.ceil(durationSeconds! / 60),
        walkingMinutes: input.transportMode === 'walking' ? durationSeconds! / 60 : undefined,
        walkingMeters: input.transportMode === 'walking' ? meters : undefined,
        distanceMeters: meters,
        bufferMinutes: 5,
        departureSupport: 'current_only',
        evidenceId: 'fossgis_osrm',
        geometry,
        geometryCrs: 'WGS84',
        instructions,
      };
      return { departureSupport: 'current_only', leg };
    } catch (error) {
      const name = (error as Error)?.name;
      return failedResult(
        input,
        name === 'TimeoutError' ? 'FOSSGIS_TIMEOUT' : 'FOSSGIS_NETWORK_ERROR',
        name === 'TimeoutError' ? '路线服务响应超时，请稍后重试。' : '无法连接路线服务，请检查网络后重试。',
      );
    } finally { clearTimeout(deadline); }
  }
}
