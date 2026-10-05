import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const frontend = (path: string) => import(pathToFileURL(join(process.cwd(), 'public/lib', path)).href) as Promise<Record<string, any>>;
const { tourSectionHtml, buildingSheetHtml, rememberBuildingFloor } = await frontend('place-tour.js');
const { tourFor } = await frontend('place-tour-data.js');
const { overviewBuildingRecords } = await frontend('place-overview-data.js');

test('an exterior landmark retains its building entry without inventing a visitable floor', () => {
  const place = {name:'武康大楼',placeId:'exterior-guidance'};
  const overview = tourSectionHtml(place);
  assert.match(overview,/data-building="main"/);
  assert.match(overview,/外观资料/);
  assert.doesNotMatch(overview,/馆内资料|0\/1|查看内部/);
  assert.equal(tourFor(place).buildings[0].floors.length,0);
  rememberBuildingFloor(place,'main',2);
  const sheet = buildingSheetHtml(place,'main');
  assert.match(sheet,/欣赏建筑外观|没有已核实的公众室内参观平面资料/);
  assert.doesNotMatch(sheet,/floor-tabs|data-action="zoom-place-image"|馆内导览|1F|卫生间/);
});

test('outdoor pavilions and corridors are not counted as indoor floors', () => {
  for (const [name,id] of [['桂林公园','main'],['桂林公园','pavilion'],['光启公园','pavilion']]) {
    const sheet = buildingSheetHtml({name,placeId:`outdoor-${name}`},id);
    assert.match(sheet,/室外区域/);
    assert.doesNotMatch(sheet,/馆内导览|这层室内|floor-tabs|floor-plan-restroom-key/);
  }
  const park = tourSectionHtml({name:'徐家汇公园',placeId:'open-park'});
  assert.match(park,/室外场地总览/);
  assert.doesNotMatch(park,/馆内|0\/0|查看内部/);
});

test('an unverified outline never turns into a one-floor building, and a missing map cannot be zoomed', () => {
  const entries = overviewBuildingRecords({buildings:[{id:'unknown',name:'未核实建筑'},{id:'context',name:'周边参照',secondary:true}]});
  assert.equal(entries.length,1);
  assert.deepEqual(entries[0].floors,[]);
  assert.equal(entries[0].floorInventoryKnown,false);
  const place = {name:'未收录的地点',placeId:'unknown-place'};
  const html = tourSectionHtml(place);
  assert.match(html,/site-map-unavailable/);
  assert.doesNotMatch(html,/data-action="zoom-place-overview"|查看内部|馆内资料/);
  assert.match(buildingSheetHtml(place,'unknown'),/楼层数量与布局尚未核实/);
});

test('real floor coverage excludes functional diagrams and floor choice has accessible state', () => {
  const place = {name:'徐家汇书院',placeId:'real-floor-guidance'};
  assert.match(tourSectionHtml(place),/楼层图 3\/4 · 已收录资料/);
  rememberBuildingFloor(place,'main',1);
  const sheet = buildingSheetHtml(place,'main');
  assert.match(sheet,/aria-label="选择楼层"/);
  assert.equal((sheet.match(/aria-pressed="true"/g)||[]).length,1);
  assert.match(sheet,/aria-pressed="true"[^>]+data-floor="1"/);
  assert.match(sheet,/xujiahui-library-1f\.svg|floor-plan-restroom-key/);
  rememberBuildingFloor(place,'main',0);
  const b1 = buildingSheetHtml(place,'main');
  assert.match(b1,/功能示意/);
  assert.doesNotMatch(b1,/floor-plan-restroom-key/);
});
