import { PlaceProviderUnavailableError, type RoutePlanInput, type RoutePlanResult, type PlaceProvider, type PlaceSearchInput, type PlaceSearchResult, type RouteProvider } from './travel.js';
import { DEMO_SHANGHAI_PLACES, type DemoPlace } from '../demo/demo-data.js';
import { cityNameOf } from '../domain/cities.js';
import { createRequire } from 'node:module';
import { RouteResultCache } from './route-cache.js';
const gcoord = createRequire(import.meta.url)('gcoord') as typeof import('gcoord')['default'];

export interface AmapProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  dataMode?: 'online' | 'demo';
  /** 单次请求超时；挂死的供应商不能无限占用任务租约。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 平台内部把直辖市记作「市辖区」adcode（上海 310100、北京 110100），但高德 place 检索
 * 不认这两个码——会当作无效城市静默回退到全国，导致搜「公园」返回北京结果。
 * 调用高德前把直辖市级码换成高德认的市级 adcode；区县码（310104）与地级市码（330100 等）本就有效，原样透传。
 */
const AMAP_MUNICIPAL_CITY: Readonly<Record<string, string>> = Object.freeze({ '310100': '310000', '110100': '110000' });
function amapCityAdcode(code: string): string {
  return AMAP_MUNICIPAL_CITY[code] || code;
}

/**
 * 高德 POI 的 adcode 是区县级（徐汇 310104），平台 cityCode 用市级（上海 310100）。
 * detail() 只有 POI ID、没有请求级城市上下文，必须从 adcode 反推市级码，
 * 否则地点 cityCode 为空，公共交通规划会因「缺少起终点城市」直接失败。
 */
function cityAdcodeFromDistrict(adcode: string | undefined): string {
  return adcode && /^\d{6}$/.test(adcode) ? `${adcode.slice(0, 4)}00` : '';
}

interface AmapPoi {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  address?: string;
  citycode?: string;
  adcode?: string;
  biz_ext?: { cost?: string };
  tel?: string;
  indoor_data?: { indoor_map?: string; cpid?: string };
  photos?: Array<{ url?: string }>;
}

interface AmapPlaceResponse {
  status?: string;
  info?: string;
  infocode?: string;
  count?: string;
  pois?: AmapPoi[];
}

interface AmapRoutePath {
  distance?: string;
  duration?: string;
  walking_distance?: string;
  steps?: Array<{ duration?: string; distance?: string; instruction?: string; polyline?: string }>;
}

interface AmapTransitSegment {
  instruction?: string;
  steps?: AmapRoutePath['steps'];
  walking?: { steps?: AmapRoutePath['steps']; distance?: string };
  bus?: { buslines?: Array<{ name?: string; polyline?: string; distance?: string }> };
  railway?: { name?: string; polyline?: string; distance?: string } | [];
  taxi?: { polyline?: string; distance?: string } | [];
}

interface AmapRouteResponse {
  status?: string;
  info?: string;
  infocode?: string;
  route?: {
    paths?: AmapRoutePath[];
    transits?: Array<{
      duration?: string;
      walking_distance?: string;
      distance?: string;
      cost?: { duration?: string; transit_fee?: string };
      segments?: AmapTransitSegment[];
    }>;
  };
}

function parseLocation(value: string | undefined): { lat: number; lng: number } | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2 || parts.some(part => !part.trim())) return null;
  const [lngText, latText] = parts;
  const lng = Number(lngText);
  const lat = Number(latText);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function geometryForPolyline(polyline: string | undefined) {
  if (typeof polyline !== 'string' || !polyline.trim()) return [];
  const points = polyline.split(';').map(parseLocation);
  // Dropping a corrupt intermediate point invents a straight connector across it.
  return points.some(point => point === null) ? [] : points as { lat: number; lng: number }[];
}

function pointDistance(a: {lat:number;lng:number}, b: {lat:number;lng:number}) {
  const radians = (value:number) => value * Math.PI / 180;
  const dLat=radians(b.lat-a.lat),dLng=radians(b.lng-a.lng);
  return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(dLat/2)**2+Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(dLng/2)**2)));
}

/** Preserve complete, ordered provider segments; never join alternative bus paths. */
function continuousGeometry(parts: Array<{polyline?: string;distance?: string}>) {
  const geometry: {lat:number;lng:number}[] = [];
  for (const part of parts) {
    const points = geometryForPolyline(part.polyline);
    if (points.length < 2) {
      if (part.distance !== undefined && part.distance !== '' && Number(part.distance) === 0) continue;
      return [];
    }
    if (geometry.length && pointDistance(geometry[geometry.length-1],points[0])>40) return [];
    geometry.push(...points);
  }
  return geometry;
}

function transitGeometry(segments: AmapTransitSegment[]) {
  const parts: Array<{ polyline?: string; distance?: string }> = [];
  const populated = (value: unknown): boolean => {
    if (typeof value === 'string') return Boolean(value.trim());
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (Array.isArray(value)) return value.some(populated);
    return Boolean(value && typeof value === 'object' && Object.values(value).some(populated));
  };
  for (const segment of segments) {
    // Absent railway/taxi components may be [], {} or objects full of [] and
    // empty strings. Buslines
    // are alternatives for this segment, not consecutive rides.
    parts.push(...(segment.steps || []), ...(segment.walking?.steps || []));
    if (!segment.walking?.steps?.length && Number(segment.walking?.distance)>0) parts.push({distance:segment.walking?.distance});
    if (segment.bus?.buslines?.length) parts.push(segment.bus.buslines[0]);
    for (const component of [segment.railway, segment.taxi]) {
      if (component && !Array.isArray(component) && populated(component)) parts.push(component);
    }
  }
  return continuousGeometry(parts);
}

function amapCoordinates(value: RoutePlanInput['origin']) {
  const point = 'coordinates' in value ? value.coordinates : value;
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat)>90 || Math.abs(point.lng)>180) return null;
  if ('source' in point && point.source === 'amap') return point;
  const [lng, lat] = gcoord.transform([point.lng, point.lat], gcoord.WGS84, gcoord.GCJ02);
  return { lat, lng };
}

function mapFacilities(type: string | undefined): string[] {
  if (!type) return [];
  const result = new Set<string>();
  const text = type.toLowerCase();
  if (/餐饮|美食|restaurant|food/.test(text)) result.add('food');
  if (/博物馆|展览|museum/.test(text)) result.add('indoor');
  if (/公园|景点|风景|park|scenic/.test(text)) result.add('outdoor');
  if (/医疗|医院|hospital/.test(text)) result.add('medical');
  if (/购物|商场|shop/.test(text)) result.add('shopping');
  if (/地铁|公交|transit|bus/.test(text)) result.add('transit');
  return [...result];
}

/** 高德 POI → 目录地点；搜索与详情共用，避免两处映射漂移。 */
function mapPoi(poi: AmapPoi, fallbackCityCode: string): DemoPlace | null {
  if (!poi.id || !poi.name) return null;
  const coordinates = parseLocation(poi.location);
  const cost = poi.biz_ext?.cost;
  return {
    placeId: `amap_${poi.id}`,
    provider: 'amap',
    providerPlaceId: poi.id,
    name: poi.name,
    category: poi.type ?? 'unknown',
    // 高德的 citycode 是电话区号（0571），不能当城市码用。城市归属优先用请求限定的
    // cityCode；detail() 没有请求级城市，退而从 POI 的区县 adcode 反推市级码，
    // 保证公共交通规划拿得到起终点城市。
    cityCode: fallbackCityCode || cityAdcodeFromDistrict(poi.adcode),
    phone: typeof poi.tel === 'string' && poi.tel.trim() ? poi.tel.split(/[;；,，]/)[0].trim() || undefined : undefined,
    ...(poi.adcode ? { districtAdcode: poi.adcode } : {}),
    coordinates: coordinates ? { ...coordinates, source: 'amap' } : null,
    facilityCodes: mapFacilities(poi.type),
    evidenceIds: [`amap_poi_${poi.id}`],
    suggestedDurationMinutes: 60,
    openingIntervals: [],
    costEstimate:
      cost && Number.isFinite(Number(cost))
        ? {
            currency: 'CNY',
            basis: 'per_person',
            lowerMinor: Math.round(Number(cost) * 100),
            upperMinor: Math.round(Number(cost) * 100),
            certainty: 'bounded',
            sourceRef: `amap_poi_${poi.id}`,
          }
        : undefined,
  } satisfies DemoPlace;
}

export class AmapPlaceProvider implements PlaceProvider {
  readonly providerName = 'amap_place';

  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;

  // Cache only upstream public POI pages, before personal tags/reviews are attached.
  private readonly searchPages = new Map<string, { expiresAt: number; payload: AmapPlaceResponse }>();
  private readonly pendingPages = new Map<string, Promise<AmapPlaceResponse>>();

  private async searchPage(endpoint: string, params: URLSearchParams): Promise<AmapPlaceResponse> {
    const keyParams = new URLSearchParams(params); keyParams.delete('key');
    const key = `${endpoint}?${keyParams}`;
    const cached = this.searchPages.get(key);
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.payload);
    const pending = this.pendingPages.get(key);
    if (pending) return structuredClone(await pending);
    const request = (async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/v3/${endpoint}?${params}`, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`地点服务返回 HTTP ${response.status}，请稍后重试。`);
      const payload = await response.json() as AmapPlaceResponse;
      if (payload.status === '1') {
        for (const [oldKey, entry] of this.searchPages) if (entry.expiresAt <= Date.now()) this.searchPages.delete(oldKey);
        this.searchPages.delete(key);
        while (this.searchPages.size >= 128) this.searchPages.delete(this.searchPages.keys().next().value!);
        this.searchPages.set(key, { expiresAt: Date.now() + 30000, payload: structuredClone(payload) });
      }
      return payload;
    })();
    this.pendingPages.set(key, request);
    try { return structuredClone(await request); }
    finally { if (this.pendingPages.get(key) === request) this.pendingPages.delete(key); }
  }

  constructor(private readonly options: AmapProviderOptions) {
    this.baseUrl = options.baseUrl ?? 'https://restapi.amap.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(input: PlaceSearchInput): Promise<PlaceSearchResult> {
    if (!input.center && !input.query?.trim() && !input.category?.trim()) {
      // 徐汇的地图目录是平台维护的固定目录，而不是高德关键词搜索结果。
      // 高德 text API 不支持“列出某区全部 POI”；地图首次打开也必须能取到完整目录。
      if (input.cityCode === '310100' && input.districtAdcode === '310104') {
        const catalog = DEMO_SHANGHAI_PLACES.filter(place =>
          place.cityCode === '310100' && place.districtAdcode === '310104',
        );
        const offset = Math.max(0, Math.floor(input.offset ?? 0));
        const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 12)));
        const places = catalog.slice(offset, offset + limit);
        const nextOffset = offset + places.length;
        return {
          places,
          empty: places.length === 0,
          nextCursor: nextOffset < catalog.length ? nextOffset : null,
        };
      }
      return {
        places: [],
        empty: true,
        error: { code: 'PLACE_QUERY_REQUIRED', message: '在线地点搜索需要先输入地点名称或关键词。' },
      };
    }
    const pageSize = 25;
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 12)));
    const firstPage = Math.floor(offset / pageSize) + 1;
    const skippedOnFirstPage = offset % pageSize;
    const endpoint = input.center ? 'place/around' : 'place/text';
    const baseParams = new URLSearchParams({ key: this.options.apiKey, offset: String(pageSize), extensions: 'all' });
    if (input.query) baseParams.set('keywords', input.query);
    if (input.category) baseParams.set('types', input.category);
    // 区县码优先（更精确），否则用城市码；直辖市级码需换成高德认的 adcode。
    // citylimit=true 把结果强制限定在该城市，避免选城后仍混入外地 POI。
    const cityParam = input.districtAdcode || (input.cityCode ? amapCityAdcode(input.cityCode) : '');
    if (cityParam) {
      baseParams.set('city', cityParam);
      baseParams.set('citylimit', 'true');
    }
    if (input.radiusMeters) baseParams.set('radius', String(Math.round(input.radiusMeters)));
    // 高德的 around 接口必须有 location；只有关键词和城市时必须走 text 检索。
    if (input.center) baseParams.set('location', `${input.center.lng},${input.center.lat}`);
    try {
      const places: DemoPlace[] = [];
      let totalCount: number | null = null;
      let providerExhausted = false;
      let page = firstPage;
      let rawResultsAfterOffset = 0;
      // One extra result tells the HTTP layer whether another page exists.
      while (places.length <= limit && !providerExhausted) {
        const params = new URLSearchParams(baseParams);
        params.set('page', String(page));
        const payload = await this.searchPage(endpoint, params);
        if (payload.status !== '1') {
          return {
            places: [],
            empty: false,
            error: { code: `AMAP_${payload.infocode ?? 'ERROR'}`, message: payload.info ?? '高德地点检索失败。' },
          };
        }
        const rawPois = payload.pois ?? [];
        const parsedCount = payload.count?.trim() ? Number(payload.count) : Number.NaN;
        if (Number.isFinite(parsedCount)) totalCount = parsedCount;
        const mapped = rawPois
          .map((poi) => mapPoi(poi, input.cityCode))
          .filter((place): place is DemoPlace => Boolean(place));
        const pageOffset = page === firstPage ? skippedOnFirstPage : 0;
        places.push(...mapped.slice(pageOffset));
        rawResultsAfterOffset += Math.max(0, rawPois.length - pageOffset);
        const consumed = offset + rawResultsAfterOffset;
        providerExhausted = rawPois.length < pageSize || (totalCount !== null && consumed >= totalCount);
        page += 1;
      }
      const hasMore = places.length > limit;
      const pagePlaces = places.slice(0, limit);
      return {
        places: pagePlaces,
        empty: pagePlaces.length === 0,
        nextCursor: hasMore ? offset + pagePlaces.length : null,
      };
    } catch (error) {
      return {
        places: [],
        empty: false,
        error: {
          code: (error as Error).name === 'TimeoutError' ? 'AMAP_TIMEOUT' : 'AMAP_NETWORK_ERROR',
          message: (error as Error).message,
        },
      };
    }
  }

  /**
   * 按 POI ID 取详情。
   * 只有供应商成功响应且没有 POI 时才返回 null；网络/API 故障作为可重试错误向上抛出。
   * 这里不使用关键词检索代替 ID 查询，避免把“查不到”变成“误判为不存在”。
   */
  async detail(placeId: string, _dataMode?: 'online' | 'demo'): Promise<DemoPlace | null> {
    // 固定目录中的地点以目录资料为唯一来源；高德在线搜索结果仍按其 POI ID 查询详情。
    const catalogPlace = DEMO_SHANGHAI_PLACES.find(place => place.placeId === placeId);
    if (catalogPlace) return catalogPlace;
    const providerPlaceId = placeId.replace(/^amap_/, '');
    const params = new URLSearchParams({
      key: this.options.apiKey,
      id: providerPlaceId,
      extensions: 'all',
    });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v3/place/detail?${params}`, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) throw new PlaceProviderUnavailableError(`AMAP_HTTP_${response.status}`);
      const payload = (await response.json()) as AmapPlaceResponse;
      if (payload.status !== '1') throw new PlaceProviderUnavailableError(`AMAP_${payload.infocode ?? 'ERROR'}`);
      const poi = payload.pois?.[0];
      return poi ? mapPoi(poi, '') : null;
    } catch (error) {
      if (error instanceof PlaceProviderUnavailableError) throw error;
      throw new PlaceProviderUnavailableError((error as Error).name === 'TimeoutError' ? 'AMAP_TIMEOUT' : 'AMAP_NETWORK_ERROR');
    }
  }
}

export class AmapRouteProvider implements RouteProvider {
  readonly providerName = 'amap_route';
  readonly supportedModes = ['walking', 'transit', 'driving'] as const;

  private readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;
  private readonly cache = new RouteResultCache();

  constructor(private readonly options: AmapProviderOptions) {
    this.baseUrl = options.baseUrl ?? 'https://restapi.amap.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async plan(input: RoutePlanInput): Promise<RoutePlanResult> {
    const origin = amapCoordinates(input.origin), destination = amapCoordinates(input.destination);
    if (!origin || !destination) return this.planUncached(input);
    const key = JSON.stringify([input.transportMode,input.cityCode||'',origin.lng.toFixed(6),origin.lat.toFixed(6),destination.lng.toFixed(6),destination.lat.toFixed(6),input.departureAt||'']);
    return this.cache.read(key,input,()=>this.planUncached(input),input.transportMode==='walking'?60000:20000);
  }

  private async planUncached(input: RoutePlanInput): Promise<RoutePlanResult> {
    const origin = amapCoordinates(input.origin), destination = amapCoordinates(input.destination);
    const fromStopId = 'placeId' in input.origin && input.origin.placeId ? input.origin.placeId : 'origin';
    const toStopId =
      'placeId' in input.destination && input.destination.placeId
        ? input.destination.placeId
        : 'destination';

    if (!this.supportedModes.includes(input.transportMode)) return {
      departureSupport:'current_only',leg:{legId:'amap_mode_invalid',fromStopId,toStopId,transportMode:input.transportMode},
      error:{code:'ROUTE_MODE_UNSUPPORTED',message:'当前路线服务不支持这种交通方式。'},
    };

    if (!origin || !destination) {
      return {
        departureSupport: input.dataMode === 'demo' ? 'demo' : 'current_only',
        leg: {
          legId: `amap_${input.transportMode}_unknown`,
          fromStopId,
          toStopId,
          transportMode: input.transportMode,
          durationMinutes: 0,
          distanceMeters: 0,
          bufferMinutes: 5,
        },
        error: { code: 'AMAP_COORDINATES_UNKNOWN', message: '缺少可用坐标。' },
      };
    }

    const path = input.transportMode === 'walking' ? 'walking' : input.transportMode === 'driving' ? 'driving' : 'transit/integrated';
    const params = new URLSearchParams({
      key: this.options.apiKey,
      origin: `${origin.lng.toFixed(6)},${origin.lat.toFixed(6)}`,
      destination: `${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`,
      extensions: 'all',
    });

    if (input.transportMode === 'transit') {
      const city = input.cityCode ? (cityNameOf(input.cityCode) || input.cityCode) : '';
      if (!city) return { departureSupport: 'current_only', leg: { legId: 'amap_transit_city_unknown', fromStopId, toStopId, transportMode: input.transportMode }, error: { code: 'ROUTE_CITY_REQUIRED', message: '公共交通规划需要先确定起点和终点所在城市。' } };
      params.set('city', city);
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v3/direction/${path}?${params}`, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) return { departureSupport: 'current_only', leg: {legId:'amap_http_error',fromStopId,toStopId,transportMode:input.transportMode}, error:{code:`AMAP_HTTP_${response.status}`,message:'地图路线服务暂时不可用，请稍后重试。'} };
      const payload = (await response.json()) as AmapRouteResponse;
      if (payload.status !== '1') {
        return {
          departureSupport: 'current_only',
          leg: {
            legId: `amap_${input.transportMode}_error`,
            fromStopId,
            toStopId,
            transportMode: input.transportMode,
            durationMinutes: 0,
            distanceMeters: 0,
            bufferMinutes: 5,
          },
          error: { code: `AMAP_${/^\d{5}$/.test(payload.infocode || '') ? payload.infocode : 'ERROR'}`, message: '高德路线规划暂未成功，请稍后重试。' },
        };
      }
      const route = payload.route;
      const pathData = route?.paths?.[0];
      const transit = route?.transits?.[0];
      if (!pathData && !transit) return { departureSupport: 'current_only', leg: { legId: 'amap_empty', fromStopId, toStopId, transportMode: input.transportMode }, error: { code: 'ROUTE_NOT_FOUND', message: '没有找到可用路线，请更换交通方式。' } };
      const durationSeconds = Number(pathData?.duration ?? transit?.duration ?? 0);
      const distanceMeters = Number(pathData?.distance ?? transit?.distance ?? 0);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(distanceMeters) || distanceMeters <= 0) return { departureSupport: 'current_only', leg: { legId: 'amap_invalid', fromStopId, toStopId, transportMode: input.transportMode }, error: { code: 'ROUTE_DATA_INCOMPLETE', message: '地图返回的路线时间或距离不完整，请重试。' } };
      const pathGeometry = continuousGeometry(pathData?.steps || []);
      const geometry = input.transportMode === 'transit' ? transitGeometry(transit?.segments || []) : pathGeometry;
      if (geometry.length < 2) return { departureSupport:'current_only',leg:{legId:'amap_geometry_unavailable',fromStopId,toStopId,transportMode:input.transportMode},error:{code:'ROUTE_GEOMETRY_UNAVAILABLE',message:'地图未返回完整可用的实际路线，请重试或调整起终点；不会用直线代替。'} };
      const endpointLimit = input.transportMode === 'driving' ? 400 : 250;
      if (pointDistance(origin,geometry[0])>endpointLimit || pointDistance(destination,geometry[geometry.length-1])>endpointLimit) return {
        departureSupport:'current_only',leg:{legId:'amap_endpoints_unavailable',fromStopId,toStopId,transportMode:input.transportMode},
        error:{code:'ROUTE_ENDPOINT_OFF_ROAD',message:'返回的道路路线没有到达所选起终点，请调整到现场入口；不会将局部路线当完整路线。'},
      };
      const transitWalking = transit?.walking_distance;
      // walking_distance 也要判有限性：非数字会变成 NaN 并在步行约束里传播。
      const parsedTransitWalking =
        transitWalking !== undefined && transitWalking !== '' && Number.isFinite(Number(transitWalking)) && Number(transitWalking)>=0
          ? Number(transitWalking)
          : undefined;
      const walkingMeters =
        input.transportMode === 'walking'
          ? (Number.isFinite(distanceMeters) ? distanceMeters : undefined)
          : parsedTransitWalking;
      return {
        departureSupport: 'current_only',
        leg: {
          legId: `amap_${input.transportMode}_${Math.round(distanceMeters)}_${Math.round(durationSeconds)}`,
          fromStopId,
          toStopId,
          transportMode: input.transportMode,
          durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
          durationMinutes: Number.isFinite(durationSeconds) ? Math.ceil(durationSeconds / 60) : 0,
          walkingMinutes:
            walkingMeters !== undefined && input.transportMode === 'walking'
              ? durationSeconds / 60
              : undefined,
          walkingMeters,
          distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : 0,
          bufferMinutes: 5,
          departureSupport: 'current_only',
          evidenceId: 'amap_route',
          geometry,
          geometryCrs: 'GCJ02',
          instructions: pathData?.steps?.map(step => step.instruction).filter((text): text is string => typeof text === 'string' && Boolean(text.trim()))
            ?? (transit?.segments || []).flatMap(segment => [segment.instruction, segment.bus?.buslines?.[0]?.name, segment.railway && !Array.isArray(segment.railway) ? segment.railway.name : undefined]).filter((text): text is string => typeof text === 'string' && Boolean(text.trim())),
        },
      };
    } catch (error) {
      return {
        departureSupport: 'current_only',
        leg: {
          legId: `amap_${input.transportMode}_network_error`,
          fromStopId,
          toStopId,
          transportMode: input.transportMode,
          durationMinutes: 0,
          distanceMeters: 0,
          bufferMinutes: 5,
        },
        error: { code: (error as Error).name==='TimeoutError'?'AMAP_TIMEOUT':'AMAP_NETWORK_ERROR', message: (error as Error).name==='TimeoutError'?'地图路线响应超时，请重试。':'无法连接地图路线服务，请稍后重试。' },
      };
    }
  }
}
