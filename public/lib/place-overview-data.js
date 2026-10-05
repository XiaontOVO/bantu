/** Local north-up site outlines; geographic evidence is independent of indoor plans. */
import { GEOGRAPHIC_SITE_MAPS } from './place-site-geometry.js';
const SITE_MAPS = GEOGRAPHIC_SITE_MAPS;

const SITE_MAP_ALIASES = Object.freeze({
  '上博东馆': '上海博物馆东馆',
  '上海博物馆(东馆)': '上海博物馆东馆',
  '上海博物馆（东馆）': '上海博物馆东馆',
  '上海博物馆东馆（浦东）': '上海博物馆东馆',
  '上海自然博物馆新馆': '上海自然博物馆',
  '上海自然博物馆（静安馆）': '上海自然博物馆',
  '上海自然博物馆(静安馆)': '上海自然博物馆',
  '上海市徐汇区图书馆(徐家汇书院)': '徐家汇书院',
  '上海市徐汇区图书馆（徐家汇书院）': '徐家汇书院',
  '儿博馆': '上海儿童博物馆',
  '上海儿童博物馆（宋园路）': '上海儿童博物馆',
  '上海儿童博物馆（宋庆龄陵园）': '上海儿童博物馆',
  '宋庆龄儿童博物馆': '上海儿童博物馆',
});

function normalizeSiteName(value) {
  return String(value || '').normalize('NFKC').replace(/[\s·•]/g, '').replace(/（[^）]*）|\([^)]*\)/g, '').replace(/(?:游客中心|旅游服务中心|风景名胜区|旅游景区|风景区|景区)$/g, '');
}

const NORMALIZED_SITE_MAP_NAMES = new Map(Object.keys(SITE_MAPS).map(name => [normalizeSiteName(name), name]));

export function siteMapNameFor(place) {
  const name = place?.name;
  if (SITE_MAPS[name]) return name;
  if (SITE_MAPS[SITE_MAP_ALIASES[name]]) return SITE_MAP_ALIASES[name];
  return NORMALIZED_SITE_MAP_NAMES.get(normalizeSiteName(name)) || null;
}

function missingSiteMap(place) {
  return Object.freeze({ type: 'missing', name: place?.name || '该地点' });
}

export function overviewFor(place) {
  const name = siteMapNameFor(place);
  return (name && SITE_MAPS[name]) || missingSiteMap(place);
}

export function overviewBuildingRecords(map) {
  return (map?.buildings || []).filter(building => !building.secondary && building.id).map(({ id, name }) => ({
    id, name, spaceKind:'unknown', floorInventoryKnown:false, floors: [],
  }));
}

export const SITE_MAP_NAMES = Object.freeze(Object.keys(SITE_MAPS));
