import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// 前端编解码器是运行时模块（public/ 不参与 tsc 编译），这里用运行时路径动态导入。
const { encodePlanCode, decodePlanCode, createImportedStopIdFactory } = await import(pathToFileURL(join(process.cwd(), 'public', 'lib', 'plan-code.js')).href) as {
  encodePlanCode: (plan: unknown) => string;
  decodePlanCode: (code: string) => any;
  createImportedStopIdFactory: () => (index: number, dayIndex?: number) => { stopId: string; placeId: string };
};

const sample = {
  name: '杭州轻松一日',
  cityCode: '330100',
  cityName: '杭州',
  localDate: '2026-10-01',
  totalFeeMinor: 15000,
  stops: [
    { placeId: 'catalog_xihu_baidi', name: '西湖白堤', coordinates: { lat: 30.262, lng: 120.148 }, durationMinutes: 90 },
    { name: '河坊街茶点', coordinates: { lat: 30.2435, lng: 120.1665 }, durationMinutes: 45 },
  ],
};

test('plan code round-trips through encode and decode', () => {
  const code = encodePlanCode(sample);
  assert.ok(code.startsWith('BT1-'), '方案码以 BT1- 开头');
  assert.ok(code.includes('-'), '分段便于人工抄写');
  const decoded = decodePlanCode(code);
  assert.equal(decoded.name, '杭州轻松一日');
  assert.equal(decoded.cityCode, '330100');
  assert.equal(decoded.localDate, '2026-10-01');
  assert.equal(decoded.totalFeeMinor, 15000);
  assert.equal(decoded.stops.length, 2);
  assert.equal(decoded.stops[0].name, '西湖白堤');
  assert.equal(decoded.stops[0].placeId, 'catalog_xihu_baidi', 'scheme shares preserve the unique directory reference');
  assert.equal(decoded.stops[1].coordinates.lat, 30.2435);
  // 去掉分隔符直接粘贴也能解码
  assert.equal(decodePlanCode(code.replace(/-/g, '')).name, decoded.name);
});

test('plan code rejects tampered or malformed codes with clear errors', () => {
  const code = encodePlanCode(sample);
  const tampered = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0');
  assert.throws(() => decodePlanCode(tampered), /校验失败/, '篡改内容被校验位拦下');
  assert.throws(() => decodePlanCode('XYZ-abc'), /BT1/);
  assert.throws(() => decodePlanCode('BT1-only-checksum'), /不完整|校验/);
  assert.throws(() => encodePlanCode({ ...sample, stops: [] }), /还没有地点/);
});

test('plan code survives unicode names', () => {
  const unicode = { ...sample, name: '月饼 🥮 与咖啡 · 特殊字符<>&"' };
  const decoded = decodePlanCode(encodePlanCode(unicode));
  assert.equal(decoded.name, unicode.name);
});

test('plan code preserves AMap GCJ-02 coordinates across export and import', () => {
  const plan = {
    ...sample,
    stops: [{ name: '武康大楼', coordinates: { lat: 31.20443, lng: 121.438278, source: 'amap' }, durationMinutes: 60 }],
  };
  const decoded = decodePlanCode(encodePlanCode(plan));
  assert.equal(decoded.stops[0].coordinates.source, 'amap');
});

test('plan code supports multi-day schemes with days payload', () => {
  const code = encodePlanCode({
    name: '两日慢游', cityCode: '330100', cityLabel: '杭州',
    days: [
      { stops: [{ name: '湖边休息点', coordinates: { lat: 30.2625, lng: 120.155 }, durationMinutes: 30 }] },
      { stops: [{ name: '城市博物馆', coordinates: { lat: 30.259, lng: 120.1415 }, durationMinutes: 80 }] },
    ],
  });
  const decoded = decodePlanCode(code);
  assert.equal(decoded.name, '两日慢游');
  assert.equal(decoded.days.length, 2);
  assert.equal(decoded.days[0].stops[0].name, '湖边休息点');
  assert.equal(decoded.days[1].stops[0].name, '城市博物馆');
  // 多天码不应被误读成单天。
  assert.equal(decoded.stops, undefined);
  // 篡改多天码同样会被校验位拦下。
  const tampered = code.slice(0, -2) + (code.slice(-2) === '00' ? '01' : '00');
  assert.throws(() => decodePlanCode(tampered), /校验失败/);
});

test('multi-day plan codes preserve empty days between scheduled days', () => {
  const code = encodePlanCode({
    name: '三日慢游', cityCode: '330100', cityLabel: '杭州',
    localDate: '2026-10-03',
    days: [
      { stops: [{ name: '湖边', coordinates: { lat: 30.2625, lng: 120.155 }, durationMinutes: 30 }] },
      { stops: [] },
      { stops: [{ name: '博物馆', coordinates: { lat: 30.259, lng: 120.1415 }, durationMinutes: 80 }] },
    ],
  });
  const decoded = decodePlanCode(code);
  assert.equal(decoded.days.length, 3);
  assert.deepEqual(decoded.days.map((day: any) => day.stops.length), [1, 0, 1]);
  assert.equal(decoded.localDate, '2026-10-03', '带出行日期的多日方案分享后保留日期');
});

test('plan codes reject coordinates outside geographic bounds', () => {
  const code = encodePlanCode({
    ...sample,
    stops: [{ name: '越界地点', coordinates: { lat: 999, lng: 120 }, durationMinutes: 60 }],
  });
  assert.throws(() => decodePlanCode(code), /地点信息不完整/);
});

test('each imported plan gets unique stop and place IDs across repeated imports and days', () => {
  const firstImport = createImportedStopIdFactory();
  const secondImport = createImportedStopIdFactory();
  const firstDayOne = firstImport(0, 0);
  const firstDayTwo = firstImport(0, 1);
  const secondDayOne = secondImport(0, 0);
  const singleDayImport = firstImport(0);

  assert.notEqual(firstDayOne.stopId, firstDayTwo.stopId);
  assert.notEqual(firstDayOne.stopId, secondDayOne.stopId);
  assert.notEqual(firstDayOne.placeId, secondDayOne.placeId);
  assert.notEqual(firstDayOne.stopId, singleDayImport.stopId);
});
