import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CITIES, cityNameOf, cityMapConfig } from '../src/domain/cities.js';

test('前端镜像城市表与后端单一来源一致', () => {
  const frontend = readFileSync(new URL('../../public/lib/cities.js', import.meta.url), 'utf8');
  for (const city of CITIES) {
    assert.ok(frontend.includes(`'${city.code}'`), `前端城市表缺少 ${city.code}`);
    assert.ok(frontend.includes(`name: '${city.name}'`), `前端城市表缺少 ${city.name}`);
  }
  const codes = [...frontend.matchAll(/code: '(\d{6})'/g)].map(match => match[1]);
  assert.deepEqual(new Set(codes), new Set(CITIES.map(city => city.code)), '两侧城市集合一致');
  assert.ok(frontend.includes("310104: '上海'"), '区码归并映射保留');
});

test('cityNameOf: 市码与区码都归并到城市短名', () => {
  assert.equal(cityNameOf('310100'), '上海');
  assert.equal(cityNameOf('330100'), '杭州');
  assert.equal(cityNameOf('310104'), '上海', '区码归并到所属城市');
  assert.equal(cityNameOf('999999'), '', '未知代码返回空');
  assert.equal(cityNameOf(undefined), '');
});

test('cityMapConfig: 徐汇保留平台手工目录，其他城市按全市走在线目录', () => {
  assert.deepEqual(cityMapConfig('310100'), {
    cityCode: '310100', cityName: '上海市', districtAdcode: '310104', districtName: '徐汇区',
  });
  assert.deepEqual(cityMapConfig('330100'), {
    cityCode: '330100', cityName: '杭州市', districtAdcode: '330100', districtName: '全市',
  });
  assert.equal(cityMapConfig('440300').districtAdcode, '440300', '深圳全市');
  assert.equal(cityMapConfig(undefined).cityCode, '310100', '缺省回退上海徐汇');
  assert.equal(cityMapConfig('999999').cityCode, '310100', '未知城市回退上海徐汇');
});
