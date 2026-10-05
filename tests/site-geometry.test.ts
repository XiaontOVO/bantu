import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (path: string) => import(pathToFileURL(join(process.cwd(), path)).href);
const { projectionFor, containsPoint } = await load('scripts/lib/site-geometry.mjs');

test('室外轮廓保留北向和等比距离，多边形庭院不属于建筑可点击区域', () => {
  const center = { lng: 121.4, lat: 31.2 };
  const cosine = Math.cos(center.lat * Math.PI / 180);
  const { project, metersPerPixel } = projectionFor(center, [[121.398,31.198],[121.402,31.202]]);
  const origin = project([center.lng, center.lat]);
  const east = project([center.lng + 20 / (111320*cosine),center.lat]);
  const north = project([center.lng,center.lat + 20/111320]);
  assert.ok(east[0] > origin[0]);assert.ok(north[1] < origin[1]);
  assert.ok(Math.abs((east[0]-origin[0])-(origin[1]-north[1])) < 1e-7, '东西和南北使用同一距离比例');
  assert.ok(Math.abs((east[0]-origin[0])*metersPerPixel-20) < 1e-7);
  const rings = [[[0,0],[10,0],[10,10],[0,10],[0,0]],[[3,3],[7,3],[7,7],[3,7],[3,3]]];
  assert.equal(containsPoint(rings,[1,1]),true);
  assert.equal(containsPoint(rings,[5,5]),false);
  assert.equal(containsPoint(rings,[12,5]),false);
});

test('全部室外图有真实轮廓依据，原楼层入口保留且不为缺漏位置生成建筑', async () => {
  const { SITE_MAP_NAMES, overviewFor } = await load('public/lib/place-overview-data.js');
  const { tourFor } = await load('public/lib/place-tour-data.js');
  const { tourSectionHtml } = await load('public/lib/place-tour.js');
  const references = JSON.parse(readFileSync(join(process.cwd(),'scripts/references/site-overviews.json'),'utf8'));
  assert.equal(Object.keys(references.records).length,SITE_MAP_NAMES.length);
  for(const name of SITE_MAP_NAMES){
    const map=overviewFor({name}),html=tourSectionHtml({name,placeId:'stable-place-reference'});
    assert.equal(map.geographic,true,name);
    assert.equal(map.extent,null,'不补造矩形园区边界');
    assert.deepEqual(map.trees,[],'无单株资料时不补造树的位置');
    assert.match(map.evidence.referenceDate,/^\d{4}-\d{2}-\d{2}$/);
    assert.match(html,/OpenStreetMap contributors/);assert.doesNotMatch(html,/<(?:img|a)[^>]+(?:src|href)="https?:/);
    assert.match(html,/site-map-scale/);
    const ids=new Set(references.records[name].features.map((f:any)=>f.id));
    for(const building of map.buildings)assert.ok(ids.has(building.sourceId),`${name}: 每个建筑轮廓可追溯`);
    for(const building of tourFor({name}).buildings)assert.ok(html.includes(`data-building="${building.id}"`),`${name}: ${building.id} 原楼层入口丢失`);
    for(const missing of map.unlocatedBuildings)assert.ok(!map.buildings.some((b:any)=>b.id===missing.id),`${name}: 未知位置不应绘制猜测轮廓`);
    for(const facility of map.facilities)assert.ok(references.records[name].facilities.some((f:any)=>f.id===facility.id),`${name}: 设施有明确位置记录`);
  }
  const museum=overviewFor({name:'龙美术馆（西岸馆）'}).buildings.find((b:any)=>b.id==='main');
  assert.equal(museum.sourceId,'relation/9653742');
  assert.ok((museum.path.match(/M/g)||[]).length>=3,'保留主馆两个中庭的实际孔洞');
});
