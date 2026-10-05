import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { coordinatePlaceId } from '../src/domain/place-id.js';

const { placeIdLabel, placeIdDescription, placeIdHtml } = await import(pathToFileURL(join(process.cwd(), 'public/lib/format.js')).href);

test('公开地点编号使用已有坐标 ID，不使用收录号或修正后的坐标重算', () => {
  const place = { placeId: '12143603120601', placeNo: 1, coordinates: { lng: 121.4352, lat: 31.2068 } };
  assert.equal(placeIdLabel(place), '12143603120601');
  assert.equal(placeIdDescription(place), '经度网格 121.436° · 纬度网格 31.206° · 网格内序列号 01');
  const html = placeIdHtml(place);
  assert.match(html, />12143603120601<\/span>/);
  assert.match(html, /aria-label="地点编号 12143603120601/);
  assert.ok(!html.includes('No.0001'));
  for (const invalid of [undefined, {}, { placeNo: 1 }, { placeId: 'internal-uuid', placeNo: 1 }, { placeId: '<img src=x>' }, { placeId: 12143603120601 }]) {
    assert.equal(placeIdLabel(invalid), '');
    assert.equal(placeIdDescription(invalid), '');
    assert.equal(placeIdHtml(invalid), '');
  }
});

test('编号说明兼容旧 10 位编码和负坐标，保留同网格序列号及前导零', () => {
  assert.equal(placeIdLabel({ placeId: '1214031201' }), '1214031201');
  assert.equal(placeIdDescription({ placeId: '1214031201' }), '经度网格 121.4° · 纬度网格 31.2° · 网格内序列号 01');
  const negative = coordinatePlaceId(-73.985, -33.869, 9);
  assert.equal(placeIdDescription({ placeId: negative }), '经度网格 -73.985° · 纬度网格 -33.869° · 网格内序列号 09');
  const first = coordinatePlaceId(0.001, 0.002, 0);
  const second = coordinatePlaceId(0.001, 0.002, 99);
  assert.equal(placeIdLabel({ placeId: first }), '00000100000200');
  assert.equal(placeIdLabel({ placeId: second }), '00000100000299');
});
