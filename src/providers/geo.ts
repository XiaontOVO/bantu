import { createRequire } from 'node:module';

const gcoord = createRequire(import.meta.url)('gcoord') as typeof import('gcoord')['default'];

/**
 * 逆地理编码：把定位坐标解析成适合胶囊展示的短地名（城市+区县）。
 *
 * 当前实现使用高德 regeo；未配置 Key 或调用失败时返回 null——
 * 顶栏按"定位不可得就不显示地点"处理，绝不拿旅行城市冒充当前位置。
 */

export interface GeoService {
  providerName: string;
  reverse(lat: number, lng: number): Promise<string | null>;
}

export class DisabledGeoService implements GeoService {
  providerName = 'disabled';
  async reverse(): Promise<string | null> { return null; }
}

export class AmapGeoService implements GeoService {
  providerName = 'amap';
  // 不用参数属性语法：测试会以 strip-only 模式直接运行本 TS 源文件。
  private readonly apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }
  async reverse(lat: number, lng: number): Promise<string | null> {
    if (!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) return null;
    try {
      // Browser geolocation is WGS84; AMap reverse geocoding expects GCJ02.
      const [amapLng, amapLat] = gcoord.transform([lng, lat], gcoord.WGS84, gcoord.GCJ02);
      const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(this.apiKey)}&location=${amapLng},${amapLat}&extensions=base`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return null;
      const body = await response.json() as {
        status?: string;
        regeocode?: { formattedAddress?: string; addressComponent?: { province?: string | string[]; city?: string | string[]; district?: string | string[] } };
      };
      if (body.status !== '1' || !body.regeocode) return null;
      const part = (value: unknown) => (Array.isArray(value) ? value[0] : value) as string | undefined;
      const component = body.regeocode.addressComponent ?? {};
      const city = part(component.city) || part(component.province) || '';
      const district = part(component.district) || '';
      const label = `${city}${district}`.trim() || body.regeocode.formattedAddress || '';
      return label || null;
    } catch {
      return null;
    }
  }
}
