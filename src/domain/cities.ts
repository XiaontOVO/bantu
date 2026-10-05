/**
 * 平台支持的城市目录（后端单一来源）。
 * 前端镜像：public/lib/cities.js —— 两侧一致性由 tests/cities.test.ts 保证。
 * 新增城市：在 CITIES 里加一项（GB/T 2260 市级代码）；地图目录配置见 cityMapConfig。
 */
export interface CityOption {
  code: string;
  name: string;
}

export const CITIES: readonly CityOption[] = Object.freeze([
  { code: '310100', name: '上海' },
  { code: '330100', name: '杭州' },
  { code: '110100', name: '北京' },
  { code: '440100', name: '广州' },
  { code: '440300', name: '深圳' },
]);

/** 区县代码 → 所属城市（方案分享/归档数据里会出现区码）。 */
const DISTRICT_CITY: Readonly<Record<string, string>> = Object.freeze({ '310104': '上海' });

const NAME_BY_CODE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(CITIES.map(city => [city.code, city.name])),
);

export function cityNameOf(code: string | undefined | null): string {
  if (!code) return '';
  return NAME_BY_CODE[code] || DISTRICT_CITY[code] || '';
}

export interface CityMapConfig {
  cityCode: string;
  cityName: string;
  districtAdcode: string;
  districtName: string;
}

/**
 * 地图目录的按城市配置。徐汇区保留平台手工维护的固定目录（区县级），
 * 其余城市按全市走在线目录（需配置高德 Key；离线模式下目录为空）。
 * 未知/缺省城市回退上海徐汇。
 */
export function cityMapConfig(cityCode?: string | null): CityMapConfig {
  const code = cityCode && NAME_BY_CODE[cityCode] ? cityCode : '310100';
  if (code === '310100') {
    return { cityCode: '310100', cityName: '上海市', districtAdcode: '310104', districtName: '徐汇区' };
  }
  return { cityCode: code, cityName: `${NAME_BY_CODE[code]}市`, districtAdcode: code, districtName: '全市' };
}
