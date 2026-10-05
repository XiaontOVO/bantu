/**
 * 平台支持的城市目录（前端镜像，与后端 src/domain/cities.ts 保持一致，
 * 一致性由 tests/cities.test.ts 保证）。新增城市在此加一项即可。
 */
export const CITIES = Object.freeze([
  { code: '310100', name: '上海' },
  { code: '330100', name: '杭州' },
  { code: '110100', name: '北京' },
  { code: '440100', name: '广州' },
  { code: '440300', name: '深圳' },
]);

/** 区县代码 → 所属城市（方案分享数据里会出现区码）。 */
export const CITY_NAME = Object.freeze({
  ...Object.fromEntries(CITIES.map(city => [city.code, city.name])),
  310104: '上海',
});

export function cityNameOf(code) {
  return CITY_NAME[code || ''] || '';
}
