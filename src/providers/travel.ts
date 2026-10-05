import type { PlaceRef, RouteLeg, TransportMode } from '../domain/types.js';
import { DEMO_SHANGHAI_PLACES, type DemoPlace } from '../demo/demo-data.js';

export interface PlaceSearchInput {
  /** Current actor for private user-added tags; consumed by the community catalog wrapper only. */
  actorId?: string;
  tag?: string;
  cityCode: string;
  districtAdcode?: string;
  query?: string;
  category?: string;
  center?: { lat: number; lng: number };
  radiusMeters?: number;
  limit?: number;
  /** Zero-based offset in the filtered catalog. */
  offset?: number;
  dataMode?: 'online' | 'demo';
}

export interface PlaceSearchResult {
  places: DemoPlace[];
  /** true 表示供应商正常返回但没有符合条件的地点，和 error 分开。 */
  empty: boolean;
  /** Zero-based offset for the next page, or null when the catalog is exhausted. */
  nextCursor?: number | null;
  error?: { code: string; message: string };
}

export interface PlaceProvider {
  readonly providerName: string;
  search(input: PlaceSearchInput): Promise<PlaceSearchResult>;
  detail(placeId: string, dataMode?: 'online' | 'demo'): Promise<DemoPlace | null>;
}

/** A provider outage is different from a successful lookup that found no place. */
export class PlaceProviderUnavailableError extends Error {
  constructor(readonly providerCode: string, message = '地点服务暂时不可用，请稍后重试。') {
    super(message);
    this.name = 'PlaceProviderUnavailableError';
  }
}

export interface RoutePlanInput {
  cityCode?: string;
  origin: PlaceRef | { lat: number; lng: number; placeId?: string };
  destination: PlaceRef | { lat: number; lng: number; placeId?: string };
  transportMode: TransportMode;
  departureAt?: string;
  dataMode?: 'online' | 'demo';
}

export interface RoutePlanResult {
  leg: RouteLeg;
  /** 供应商只支持当前出发时，不能假装是未来预测。 */
  departureSupport: 'scheduled' | 'live' | 'current_only' | 'demo';
  error?: { code: string; message: string };
}

export interface RouteProvider {
  readonly providerName: string;
  readonly supportedModes?: readonly TransportMode[];
  plan(input: RoutePlanInput): Promise<RoutePlanResult>;
}

export interface WeatherReadInput {
  cityCode: string;
  date: string;
  center?: { lat: number; lng: number };
}

export interface WeatherReadResult {
  available: boolean;
  source?: string;
  sourceUrl?: string;
  retrievedAt?: string;
  date?: string;
  timezone?: string;
  forecast?: { temperatureMinC: number; temperatureMaxC: number; precipitationProbabilityMax: number | null; precipitationMm: number | null; weatherCode: number };
  hours?: Array<{ time: string; temperatureC: number | null; precipitationProbability: number | null; precipitationMm: number | null }>;
  summary?: string;
  observedAt?: string;
  error?: { code: string; message: string };
}

export interface WeatherProvider {
  readonly providerName: string;
  read(input: WeatherReadInput): Promise<WeatherReadResult>;
}

export interface ClockProvider {
  now(dataMode: 'online' | 'demo'): string;
}

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const radius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

/** 自建上海样例目录；未接真实供应商时明确返回 demo。 */
export class DemoPlaceProvider implements PlaceProvider {
  readonly providerName = 'demo_place_catalog';

  async search(input: PlaceSearchInput): Promise<PlaceSearchResult> {
    const limit = Math.min(Math.max(input.limit ?? 12, 1), 50);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    let places = DEMO_SHANGHAI_PLACES.filter((place) => {
      // 空字符串＝全部城市；未显式标注城市的旧条目归入当前上海目录。
      if (input.cityCode && (place.cityCode ?? '310100') !== input.cityCode) return false;
      if (input.districtAdcode && place.districtAdcode !== input.districtAdcode) return false;
      if (input.category && place.category !== input.category) return false;
      if (input.query) {
        const text = `${place.name} ${place.category} ${place.facilityCodes.join(' ')}`.toLowerCase();
        if (!text.includes(input.query.toLowerCase())) return false;
      }
      return true;
    });
    if (input.center) {
      places = places
        .map((place) => ({
          place,
          distance: place.coordinates
            ? haversineMeters(input.center!, place.coordinates)
            : Number.POSITIVE_INFINITY,
        }))
        .filter((item) => item.distance <= (input.radiusMeters ?? Number.POSITIVE_INFINITY))
        .sort((a, b) => a.distance - b.distance)
        .map((item) => item.place);
    }
    const result = places.slice(offset, offset + limit);
    const nextOffset = offset + result.length;
    return { places: result, empty: result.length === 0, nextCursor: nextOffset < places.length ? nextOffset : null };
  }

  async detail(placeId: string): Promise<DemoPlace | null> {
    return DEMO_SHANGHAI_PLACES.find((place) => place.placeId === placeId) ?? null;
  }
}

/** 仅用于离线样例；不是高德或任何在线路线服务。 */
export class DemoRouteProvider implements RouteProvider {
  readonly providerName = 'demo_route_estimator';
  readonly supportedModes = ['walking', 'transit', 'driving'] as const;

  async plan(input: RoutePlanInput): Promise<RoutePlanResult> {
    const origin = input.origin;
    const destination = input.destination;
    const originCoordinates = 'coordinates' in origin ? origin.coordinates : origin;
    const destinationCoordinates = 'coordinates' in destination ? destination.coordinates : destination;
    if (!originCoordinates || !destinationCoordinates) {
      return {
        departureSupport: 'demo',
        leg: {
          legId: `route_${Math.random().toString(36).slice(2, 8)}`,
          fromStopId: 'origin',
          toStopId: 'destination',
          transportMode: input.transportMode,
          durationMinutes: 0,
          distanceMeters: 0,
          bufferMinutes: 5,
        },
        error: { code: 'ROUTE_COORDINATES_UNKNOWN', message: '缺少坐标，不能计算路线。' },
      };
    }
    const meters = haversineMeters(originCoordinates, destinationCoordinates);
    const speeds: Record<TransportMode, number> = {
      walking: 80,
      transit: 260,
      driving: 420,
    };
    const durationMinutes = Math.max(1, Math.ceil(meters / speeds[input.transportMode]));
    return {
      departureSupport: 'demo',
      leg: {
        legId: `route_${input.transportMode}_${Math.round(meters)}`,
        fromStopId: ('placeId' in origin && origin.placeId) || 'origin',
        toStopId: ('placeId' in destination && destination.placeId) || 'destination',
        transportMode: input.transportMode,
        durationMinutes,
        walkingMinutes: input.transportMode === 'walking' ? durationMinutes : undefined,
        walkingMeters: input.transportMode === 'walking' ? Math.round(meters) : undefined,
        distanceMeters: Math.round(meters),
        bufferMinutes: 5,
        departureSupport: 'demo',
      },
    };
  }
}

export class DisabledWeatherProvider implements WeatherProvider {
  readonly providerName = 'weather_disabled';

  async read(_input: WeatherReadInput): Promise<WeatherReadResult> {
    return {
      available: false,
      error: { code: 'WEATHER_PROVIDER_DISABLED', message: '天气供应商未配置；用户报告仍可触发事件。' },
    };
  }
}

export class SystemClockProvider implements ClockProvider {
  now(_dataMode: 'online' | 'demo'): string {
    return new Date().toISOString();
  }
}

export class DemoClockProvider implements ClockProvider {
  constructor(private current: string) {}

  now(_dataMode: 'online' | 'demo'): string {
    return this.current;
  }

  advanceTo(value: string): void {
    this.current = value;
  }

  advanceMinutes(minutes: number): void {
    const parsed = Date.parse(this.current);
    if (Number.isNaN(parsed)) return;
    const offsetMatch = /([+-])(\d{2}):(\d{2})$/.exec(this.current);
    if (!offsetMatch) {
      this.current = new Date(parsed + minutes * 60 * 1000).toISOString();
      return;
    }
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    const offsetMinutes =
      sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
    const shifted = new Date(parsed + minutes * 60 * 1000 + offsetMinutes * 60 * 1000);
    const [date, time] = shifted.toISOString().split('T');
    this.current = `${date}T${time.split('.')[0]}${offsetMatch[0]}`;
  }
}
