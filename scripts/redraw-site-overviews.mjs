// Rebuild local SVG drawing records from the checked-in geographic reference snapshot.
// This script does not fetch tiles, scrape providers, edit floor plans or touch user data.
import { readFile, writeFile } from 'node:fs/promises';
import { projectionFor, containsPoint, geometryPath, geometryCenter, placeLabels } from './lib/site-geometry.mjs';

const source = JSON.parse(await readFile(new URL('./references/site-overviews.json', import.meta.url), 'utf8'));
const links = JSON.parse(await readFile(new URL('./references/site-building-links.json', import.meta.url), 'utf8'));
const explicit = {
  '武康大楼': { main: 'way/293434151' },
  '徐家汇书院': { main: 'way/960132140' },
  '上海图书馆': { main: 'way/293434188' },
  '西岸美术馆': { main: 'way/745277168' },
  '上海气象博物馆（徐家汇观象台）': { main: 'way/960132139' },
  '上海摄影艺术中心': { main: 'way/488984509' },
  '龙美术馆（西岸馆）': { main: 'relation/9653742' },
  '上海体育场': { stadium: 'relation/9073794' },
  '上海体育馆': { gymnasium: 'way/47229124' },
  '上海交通大学徐汇校区': { campus: 'way/173581810' },
  '龙华寺': { mile: 'way/206174628', heaven: 'way/70560726', daxiong: 'way/70560729', sansheng: 'way/70560728' },
};
const normalize = value => String(value || '').replace(/\([^)]*\)|（[^）]*）|[\s·]/g, '');
const output = {}, report = [];
for (const [name, record] of Object.entries(source.records)) {
  const center = record.reference.center, catalogPoint = [center.lng, center.lat];
  const buildingFeatures = record.features.filter(f => f.kind === 'building');
  const resolved = new Map(), unresolved = [];
  for (const building of links[name].buildings) {
    let feature = explicit[name]?.[building.id] ? buildingFeatures.find(f => f.id === explicit[name][building.id]) : null;
    if (explicit[name]?.[building.id] && !feature) throw new Error(`${name}: expected ${explicit[name][building.id]} missing`);
    if (!feature) {
      const named = buildingFeatures.filter(f => normalize(f.tags.name) === normalize(building.name));
      if (named.length === 1) feature = named[0];
      else if (named.length > 1) { const containing = named.filter(f => containsPoint(f.rings, catalogPoint)); if (containing.length === 1) feature = containing[0]; }
    }
    // A sole unnamed footprint containing a catalog point may identify a single-building site.
    // Never assign the closest building, or use old decorative positions for multi-building sites.
    if (!feature && links[name].buildings.length === 1) {
      const containing = buildingFeatures.filter(f => containsPoint(f.rings, catalogPoint) && !f.tags['building:part']);
      if (containing.length === 1 && !containing[0].tags.name) feature = containing[0];
    }
    if (feature && !resolved.has(feature.id)) resolved.set(feature.id, building); else unresolved.push(building);
  }
  const site = record.features.find(f => ['green', 'site'].includes(f.kind) && (normalize(f.tags.name) === normalize(name) || (name === '上海交通大学徐汇校区' && f.id === 'way/144183801')));
  let focus = site?.rings.flat();
  if (!focus && links[name].type !== 'campus' && links[name].buildings.length === 1 && resolved.size) focus = buildingFeatures.filter(f => resolved.has(f.id)).flatMap(f => f.rings.flat());
  let bounds;
  const cosine = Math.cos(center.lat * Math.PI / 180);
  if (focus?.length) {
    const padding = site ? 35 : 65;
    bounds = [[Math.min(...focus.map(p => p[0])) - padding / (111320*cosine), Math.min(...focus.map(p => p[1])) - padding/111320], [Math.max(...focus.map(p => p[0])) + padding/(111320*cosine), Math.max(...focus.map(p => p[1])) + padding/111320]];
  } else {
    const radius = record.reference.radiusMeters >= 240 ? record.reference.radiusMeters : 120;
    bounds = [[center.lng-radius/(111320*cosine),center.lat-radius/111320],[center.lng+radius/(111320*cosine),center.lat+radius/111320]];
  }
  const { project, metersPerPixel } = projectionFor(center, bounds);
  const visible = feature => {
    const points = feature.rings.flat().map(project), xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    return Math.min(...xs)<600&&Math.max(...xs)>0&&Math.min(...ys)<420&&Math.max(...ys)>0;
  };
  const features = record.features.filter(visible);
  const buildings = features.filter(f=>f.kind==='building').map(f=>({
    ...(resolved.get(f.id) || { name: f.tags.name || '周边建筑', secondary: true }),
    shape: 'geo-building', path: geometryPath(f.rings,project), label: geometryCenter(f.rings,project), hideLabel: true, sourceId: f.id,
  }));
  const roadWidths={motorway:20,trunk:18,primary:14,secondary:12,tertiary:9,residential:6,unclassified:6,service:4,living_street:4};
  const roadDetails = features.filter(f=>f.kind==='road').map(f=>({ sourceId:f.id, path:geometryPath(f.rings,project,false),width:Math.max(2,(Number.parseFloat(f.tags.width)||roadWidths[f.tags.highway]||6)/metersPerPixel), name:f.tags.name||'' }));
  const candidates = buildings.filter(b=>!b.secondary).map(b=>({text:b.name,anchor:b.label,kind:'building'}));
  const labelNames=new Set(candidates.map(c=>c.text));
  for(const landmark of record.landmarks || []){
    const point=project(landmark.point);if(point[0]<15||point[0]>535||point[1]<15||point[1]>370||labelNames.has(landmark.name))continue;
    labelNames.add(landmark.name);candidates.push({text:landmark.name,anchor:point,kind:'landmark'});
  }
  for(const feature of features.filter(f=>f.kind==='building'&&f.tags.name&&!resolved.has(f.id)).sort((a,b)=>Math.hypot(...geometryCenter(a.rings,project).map((v,i)=>v-[300,210][i]))-Math.hypot(...geometryCenter(b.rings,project).map((v,i)=>v-[300,210][i]))).slice(0,5)){
    if(labelNames.has(feature.tags.name))continue;labelNames.add(feature.tags.name);candidates.push({text:feature.tags.name,anchor:geometryCenter(feature.rings,project),kind:'context'});
  }
  const roadsByName=new Map();for(const road of features.filter(f=>f.kind==='road'&&f.tags.name).sort((a,b)=>(roadWidths[b.tags.highway]||6)-(roadWidths[a.tags.highway]||6))){
    const points=road.rings[0].map(project);let point,distance=Infinity;
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
      if(!length)continue;const t=Math.max(0,Math.min(1,((300-a[0])*dx+(210-a[1])*dy)/length));
      const p=[a[0]+t*dx,a[1]+t*dy],d=Math.hypot(p[0]-300,p[1]-210);
      if(p[0]>35&&p[0]<565&&p[1]>25&&p[1]<375&&d<distance){point=p;distance=d}
    }
    if(!point||labelNames.has(road.tags.name)||roadsByName.has(road.tags.name))continue;
    roadsByName.set(road.tags.name,{text:road.tags.name,anchor:point,kind:'road'});
  }
  candidates.push(...[...roadsByName.values()].slice(0,5));
  const rawFacilities=record.facilities.filter(f=>{
    const [x,y]=project(f.point);if(x<15||x>520||y<15||y>375)return false;
    if(f.kind==='toilet')return site?containsPoint(site.rings,f.point):Math.hypot((f.point[0]-center.lng)*cosine,f.point[1]-center.lat)*111320<100;
    return f.ways.some(id=>resolved.has('way/'+id));
  }).map(f=>({...f,position:project(f.point).map(v=>Number(v.toFixed(2)))}));
  const facilities=[];for(const facility of rawFacilities){
    const close=facilities.find(f=>f.kind===facility.kind&&Math.hypot(f.position[0]-facility.position[0],f.position[1]-facility.position[1])<22);
    if(close)close.sourceIds.push(facility.id);else facilities.push({...facility,sourceIds:[facility.id]});
  }
  const chosenScale=[10,20,50,100,200,500].filter(m=>m/metersPerPixel<=120).at(-1)||10;
  output[name]={type:links[name].type,geographic:true,extent:null,roads:[],innerRoads:roadDetails.map(r=>r.path),roadDetails,
    greens:features.filter(f=>f.kind==='green').map(f=>geometryPath(f.rings,project)),water:features.filter(f=>f.kind==='water').map(f=>geometryPath(f.rings,project)),
    plazas:features.filter(f=>f.kind==='plaza').map(f=>geometryPath(f.rings,project)),paths:features.filter(f=>f.kind==='walk').map(f=>geometryPath(f.rings,project,false)),
    trees:[],buildings,labels:placeLabels(candidates,facilities.map(f=>f.position)),facilities,unlocatedBuildings:unresolved,walkWidth:Math.max(.8,2/metersPerPixel),
    ...(resolved.size===0?{placePosition:project(catalogPoint).map(v=>Number(v.toFixed(2)))}:{}),
    scale:{meters:chosenScale,pixels:Number((chosenScale/metersPerPixel).toFixed(2))},
    evidence:{kind:'geographic-outline',source:'OpenStreetMap 建筑、道路与地表轮廓',license:source.license,referenceDate:record.reference.retrievedAt.slice(0,10),crs:'WGS84',bounds,metersPerPixel,featureIds:features.map(f=>f.id),catalogPlaceId:record.reference.placeId},
  };
  report.push({name,footprints:buildings.length,located:resolved.size,unlocated:unresolved.map(b=>b.name),roads:roadDetails.length});
}
const header='/** 本地自绘室外图：基于真实 WGS84 轮廓等比投影，北向朝上。地理数据 © OpenStreetMap contributors，ODbL 1.0；无高德瓦片或截图。 */\n';
await writeFile(new URL('../public/lib/place-site-geometry.js',import.meta.url),header+'export const GEOGRAPHIC_SITE_MAPS = Object.freeze('+JSON.stringify(output)+');\n');
console.log(JSON.stringify(report,null,2));
