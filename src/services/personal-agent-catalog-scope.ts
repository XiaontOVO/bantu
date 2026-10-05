import { CITIES } from '../domain/cities.js';

const SHANGHAI_DISTRICTS: Readonly<Record<string, string>> = {
  黄浦: '310101', 徐汇: '310104', 长宁: '310105', 静安: '310106', 普陀: '310107',
  虹口: '310109', 杨浦: '310110', 闵行: '310112', 宝山: '310113', 嘉定: '310114',
  浦东: '310115', 金山: '310116', 松江: '310117', 青浦: '310118', 奉贤: '310120', 崇明: '310151',
};

/** Use the user's named city/district rather than silently forcing every task into Xuhui. */
export function agentCatalogScope(text: string): { cityCode: string; districtAdcode?: string; explicitCity: boolean } {
  const namedCity = CITIES.find(city => text.includes(city.name));
  const district = Object.entries(SHANGHAI_DISTRICTS).find(([name]) => text.includes(name));
  if (namedCity && namedCity.code !== '310100') return { cityCode: namedCity.code, explicitCity: true };
  if (district) return { cityCode: '310100', districtAdcode: district[1], explicitCity: true };
  if (namedCity) return { cityCode: '310100', explicitCity: true };
  return { cityCode: '310100', districtAdcode: '310104', explicitCity: false };
}

export function supportedAgentCityCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return CITIES.find(city => city.code === value || city.name === value || `${city.name}市` === value)?.code || null;
}
