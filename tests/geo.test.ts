import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const gcoord = createRequire(import.meta.url)('gcoord') as typeof import('gcoord')['default'];

const { AmapGeoService, DisabledGeoService } = await import(pathToFileURL(join(process.cwd(), 'src', 'providers', 'geo.ts')).href) as {
  AmapGeoService: new (apiKey: string) => { reverse(lat: number, lng: number): Promise<string | null> };
  DisabledGeoService: new () => { reverse(lat: number, lng: number): Promise<string | null> };
};

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

const amapResponse = {
  status: '1',
  regeocode: {
    formattedAddress: '浙江省杭州市西湖区文三路 100 号',
    addressComponent: { province: '浙江省', city: '杭州市', district: '西湖区' },
  },
};

test('reverse geocode composes city + district from amap regeo', async () => {
  const original = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (url: unknown) => {
    requested = String(url);
    return jsonResponse(amapResponse);
  }) as unknown as typeof fetch;
  try {
    const geo = new AmapGeoService('test-key');
    assert.equal(await geo.reverse(30.259, 120.13), '杭州市西湖区');
    const expected = gcoord.transform([120.13, 30.259], gcoord.WGS84, gcoord.GCJ02);
    const location = new URL(requested).searchParams.get('location');
    assert.ok(location, '高德请求包含 location 坐标');
    assert.deepEqual(location!.split(',').map(Number), [expected[0], expected[1]], '先将 GPS 的 WGS-84 转为高德 GCJ-02，并按经度、纬度发送');
    assert.ok(requested.includes('key=test-key'));
  } finally { globalThis.fetch = original; }
});

test('reverse geocode returns null on failures and falls back to formatted address', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ status: '0' })) as unknown as typeof fetch;
  try {
    const geo = new AmapGeoService('k');
    assert.equal(await geo.reverse(30, 120), null, '高德返回失败状态时为 null');
  } finally { globalThis.fetch = original; }

  globalThis.fetch = (async () => jsonResponse({ status: '1', regeocode: { formattedAddress: '某地某路', addressComponent: { city: [] } } })) as unknown as typeof fetch;
  try {
    const geo = new AmapGeoService('k');
    assert.equal(await geo.reverse(30, 120), '某地某路', '缺少区县时回退完整地址');
  } finally { globalThis.fetch = original; }

  globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  try {
    const geo = new AmapGeoService('k');
    assert.equal(await geo.reverse(30, 120), null, '网络失败返回 null 而不是抛错');
  } finally { globalThis.fetch = original; }
});

test('disabled geo service never resolves a label', async () => {
  const geo = new DisabledGeoService();
  assert.equal(await geo.reverse(30, 120), null);
});

test('reverse geocode rejects nonfinite and out of range coordinates before sending a request',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;return jsonResponse(amapResponse);}) as typeof fetch;
  try { const geo=new AmapGeoService('fixture');for(const [lat,lng] of [[91,121],[31,181],[Number.NaN,121],[31,Number.POSITIVE_INFINITY]]) assert.equal(await geo.reverse(lat,lng),null);assert.equal(calls,0); }
  finally { globalThis.fetch=original; }
});
