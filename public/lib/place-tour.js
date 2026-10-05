/**
 * 「游览地图」渲染：基于实际地理轮廓的本地 SVG；室内资料独立管理。
 * 区块只保留地图本体——建筑可点击打开平面图（交互经 data-action 委托）。
 */
import { tourFor, floorPlanFor } from './place-tour-data.js';
import { overviewFor } from './place-overview-data.js';
import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';
import { mapEvidenceHtml, overviewEvidenceHtml, restroomEvidenceText } from './place-map-evidence.js';

function svgBuildingShape(building) {
  const buildingCaption = (x, y, extra = '') => {
    if (building.hideLabel) return '';
    const labelClasses = [extra, building.compactLabel ? 'is-compact' : ''].filter(Boolean).join(' ');
    return `<text x="${x}" y="${y}" class="site-map-building-label ${labelClasses}">${escapeHtml(building.mapLabel || building.shortLabel || building.name)}</text>`;
  };
  const outline = 'class="site-map-building-shape"';
  if (building.shape === 'geo-building') return `<path ${outline} d="${building.path}" fill-rule="evenodd"/>`;
  if (building.shape === 'poly') {
    const points = [...String(building.points || '').matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(point => [Number(point[1]), Number(point[2])]);
    const center = points.length ? points.reduce(([x, y], [px, py]) => [x + px / points.length, y + py / points.length], [0, 0]) : null;
    const inset = center ? points.map(([x, y]) => `${center[0] + (x - center[0]) * .84},${center[1] + (y - center[1]) * .84}`).join(' ') : '';
    return `<polygon ${outline} points="${building.points}"/>${inset ? `<polygon class="site-map-roof-inset" points="${inset}"/>` : ''}${buildingCaption(...(building.label || [300, 200]))}`;
  }
  if (building.shape === 'museum-complex') return `<path ${outline} d="${building.path}"/><path class="site-map-roof-detail" d="${building.innerPath}"/>${buildingCaption(...(building.label || [building.x + building.w / 2, building.y + building.h / 2]))}`;
  if (building.shape === 'museum-shell') return `<path ${outline} d="${building.path}"/><path class="site-map-roof-detail" d="${building.innerPath}"/>${buildingCaption(...(building.label || [building.x + building.w / 2, building.y + building.h / 2]))}`;
  if (building.shape === 'wukang-building') return `<path ${outline} d="${building.path}"/><path class="site-map-roof-inset" d="${building.innerPath}"/>${buildingCaption(...(building.label || [300, 200]))}`;
  if (building.shape === 'octagon') {
    const points = Array.from({ length: 8 }, (_, index) => {
      const angle = (Math.PI / 4) * index - Math.PI / 8;
      return `${building.cx + Math.cos(angle) * building.rx},${building.cy + Math.sin(angle) * building.ry}`;
    }).join(' ');
    return `<polygon ${outline} points="${points}"/>${buildingCaption(...(building.label || [building.cx, building.cy]))}`;
  }
  if (building.shape === 'stadium') return `<ellipse ${outline} cx="${building.cx}" cy="${building.cy}" rx="${building.rx}" ry="${building.ry}"/><ellipse class="site-map-stadium-bowl" cx="${building.cx}" cy="${building.cy}" rx="${building.rx * .7}" ry="${building.ry * .58}"/>${buildingCaption(...(building.label || [building.cx, building.cy]))}`;
  if (building.shape === 'arena') return `<circle ${outline} cx="${building.cx}" cy="${building.cy}" r="${building.rx}"/><circle class="site-map-arena-bowl" cx="${building.cx}" cy="${building.cy}" r="${building.rx * .78}"/><circle class="site-map-arena-ring" cx="${building.cx}" cy="${building.cy}" r="${building.rx * .59}"/>${buildingCaption(...(building.label || [building.cx, building.cy]))}`;
  if (building.shape === 'tank') return `<ellipse ${outline} cx="${building.cx}" cy="${building.cy}" rx="${building.rx}" ry="${building.ry}"/><ellipse class="site-map-roof-detail" cx="${building.cx}" cy="${building.cy}" rx="${building.rx * .76}" ry="${building.ry * .76}"/>${buildingCaption(building.cx, building.cy, 'is-inside')}`;
  if (building.shape === 'photo-center') {
    const pods = [[.19,.27,.22,.34],[.50,.22,.23,.30],[.80,.28,.21,.33],[.19,.73,.22,.34],[.50,.77,.23,.29],[.80,.72,.21,.34]]
      .map(([cx, cy, rx, ry]) => `<ellipse ${outline} cx="${building.x + building.w * cx}" cy="${building.y + building.h * cy}" rx="${building.w * rx / 2}" ry="${building.h * ry / 2}"/>`).join('');
    return `<g>${pods}<polygon class="site-map-courtyard" points="${building.x + building.w * .37},${building.y + building.h * .39} ${building.x + building.w * .63},${building.y + building.h * .39} ${building.x + building.w * .50},${building.y + building.h * .65}"/></g>${buildingCaption(...(building.label || [300, 285]))}`;
  }
  if (building.shape === 'silos') {
    const silos = [[.26,.28],[.70,.28],[.26,.72],[.70,.72]].map(([x, y]) => `<ellipse ${outline} cx="${building.x + building.w * x}" cy="${building.y + building.h * y}" rx="${building.w * .21}" ry="${building.h * .28}"/>`).join('');
    return `${silos}${buildingCaption(...(building.label || [building.x + building.w / 2, building.y + building.h / 2]), 'is-inside')}`;
  }
  if (building.shape === 'glasshouse') {
    return `<rect ${outline} x="${building.x}" y="${building.y}" width="${building.w}" height="${building.h}" rx="${Math.min(20, building.h / 3)}"/><path class="site-map-glass-rib" d="M${building.x + 12} ${building.y + 2}V${building.y + building.h - 2} M${building.x + building.w / 2} ${building.y + 2}V${building.y + building.h - 2} M${building.x + building.w - 12} ${building.y + 2}V${building.y + building.h - 2}"/>${buildingCaption(...(building.label || [building.x + building.w / 2, building.y + building.h / 2]))}`;
  }
  const inset = Math.max(4, Math.min(building.w, building.h) * .13);
  const roof = building.w > 36 && building.h > 25
    ? `<path class="site-map-roof-detail" d="M${building.x + inset} ${building.y + building.h * .25}H${building.x + building.w - inset} M${building.x + building.w * .25} ${building.y + inset}H${building.x + building.w * .75} M${building.x + building.w * .25} ${building.y + building.h - inset}H${building.x + building.w * .75}"/>`
    : '';
  return `<rect ${outline} x="${building.x}" y="${building.y}" width="${building.w}" height="${building.h}" rx="${building.rx || 3}"/>${roof}${buildingCaption(...(building.label || [building.x + building.w / 2, building.y + building.h / 2]))}`;
}

function svgBuildingHitArea(building) {
  const padding = 10;
  if (building.shape === 'geo-building') return `<path class="site-map-hit-area" d="${building.path}" fill-rule="evenodd"/>`;
  if (building.shape === 'poly') {
    return `<polygon class="site-map-hit-area" points="${building.points}"/>`;
  }
  if (building.path && ['museum-complex', 'museum-shell', 'wukang-building'].includes(building.shape)) {
    return `<path class="site-map-hit-area" d="${building.path}"/>`;
  }
  if (building.shape === 'arena') {
    return `<circle class="site-map-hit-area" cx="${building.cx}" cy="${building.cy}" r="${building.rx + padding}"/>`;
  }
  if (building.shape === 'octagon' || building.shape === 'stadium' || building.shape === 'tank') {
    const rx = building.rx + padding, ry = building.ry + padding;
    return `<ellipse class="site-map-hit-area" cx="${building.cx}" cy="${building.cy}" rx="${rx}" ry="${ry}"/>`;
  }
  if (building.shape === 'photo-center' || building.shape === 'silos') {
    return `<rect class="site-map-hit-area" x="${building.x - padding}" y="${building.y - padding}" width="${building.w + padding * 2}" height="${building.h + padding * 2}" rx="12"/>`;
  }
  return `<rect class="site-map-hit-area" x="${building.x - padding}" y="${building.y - padding}" width="${building.w + padding * 2}" height="${building.h + padding * 2}" rx="8"/>`;
}

function localFloorMapCoverage(plan) {
  if (!plan || plan.floorInventoryKnown === false || ['exterior','outdoor','unknown'].includes(plan.spaceKind)) return {totalFloors:0,mappedFloors:0};
  const floors = plan?.floors || [];
  const floorNames = new Set(floors.map(floor => floor.name));
  const mappedFloors = new Set((plan?.floorPlanImages || []).filter(image => floorNames.has(image.floor) && image.kind !== 'area-diagram').map(image => image.floor)).size;
  return { totalFloors: floors.length, mappedFloors };
}

function buildingMapDescription(plan) {
  if (plan?.spaceKind === 'exterior') return '建筑外观资料，不提供室内参观路线';
  if (plan?.spaceKind === 'outdoor') return '室外区域资料，不计作室内楼层';
  if (plan?.spaceKind === 'unknown' || plan?.floorInventoryKnown === false) return '平面资料尚未收录，楼层数量未核实';
  const {totalFloors,mappedFloors} = localFloorMapCoverage(plan);
  if (!totalFloors) return '楼层资料待核实';
  if (!mappedFloors) return '已收录楼层说明，暂无可展示的平面图';
  return mappedFloors === totalFloors ? `已收录的 ${totalFloors} 层均有本地平面图` : `已收录的 ${mappedFloors}/${totalFloors} 层有本地平面图`;
}

function normalizeMapText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

function siteOverviewSvg(place, map) {
  if (!map || map.type === 'missing') {
    return `<div class="site-map-unavailable" role="status"><span aria-hidden="true">⌖</span><strong>${escapeHtml(place.name)}的总览图正在核实绘制</strong><p>确认园区边界和建筑位置后再展示地图，避免用虚构点位代替真实场地。</p></div>`;
  }
  const contextBlocks = (map.contextBlocks || []).map(path => `<path class="site-map-context-block" d="${path}"/>`).join('');
  const drawRoad = path => {
    const detail = map.roadDetails?.find(road => road.path === path);
    return `<g class="site-map-road"><path d="${path}"${detail ? ` style="stroke-width:${detail.width + 1.3}px"` : ''}/><path d="${path}" class="site-map-road-center"${detail ? ` style="stroke-width:${detail.width}px"` : ''}/><path d="${path}" class="site-map-road-markings"${detail ? ` style="stroke-width:.6px;opacity:${detail.width > 6 ? '.55' : '0'}"` : ''}/></g>`;
  };
  const outerRoadPaths = [...new Set(map.roads || [])];
  const outerRoadSet = new Set(outerRoadPaths);
  const innerRoadPaths = [...new Set(map.innerRoads || [])].filter(path => !outerRoadSet.has(path));
  const roads = outerRoadPaths.map(drawRoad).join('');
  const innerRoads = innerRoadPaths.map(drawRoad).join('');
  const greens = (map.greens || []).map(path => `<path class="site-map-green" d="${path}"/>`).join('');
  const water = (map.water || []).map(path => `<path class="site-map-water" d="${path}"/>`).join('');
  const plazas = (map.plazas || []).map(path => `<path class="site-map-plaza" d="${path}"/>`).join('');
  const paths = (map.paths || []).map(path => `<g class="site-map-walk"><path d="${path}"${map.geographic ? ` style="stroke-width:${map.walkWidth + .6}px"` : ''}/><path d="${path}" class="site-map-walk-center"${map.geographic ? ` style="stroke-width:${map.walkWidth}px"` : ''}/></g>`).join('');
  const trees = (map.trees || []).map(([x, y, radius = 8], index) => `<g class="site-map-tree" aria-hidden="true"><circle cx="${x}" cy="${y}" r="${radius}" class="site-map-tree-shadow"/><circle cx="${x}" cy="${y}" r="${radius - 1}" class="site-map-tree-crown tone-${index % 3}"/><path d="M${x - radius * .45} ${y}q${radius * .45} ${-radius * .68} ${radius} 0q${-radius * .5} ${radius * .58} ${-radius} 0Z" class="site-map-tree-highlight"/></g>`).join('');
  const decor = (map.buildings || []).filter(building => building.secondary).map(building => `<g class="site-map-building site-map-building-secondary" aria-label="${escapeHtml(building.name)}"><title>${escapeHtml(building.name)}</title>${svgBuildingShape(building)}</g>`).join('');
  const tour = tourFor(place);
  const tourBuildings = new Map((tour.buildings || []).map(building => [building.id, building]));
  const buildings = (map.buildings || []).filter(building => !building.secondary && building.id).map(building => {
    const plan = tourBuildings.get(building.id);
    const { totalFloors, mappedFloors } = localFloorMapCoverage(plan);
    const planState = totalFloors === 0 || mappedFloors === 0 ? 'is-plan-pending' : mappedFloors === totalFloors ? 'is-plan-ready' : 'is-plan-partial';
    const planStatus = buildingMapDescription(plan);
    const mapLabel = building.shortLabel || (building.name === place.name ? building.shape === 'stadium' ? '场馆' : '主体建筑' : building.name);
    return `<g class="site-map-building ${planState}" data-action="open-building-plan" data-place="${escapeHtml(place.placeId)}" data-building="${escapeHtml(building.id)}" role="button" tabindex="0" aria-label="查看${escapeHtml(building.name)}建筑资料：${escapeHtml(planStatus)}" aria-haspopup="dialog"><title>${escapeHtml(building.name)} · ${escapeHtml(planStatus)}</title>${svgBuildingHitArea(building)}${svgBuildingShape({ ...building, mapLabel })}</g>`;
  }).join('');
  const buildingLabels = new Set((map.buildings || []).filter(building => !building.hideLabel).map(building => normalizeMapText(
    building.mapLabel || building.shortLabel || (building.name === place.name ? building.shape === 'stadium' ? '场馆' : '主体建筑' : building.name),
  )).filter(Boolean));
  const visibleLabelNames = new Set(buildingLabels);
  const labels = (map.labels || []).filter(label => {
    const text = normalizeMapText(label.text);
    if (!text || (!map.geographic && text === normalizeMapText(place.name)) || visibleLabelNames.has(text)) return false;
    visibleLabelNames.add(text);
    return true;
  }).map(label => {
    const rotation = Number.isFinite(label.rotate) ? ` transform="rotate(${label.rotate} ${label.x} ${label.y})"` : '';
    const leader = label.leader ? `<path class="site-map-label-leader" d="M${label.leader[0].join(' ')}L${label.leader[1].join(' ')}"/>` : '';
    return `${leader}<text x="${label.x}" y="${label.y}"${rotation}${label.fontSize ? ` style="font-size:${label.fontSize}px"` : ''} class="site-map-label is-${escapeHtml(label.kind || 'place')}"><title>${escapeHtml(label.fullText || label.text)}</title>${escapeHtml(label.text)}</text>`;
  }).join('');
  const northArrow = '<g class="site-map-compass" aria-hidden="true"><rect x="544" y="20" width="34" height="68" rx="17" class="site-map-compass-backdrop"/><text x="561" y="48">北</text><path d="M561 54v28m-6-8 6-20 6 20"/></g>';
  const scale = map.scale ? `<g class="site-map-scale" aria-label="比例参考 ${map.scale.meters} 米"><rect x="14" y="376" width="${Math.max(80,map.scale.pixels + 16)}" height="30" rx="6"/><path d="M22 388v7h${map.scale.pixels}v-7"/><text x="22" y="386">约 ${map.scale.meters} 米</text></g>` : '';
  const facilities = (map.facilities || []).map(facility => `<g class="site-map-facility is-${facility.kind}" transform="translate(${facility.position.join(' ')})" aria-label="${facility.kind === 'toilet' ? '卫生间，位置来自资料记录，开放状态以现场为准' : '建筑入口，位置来自资料记录'}"><title>${facility.kind === 'toilet' ? '卫生间 · 资料记录位置' : '建筑入口 · 资料记录位置'}</title><rect x="-9" y="-9" width="18" height="18" rx="5"/>${facility.kind === 'toilet' ? '<text x="0" y="1">WC</text>' : '<path d="M-4 0h8m-3-3 3 3-3 3"/>'}</g>`).join('');
  const position = map.placePosition ? `<g class="site-map-place-position" transform="translate(${map.placePosition.join(' ')})" aria-label="${escapeHtml(place.name)}地点位置，建筑范围尚待核对"><title>${escapeHtml(place.name)} · 地点位置，建筑范围尚待核对</title><circle r="9"/><path d="M-3 0h6M0-3v6"/></g>` : '';
  return `<svg viewBox="0 0 600 420" class="site-map-svg"${map.geographic ? ' data-geographic="true"' : ''} role="group" aria-label="${escapeHtml(place.name)}全貌平面示意图">
    <defs><filter id="site-building-shadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#57635c" flood-opacity=".19"/></filter></defs>
    <rect width="600" height="420" class="site-map-ground"/>
    ${contextBlocks}
    ${roads}
    ${map.extent === null ? '' : `<path class="site-map-extent is-${escapeHtml(map.type)}" d="${map.extent || 'M54 42H546V378H54Z'}"/>`}
    ${greens}${water}${plazas}${innerRoads}${paths}${trees}${decor}${buildings}${position}${facilities}${labels}${northArrow}${scale}
  </svg>`;
}

/** 展示有资料依据的本地图；资料性质与现场核实是不同条件。 */
function floorPlanContent(plan) {
  const { building, floor } = plan;
  const floorImage = (building.floorPlanImages || []).find(item => item.floor === floor.name);
  if (floorImage) {
    const licenseText = floorImage.licenseLabel ? ` · ${escapeHtml(floorImage.licenseLabel)}` : '';
    const credit = floorImage.credit ? `<figcaption class="floor-plan-credit">图源：${escapeHtml(floorImage.credit)}${licenseText}</figcaption>` : '';
    const alt = floorImage.alt || `${building.name} ${floor.name}平面图`;
    return `<figure class="floor-plan-image-wrap"><button type="button" class="floor-plan-zoom-trigger" data-action="zoom-place-image" data-image-src="${escapeHtml(floorImage.src)}" data-image-alt="${escapeHtml(alt)}" data-image-title="${escapeHtml(`${building.name} · ${floor.name}`)}" aria-label="放大查看${escapeHtml(alt)}" aria-haspopup="dialog"><img class="floor-plan-image" src="${escapeHtml(floorImage.src)}" alt="" loading="lazy"></button><figcaption class="floor-plan-zoom-hint">点击图面查看大图，可拖动查看细节</figcaption>${credit}</figure>`;
  }
  return `<div class="floor-plan-unavailable" role="status"><span aria-hidden="true">${uiIcon('compass', { size: 22 })}</span><strong>${building.spaceKind === 'outdoor' ? '这处室外区域暂无平面资料' : '这层室内平面图还在核实绘制'}</strong><p>${building.spaceKind === 'outdoor' ? '当前没有可核验的区域平面图，不推测通行路线。' : '当前没有可核验的楼层平面图，因此暂不显示推测的房间布局。'}</p></div>`;
}

/** 地点详情页先展示完整场地；每个有平面图的建筑轮廓都可直接打开。 */
export function tourSectionHtml(place) {
  const tour = tourFor(place);
  const map = tour.overview || overviewFor(place);
  const indoorCoverage = (tour.buildings || []).reduce((result, building) => {
    const coverage = localFloorMapCoverage(building);
    return { total: result.total + coverage.totalFloors, mapped: result.mapped + coverage.mappedFloors };
  }, { total: 0, mapped: 0 });
  const coverageText = tour.visitContext === 'exterior' ? '仅提供建筑外观资料'
    : indoorCoverage.mapped ? `楼层图 ${indoorCoverage.mapped}/${indoorCoverage.total} · 已收录资料`
    : indoorCoverage.total ? '暂无可展示的楼层平面图'
    : (tour.buildings || []).length ? '建筑平面资料尚未收录' : '室外场地总览';
  const overviewHint = map.type === 'missing' ? '场地布局资料尚未收录'
    : tour.visitContext === 'exterior' ? '点建筑查看外观资料'
    : (tour.buildings || []).length ? '点建筑查看已收录资料' : '查看场地与周边布局';
  const mapLegend = map.type === 'missing'
    ? ''
    : `<div class="tour-map-actions"><span>${uiIcon('building', { size: 16 })}<span>${map.geographic ? '轮廓按实际方位' : '场地方位示意'}${indoorCoverage.mapped ? ' · 蓝色有室内图，灰色无室内图' : (tour.buildings || []).length ? ' · 点建筑查看资料' : ''}</span></span><small>${escapeHtml(coverageText)}</small></div>`;
  const unlocated = map.unlocatedBuildings?.length ? `<div class="site-map-unlocated"><p>以下建筑的位置还需核对，可先查看已收录资料：</p><div>${map.unlocatedBuildings.map(building => `<button type="button" class="btn-soft" data-action="open-building-plan" data-place="${escapeHtml(place.placeId)}" data-building="${escapeHtml(building.id)}">${escapeHtml(building.name)}</button>`).join('')}</div></div>` : '';
  return `<section class="card place-tour" aria-label="${escapeHtml(place.name)}全貌平面图">
    <header class="tour-map-header"><div><h3>景点全貌</h3></div><div class="tour-map-header-actions"><p>${escapeHtml(overviewHint)}</p>${map.type === 'missing' ? '' : `<button type="button" class="tour-map-zoom" data-action="zoom-place-overview" data-place-name="${escapeHtml(place.name)}" aria-label="放大${escapeHtml(place.name)}场地全貌图">放大地图</button>`}</div></header>
    <div class="tour-map-wrap">${siteOverviewSvg(place, map)}</div>
    ${mapLegend}
    ${unlocated}
    ${map.type === 'missing' ? '' : overviewEvidenceHtml(map)}
  </section>`;
}

/** 建筑平面图弹窗内容（含楼层切换）。 */
export function buildingSheetHtml(place, buildingId) {
  const plan = floorPlanFor(place, buildingId, floorViewOf(place, buildingId));
  const building = plan?.building || (tourFor(place).buildings || []).find(item => item.id === buildingId);
  if (building?.spaceKind === 'exterior') {
    return `<div class="sheet-head"><div class="building-reference-title"><h3>${escapeHtml(building.name)}</h3><p>外观资料</p></div><button type="button" data-action="close-sheet" class="icon-btn building-info-close" aria-label="关闭">${uiIcon('close',{size:20})}</button></div><div class="floor-plan-unavailable" data-building-exterior role="note"><span aria-hidden="true">${uiIcon('building',{size:22})}</span><strong>欣赏建筑外观</strong><p>${escapeHtml(building.visitNote || '当前仅有外观资料，没有已核实的公众室内参观平面资料。')}</p></div>`;
  }
  if (building?.spaceKind === 'outdoor' && !building.floorPlanImages?.length) {
    return `<div class="sheet-head"><div class="building-reference-title"><h3>${escapeHtml(building.name)}</h3><p>室外区域</p></div><button type="button" data-action="close-sheet" class="icon-btn building-info-close" aria-label="关闭">${uiIcon('close',{size:20})}</button></div><div class="floor-plan-unavailable" data-building-outdoor role="note"><span aria-hidden="true">${uiIcon('tree',{size:22})}</span><strong>室外区域资料</strong><p>${escapeHtml(building.floors?.map(floor=>floor.label).filter(Boolean).join('；') || '室外建筑与开放空间。')}</p><p>暂无可核验的室外平面资料，图中不推测通行路线。</p></div>`;
  }
  if (!plan || !plan.floor) {
    return `<div class="sheet-head"><h3>${escapeHtml(building?.name || place.name)} · 建筑资料</h3><button data-action="close-sheet" class="icon-btn" aria-label="关闭">×</button></div><div class="floor-plan-unavailable" role="status"><span aria-hidden="true">${uiIcon('building', { size: 22 })}</span><strong>暂无可展示的平面资料</strong><p>楼层数量与布局尚未核实，不展示推测的房间或楼层。可先参考场地总览与现场标识。</p></div>`;
  }
  const floorImage = (plan.building.floorPlanImages || []).find(item => item.floor === plan.floor.name);
  const localFloorImages = plan.building.floorPlanImages || [];
  const hasFloorVisuals = localFloorImages.length > 0;
  const tabs = hasFloorVisuals ? `<div class="floor-tabs" role="group" aria-label="${building.spaceKind === 'outdoor' ? '选择室外区域' : '选择楼层'}">${(plan.building.floors || []).map((floor, index) =>
    `<button type="button" class="${index === plan.floorIndex ? 'active' : ''}" aria-pressed="${index === plan.floorIndex}" data-action="switch-building-floor" data-place="${escapeHtml(place.placeId)}" data-building="${escapeHtml(buildingId)}" data-floor="${index}">${escapeHtml(floor.name)}</button>`).join('')}</div>` : '';
  const floorNotes = !hasFloorVisuals && plan.building.floors?.length > 1
    ? `<ul class="floor-level-list">${plan.building.floors.map(floor => `<li><strong>${escapeHtml(floor.name)}</strong><span>${escapeHtml(floor.label || '详见场馆导览')}</span></li>`).join('')}</ul>` : '';
  const floorNotice = floorImage?.notice || (floorImage ? `${plan.floor.label || plan.floor.name} · 平面图为伴途整理的参考示意，请以场馆现场标识为准。` : `${plan.floor.label || plan.floor.name} · 尚无可核验的楼层平面图，暂不展示推测布局。`);
  const floorHeading = floorImage?.kind === 'area-diagram' ? '功能示意' : floorImage ? building.spaceKind === 'outdoor' ? '室外平面图' : '平面图' : '楼层资料';
  const facilityLegend = floorImage && floorImage.kind !== 'area-diagram'
    ? `<div class="floor-plan-key" aria-label="设施标注说明"><span class="floor-plan-restroom-key"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="7" cy="5" r="2"/><circle cx="17" cy="5" r="2"/><path d="M4 9h6v6H9v6H7v-6H6v6H4ZM17 9l4 8h-2v4h-2v-4h-1v4h-2v-4h-2l4-8Z"/></svg>卫生间</span><span>${restroomEvidenceText(floorImage)}</span></div>`
    : '';
  return `<div class="sheet-head"><h3>${escapeHtml(plan.building.name)} · ${floorHeading}</h3><button data-action="close-sheet" class="icon-btn" aria-label="关闭">✕</button></div>
    ${tabs}
    ${floorNotes}
    ${mapEvidenceHtml(floorImage?.evidence)}
    ${facilityLegend}
    ${floorPlanContent(plan)}
    <div class="floor-plan-footnote"><p class="stop-meta">${escapeHtml(floorNotice)}</p></div>`;
}

/** 楼层视图状态：同一建筑在同一地点内记忆用户所在楼层。 */
const floorViewState = new Map();
function floorViewKey(place, buildingId) { return `${place.placeId}|${buildingId}`; }
function floorViewOf(place, buildingId) {
  return floorViewState.get(floorViewKey(place, buildingId)) || 0;
}
export function rememberBuildingFloor(place, buildingId, floorIndex) {
  floorViewState.set(floorViewKey(place, buildingId), floorIndex);
}
