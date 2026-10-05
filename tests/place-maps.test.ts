import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const loadOverviewData = async () => import(pathToFileURL(join(process.cwd(), 'public/lib/place-overview-data.js')).href);
const loadPlaceTour = async () => import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour.js')).href);
const textWidth = (text: string, size: number) => [...text].reduce((width, glyph) => width + (glyph.codePointAt(0)! < 128 ? size * 0.58 : size), 0);
const footprintWidth = (building: any): number | undefined => {
  if (Number.isFinite(building.w)) return building.w;
  if (Number.isFinite(building.rx)) return building.rx * 2;
  if (typeof building.points === 'string') {
    const xValues = [...building.points.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(point => Number(point[1]));
    if (xValues.length) return Math.max(...xValues) - Math.min(...xValues);
  }
  return undefined;
};

test('卫生间统一使用专用符号，位置未核实的楼层明确提示，武康大楼不再展示猜测布局', async () => {
  const { SITE_MAP_NAMES } = await loadOverviewData();
  const { tourFor } = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour-data.js')).href);
  const { buildingSheetHtml, rememberBuildingFloor } = await loadPlaceTour();
  let markedFloors = 0;
  for (const name of SITE_MAP_NAMES) {
    const place = { name, placeId: `facilities-${name}` };
    for (const building of tourFor(place).buildings) {
      for (const [index, floor] of (building.floors || []).entries()) {
        const image = (building.floorPlanImages || []).find((item: any) => item.floor === floor.name);
        if (!image || image.kind === 'area-diagram') continue;
        rememberBuildingFloor(place, building.id, index);
        const html = buildingSheetHtml(place, building.id);
        assert.match(html, /floor-plan-restroom-key/, `${name} ${floor.name}: 缺少设施图例`);
        if (image.restroomsMapped) {
          markedFloors++;
          const source = readFileSync(join(process.cwd(), 'public', image.src.slice(1)), 'utf8');
          assert.match(source, /class="restroom-marker" role="img" aria-label="卫生间"/, `${image.src}: 缺少带文字说明的专用标记`);
          assert.match(source, /class="restroom-pictogram"/, `${image.src}: 缺少统一的卫生间符号`);
          assert.match(html, /蓝色标记来自参考资料，现场位置及开放状态尚未复核/);
          assert.doesNotMatch(html, /已核实位置/);
        } else assert.match(html, /本层位置尚未核实，图中不作推测/);
      }
    }
  }
  assert.equal(markedFloors, 22);
  const wukang = buildingSheetHtml({ name: '武康大楼', placeId: 'unverified-wukang' }, 'main');
  assert.match(wukang, /欣赏建筑外观/);
  assert.doesNotMatch(wukang, /馆内导览|1F|floor-tabs/);
  assert.doesNotMatch(wukang, /wukang-building-1f\.svg|restroomsMapped/);
});

test('每张本地楼层图在图面前说明资料性质、资料时间和限制，功能图不冒充建筑平面', async () => {
  const { SITE_MAP_NAMES } = await loadOverviewData();
  const { tourFor, floorImageBySrc } = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-tour-data.js')).href);
  const { buildingSheetHtml, rememberBuildingFloor, tourSectionHtml } = await loadPlaceTour();
  const sources = new Set<string>();
  for (const name of SITE_MAP_NAMES) {
    const place = { name, placeId: `evidence-${name}` };
    assert.match(tourSectionHtml(place), /伴途场地方位示意.*非测绘比例|伴途本地轮廓图.*非测绘图/);
    for (const building of tourFor(place).buildings) {
      for (const [index, floor] of (building.floors || []).entries()) {
        const image = (building.floorPlanImages || []).find((item: any) => item.floor === floor.name);
        if (!image) continue;
        sources.add(image.src);
        rememberBuildingFloor(place, building.id, index);
        const html = buildingSheetHtml(place, building.id);
        assert.ok(html.indexOf('class="map-evidence"') < html.indexOf('class="floor-plan-image"'), 'source context appears before the image');
        assert.notEqual(image.evidence.kind, 'unverified', `${image.src}: reference classification is missing`);
        assert.match(html, /资料年份 \d{4}|资料时间未注明/);
        assert.ok(image.evidence.source && image.evidence.limit);
        assert.doesNotMatch(html, /已核实位置|href="https?:/);
        assert.deepEqual(floorImageBySrc(image.src)?.evidence, image.evidence, 'standalone zoom resolves the same reference as the floor panel');
      }
    }
  }
  const localFiles = readdirSync(join(process.cwd(), 'public/images/places/floorplan')).filter(file => file.endsWith('.svg'));
  assert.deepEqual([...sources].map(src => src.split('/').pop()).sort(), localFiles.sort(), 'every local floor image has provenance');
  const evidenceFor = (name: string, floor: string) => tourFor({ name }).buildings[0].floorPlanImages.find((image: any) => image.floor === floor).evidence;
  assert.equal(evidenceFor('徐家汇书院', 'B1').kind, 'area-diagram');
  assert.match(evidenceFor('徐家汇书院', 'B1').limit, /不表示房间边界、相对位置或通行路线/);
  assert.equal(evidenceFor('徐家汇书院', '1F').kind, 'design-plan');
  assert.equal(evidenceFor('星美术馆', '1F').year, 2022);
  assert.equal(evidenceFor('上海工艺美术博物馆', '1F').year, 2019);
  assert.equal(evidenceFor('上海博物馆（东馆）', '1F').year, 2025);
  assert.equal(evidenceFor('上海公安博物馆', '2F').year, undefined, 'do not manufacture a VR publication or site verification date');
  assert.equal(floorImageBySrc('/images/places/floorplan/missing.svg'), null);
  const { floorPlanEvidence } = await import(pathToFileURL(join(process.cwd(), 'public/lib/place-map-evidence.js')).href);
  const unknown = floorPlanEvidence('未知地点', { kind: 'area-diagram', src: '/images/places/floorplan/missing.svg' });
  assert.equal(unknown.kind, 'unverified');
  assert.equal(unknown.source, '资料依据待核实', 'missing references never borrow another venue’s provenance');
});

test('景点总览图的建筑名与场地标注不重复、不相撞且留在画布内', async () => {
  const { SITE_MAP_NAMES, overviewFor } = await loadOverviewData();
  const collisions: string[] = [];

  for (const name of SITE_MAP_NAMES) {
    const map = overviewFor({ name });
    const labels: Array<{ text: string; x: number; y: number; width: number; height: number }> = [];
    for (const building of map.buildings || []) {
      if (building.hideLabel) continue;
      if (!building.name) continue;
      const point = building.label || [building.cx ?? building.x + building.w / 2, building.cy ?? building.y + building.h / 2];
      const size = building.secondary || building.compactLabel || building.shape === 'tank' || building.shape === 'silos' ? 13 : 16;
      const text = building.shortLabel || (building.name === name ? building.shape === 'stadium' ? '场馆' : '主体建筑' : building.name);
      labels.push({ text, x: point[0], y: point[1], width: textWidth(text, size), height: size });
      const availableWidth = footprintWidth(building);
      if (availableWidth !== undefined) assert.ok(textWidth(text, size) <= availableWidth, `${name}: ${text} 宽于建筑轮廓`);
    }
    for (const label of (map.labels || []).filter((label: any) => label.text !== name)) {
      const size = label.fontSize || (label.kind === 'road' ? 12 : 16);
      let width = textWidth(label.text, size);
      let height = size;
      if (Math.abs(label.rotate || 0) % 180 === 90) [width, height] = [height, width];
      labels.push({ text: label.text, x: label.x, y: label.y, width, height });
      assert.ok(label.x - width / 2 >= 8 && label.x + width / 2 <= 592, `${name}: ${label.text} 横向越界`);
      assert.ok(label.y - height / 2 >= 8 && label.y + height / 2 <= 412, `${name}: ${label.text} 纵向越界`);
    }

    labels.push({ text: 'north compass badge', x: 561, y: 54, width: 34, height: 68 });

    for (let left = 0; left < labels.length; left++) {
      for (let right = left + 1; right < labels.length; right++) {
        const a = labels[left];
        const b = labels[right];
        if (Math.abs(a.x - b.x) < (a.width + b.width) / 2 - 1 && Math.abs(a.y - b.y) < (a.height + b.height) / 2 - 1) {
          collisions.push(`${name}: ${a.text} / ${b.text}`);
        }
      }
    }
  }

  assert.deepEqual(collisions, []);
});

test('总览图会合并重复标注，并提供可放大查看的入口', async () => {
  const { SITE_MAP_NAMES, overviewFor } = await loadOverviewData();
  const { tourSectionHtml } = await loadPlaceTour();

  for (const name of SITE_MAP_NAMES) {
    const map = overviewFor({ name });
    const visible = [
      ...(map.buildings || []).filter((building: any) => !building.hideLabel).map((building: any) => building.mapLabel || building.shortLabel || (building.name === name ? building.shape === 'stadium' ? '场馆' : '主体建筑' : building.name)),
      ...(map.labels || []).filter((label: any) => label.text !== name).map((label: any) => label.text),
    ].map((label: string) => label.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase());
    assert.equal(new Set(visible).size, visible.length, `${name}: 地图上仍有重复文字`);
    const html = tourSectionHtml({ name, placeId: `overview-${name}` });
    assert.match(html, /site-map-road-markings/, `${name}: 道路缺少统一的车道细节`);
    const roadPaths = [...new Set([...(map.roads || []), ...(map.innerRoads || [])])];
    for (const path of roadPaths) {
      assert.equal(html.split(`d="${path}" class="site-map-road-markings"`).length - 1, 1, `${name}: 道路不得重复绘制`);
    }
  }

  const tankMap = overviewFor({ name: '油罐艺术中心' });
  assert.ok(tankMap.geographic && tankMap.water.length > 0, '油罐总览保留实际水岸轮廓');
  assert.ok(tankMap.unlocatedBuildings.some((building: any) => building.id === 'tank-5'), '未能明确对应编号的罐体不能猜测室内图关联');
  assert.match(tourSectionHtml({ name: '油罐艺术中心', placeId: 'tank' }), /data-building="tank-5"/, '五号罐原楼层入口仍可访问');

  const wukang = overviewFor({ name: '武康大楼' });
  const wukangBuilding = wukang.buildings.find((building: any) => building.id === 'main');
  assert.equal(wukangBuilding?.shape, 'geo-building', '武康大楼使用实际坐标轮廓');
  assert.equal(wukangBuilding?.sourceId, 'way/293434151');
  for (const road of ['武康路', '淮海中路']) assert.ok(wukang.labels.some((label: any) => label.text === road), `${road} 实际街道标注应保留`);

  const campus = overviewFor({ name: '上海交通大学徐汇校区' });
  assert.ok(campus.buildings.length >= 28, 'SJTU campus overview should show the campus building clusters, not a handful of landmarks');
  assert.equal(campus.buildings.filter((building: any) => !building.secondary).length, 1, 'context-only campus footprints should remain noninteractive');
  assert.ok(campus.greens.length && campus.plazas.length, '校园保留资料中记录的绿地及运动场轮廓');
  assert.equal(campus.buildings.find((building: any) => building.id === 'campus')?.sourceId, 'way/173581810');

  const botanicalGarden = overviewFor({ name: '上海植物园' });
  assert.ok(botanicalGarden.innerRoads.length >= 8 && botanicalGarden.paths.length >= 14, '植物园保留真实道路和园路');
  assert.ok(botanicalGarden.water.length >= 4 && botanicalGarden.greens.length >= 4, '植物园保留实际水域及绿地轮廓');
  assert.equal(botanicalGarden.trees.length, 0, '没有单株树记录时不编造树木位置');
  const gardenHtml = tourSectionHtml({ name: '上海植物园', placeId: 'shanghai-botanical-garden' });
  for (const id of ['greenhouse-1', 'greenhouse-2']) assert.match(gardenHtml, new RegExp(`data-building="${id}"`), '两处温室的原楼层入口必须保留');

  const html = tourSectionHtml({ name: '上海图书馆', placeId: 'shanghai-library' });
  assert.match(html, /data-action="zoom-place-overview"/, '总览图缺少放大入口');
  assert.match(html, /class="site-map-svg"/, '放大入口没有对应场地图面');
  assert.match(html, /class="site-map-compass-backdrop"/, '总览图方位标记缺少清晰背景');

  const arenaHtml = tourSectionHtml({ name: '上海体育馆', placeId: 'shanghai-gymnasium' });
  assert.match(arenaHtml, /<path class="site-map-hit-area" d="[^"]+" fill-rule="evenodd"\/>/, '真实建筑轮廓应提供相同形状的可点击区域');
  assert.doesNotMatch(arenaHtml, /(?:cx|cy|r|rx|ry)="NaN"/, '建筑轮廓包含无效坐标');
});

test('室内 SVG 平面图图例完整纳入画布且重复文字已清理', () => {
  const directory = join(process.cwd(), 'public/images/places/floorplan');
  const files = readdirSync(directory).filter(name => name.endsWith('.svg'));
  assert.ok(files.length >= 50, '本地室内平面图资产数量异常');
  let panelCount = 0;

  for (const file of files) {
    const source = readFileSync(join(directory, file), 'utf8');
    assert.ok(source.includes('<title') && source.includes('<desc') && source.includes('</svg>'), `${file}: SVG 内容不完整`);
    assert.ok(source.includes('id="bantu-floorplan-standard-v3"'), `${file}: 未应用统一的配色和文字规范`);
    assert.match(source, /\.service,\.core,\.wc,\.zone\.wc,\.amenity rect\{fill:#eaf1f3!important;stroke:#748aa8!important/, `${file}: 核心区应使用统一的浅色服务空间样式`);
    assert.doesNotMatch(source, /您在这里|您的位置|我的位置|当前位置|class="you"/, `${file}: 静态楼层图不得标注用户实时位置`);
    assert.doesNotMatch(source, /<(?:image|feImage)\b|\b(?:xlink:)?href=["'](?:https?:|\/\/)/i, `${file}: 室内图应使用产品内自绘图形，不依赖外部图片`);
    const viewBox = source.match(/<svg\b[^>]*\bviewBox="0 0 ([\d.]+) ([\d.]+)"/);
    assert.ok(viewBox, `${file}: 缺少有效画布范围`);
    const panel = source.match(/<rect class="panel" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/);
    if (panel) {
      panelCount++;
      assert.ok(Number(panel[1]) + Number(panel[2]) <= Number(viewBox[1]), `${file}: 说明栏超出 SVG 画布`);
      const background = source.match(/<rect class="bg" width="([\d.]+)"/);
      if (background) assert.ok(Number(viewBox[1]) >= Number(background[1]), `${file}: 背景画布与说明栏未完整纳入视窗`);
    }
  }
  assert.ok(panelCount >= 30, '带说明栏的楼层图未全部纳入画布检查');

  const uniqueLabels = [
    ['shanghai-children-museum-2f.svg', '返回地球'],
    ['xujiahui-library-1f.svg', '西侧展区'], ['xujiahui-library-1f.svg', '东侧展区'],
    ['xujiahui-library-2f.svg', '西侧展区'], ['xujiahui-library-2f.svg', '东侧展区'],
    ['xujiahui-library-3f.svg', '西侧休息区'], ['xujiahui-library-3f.svg', '东侧休息区'],
    ['tank-shanghai-5-1f.svg', '城市侧舞台'], ['tank-shanghai-5-1f.svg', '另一端舞台'],
    ['west-bund-dream-silo-1-2f.svg', '左筒楼梯 / 核心筒'], ['west-bund-dream-silo-1-2f.svg', '右筒楼梯 / 核心筒'],
    ['start-museum-roof.svg', '西侧展台'], ['start-museum-roof.svg', '东侧展台'],
  ] as const;
  for (const [file, label] of uniqueLabels) {
    const source = readFileSync(join(process.cwd(), 'public/images/places/floorplan', file), 'utf8');
    assert.equal(source.split(`>${label}</text>`).length - 1, 1, `${file}: ${label} 应只出现一次`);
  }

  const visibleTexts = (source: string) => [...source.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map(match => match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, '').trim()).filter(Boolean);
  const library2fTexts = visibleTexts(readFileSync(join(directory, 'shanghai-library-2f.svg'), 'utf8'));
  assert.equal(library2fTexts.filter(label => label === '中外书刊外借室').length, 0, '二层两处外借区不应重复使用同一个笼统名称');
  assert.ok(library2fTexts.includes('科技图书外借区') && library2fTexts.includes('社科图书外借区'), '二层外借区应按馆藏类别分别标注');
  const library3fTexts = visibleTexts(readFileSync(join(directory, 'shanghai-library-3f.svg'), 'utf8'));
  assert.ok(library3fTexts.includes('外文科技期刊阅览室') && library3fTexts.includes('中国文化名人手稿馆'), '三层长名称应完整显示并换行');
  const film1fTexts = visibleTexts(readFileSync(join(directory, 'shanghai-film-museum-1f.svg'), 'utf8'));
  assert.equal(film1fTexts.filter(label => label === '艺术影厅' || label === '藝術影廳').length, 1, '电影博物馆一层影厅名称不应中英繁简重复');
  assert.ok(!files.includes('wukang-building-1f.svg'), '未经核实的武康大楼室内图应撤下');

  const intentionalRepeats: Record<string, Record<string, number>> = {
    'shanghai-arts-and-crafts-museum-1f.svg': { '商铺': 3, '出口': 3 },
    'shanghai-library-1f.svg': { '出口': 4 },
    'shanghai-library-2f.svg': { '出口': 7 },
    'shanghai-library-3f.svg': { '出口': 7 },
  };
  for (const file of files) {
    const source = readFileSync(join(directory, file), 'utf8');
    const viewBox = source.match(/<svg\b[^>]*\bviewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const width = Number(viewBox?.[1]);
    const counts = new Map<string, number>();
    for (const match of source.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      // A facility symbol may occur at multiple documented positions and in the key.
      if (/class="restroom-caption"/.test(match[1])) continue;
      const x = Number((match[1].match(/\bx="([\d.]+)/) || [])[1]);
      if (Number.isFinite(x) && x > width) continue;
      const label = match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, '').trim();
      if (label) counts.set(label, (counts.get(label) || 0) + 1);
    }
    const duplicates = Object.fromEntries([...counts].filter(([, count]) => count > 1).sort(([a], [b]) => a.localeCompare(b)));
    assert.deepEqual(duplicates, intentionalRepeats[file] || {}, `${file}: 可见文字只允许在不同实际点位重复`);
  }

  for (const floor of ['1F', '2F', '3F', '4F']) {
    const source = readFileSync(join(directory, `shanghai-police-museum-${floor.toLowerCase()}.svg`), 'utf8');
    assert.ok(source.includes(`<g aria-label="${floor}"><rect class="floor-badge"`) && source.includes(`>${floor}</text>`), `${floor} police museum plan needs a visible floor marker`);
  }

  const stadium = readFileSync(join(directory, 'shanghai-stadium-stands.svg'), 'utf8');
  assert.equal((stadium.match(/class="stair-index"/g) || []).length, 7, '体育场应保留 7 个编号扶梯');
  assert.doesNotMatch(stadium, />STAIR<\/text>/, '扶梯编号已写中文，不应再重复英文释义');

  const longMuseum = readFileSync(join(directory, 'long-museum-west-bund-1f.svg'), 'utf8');
  const areaNumbers = [...longMuseum.matchAll(/<text class="number"[^>]*>(\d+)<\/text>/g)].map(match => match[1]);
  assert.equal(new Set(areaNumbers).size, areaNumbers.length, '龙美术馆一层不应重复展区编号');

  const longMuseumB1 = readFileSync(join(directory, 'long-museum-west-bund-b1.svg'), 'utf8');
  assert.equal((longMuseumB1.match(/class="small tight"/g) || []).length, 4, '龙美术馆 B1 狭窄功能区应使用紧凑标注');
});
