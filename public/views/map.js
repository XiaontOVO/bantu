import { isFavorite } from '../lib/favorite-state.js';
import { state } from '../lib/store.js';
import { escapeHtml, facilityList } from '../lib/format.js';
import { TRANSPORT_MODES } from '../lib/transport-modes.js';
import { transportPickerHtml } from '../lib/transport-picker.js';
import { isFreshCurrentLocation } from '../lib/location.js';

export function planStops() {
  const timezone = 'Asia/Shanghai';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const selectedDate = state.planViewDate || today;
  const dayPlan = mapDayPlan(selectedDate);
  return (dayPlan?.stops || []).filter(stop => stop.status !== 'skipped' && (stop.place?.placeId || stop.placeId));
}
export function mapDayPlan(date) {
  const timezone = 'Asia/Shanghai';
  const selectedDate = date || state.planViewDate || new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const datedPlans = (state.savedPlans || []).filter(plan => plan.kind === 'plan' && plan.localDate === selectedDate);
  if (datedPlans.length === 1) return datedPlans[0];
  // 兼容尚未完成迁移的旧旅行快照；日计划模式本身不依赖 Trip，这只是迁移失败时的只读兜底。
  if (!datedPlans.length && state.trip?.snapshot) {
    const legacyDate = state.mountedDate || state.trip.trip?.localDate || state.trip.snapshot.localDate || '';
    if (!legacyDate || legacyDate === selectedDate) {
      return {
        id: state.trip.trip?.tripId || 'legacy-trip-plan',
        revision: state.trip.trip?.revision || 0,
        kind: 'plan', localDate: selectedDate,
        stops: state.trip.snapshot.stops || [],
        routeLegs: state.trip.snapshot.routeLegs || [],
      };
    }
  }
  return null;
}
function directoryIndex() {
  return new Map([...(state.places || []), ...(state.mapPlaces || [])].map(place => [place.placeId, place]));
}
function stopPlaceId(stop) {
  return stop.place?.placeId || stop.placeId;
}
function normalizedPlaceName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, '') : '';
}
/**
 * Resolves legacy imported-stop IDs through the canonical place directory.
 * Shared-plan IDs identify stop occurrences, not catalog places; their embedded
 * name is only used as a fallback when it matches exactly one directory entry.
 */
export function mapPlaceForStop(stop, directory = directoryIndex()) {
  const id = stopPlaceId(stop);
  const byId = id ? directory.get(id) : null;
  if (byId) return byId;
  const name = normalizedPlaceName(stop.place?.name || stop.name);
  if (!name) return null;
  const matches = [...directory.values()].filter(place => normalizedPlaceName(place.name) === name);
  return matches.length === 1 ? matches[0] : null;
}
/** 行程只提供地点 ID 和顺序；地点名称、坐标、设施统一从地点目录解析。 */
export function mapPlaces() {
  return plannedMapPlaces().map((place, index) => ({
    ...place,
    inPlan: true,
    planOrder: index + 1,
  }));
}
export function plannedMapPlaces() {
  const directory = directoryIndex();
  const seen = new Set();
  return planStops().flatMap(stop => {
    const place = mapPlaceForStop(stop, directory);
    const id = place?.placeId || stopPlaceId(stop);
    if (seen.has(id)) return [];
    seen.add(id);
    return place ? [place] : [];
  });
}
export function renderMap() {
  const places = mapPlaces();
  const stops = planStops();
  const routePlaces = plannedMapPlaces();
  const coordinatePlaces = places.filter(place => place.coordinates);
  const plannedCoordinates = stops.filter(stop => stop.status !== 'skipped' && mapPlaceForStop(stop, directoryIndex())?.coordinates);
  const coordinateIds = new Set(coordinatePlaces.map(place => place.placeId));
  const hasCurrentLocation = isFreshCurrentLocation(state.currentLocation);
  // 未定位时保留空起点，避免把第一站同时当作起点和终点。
  const customOrigin = state.mapCustomFrom?.coordinates ? state.mapCustomFrom : null;
  const defaultFrom = state.mapFrom === 'my-location' && hasCurrentLocation
    ? 'my-location'
    : state.mapFrom === 'map-point-from' && customOrigin ? 'map-point-from'
      : coordinateIds.has(state.mapFrom) ? state.mapFrom : hasCurrentLocation ? 'my-location' : '';
  const customDestination = state.mapTo === 'map-point-to' ? state.mapCustomTo : null;
  const destinationPlaces = customDestination?.coordinates ? [...coordinatePlaces, customDestination] : coordinatePlaces;
  const defaultTo = destinationPlaces.some(place => place.placeId === state.mapTo)
    ? state.mapTo
    : '';
  // 设备定位是默认背景起点，不是一个需要在选择面板里再次挑选的地点。
  // 用 disabled + hidden 的选项保留 select 的显示值，同时自绘 picker 不会把它列为可选项。
  const optionList = (options, selectedId, prompt, hiddenDefaults = []) => {
    const selected = options.some(place => place.placeId === selectedId);
    const hidden = !selected && hiddenDefaults.find(place => place.placeId === selectedId);
    return `<option value="" disabled hidden ${selectedId ? '' : 'selected'}>${prompt}</option>${hidden ? `<option value="${escapeHtml(hidden.placeId)}" disabled hidden selected>${escapeHtml(hidden.name)}</option>` : ''}${options.map(place => `<option value="${escapeHtml(place.placeId)}" ${selectedId === place.placeId ? 'selected' : ''}>${escapeHtml(place.name)}</option>`).join('')}`;
  };
  const fromPlaces = [...(customOrigin ? [customOrigin] : []), ...coordinatePlaces];
  const fromOptions = optionList(fromPlaces, defaultFrom, '选择起点', [{ placeId: 'my-location', name: '我的位置' }]);
  const toOptions = optionList(destinationPlaces, defaultTo, '选择终点');
  const placesById = new Map(places.map(place => [place.placeId, place]));
  const resolvedStops = stops.map(stop => mapPlaceForStop(stop, placesById));
  const missingStops = stops.filter((_, index) => !resolvedStops[index]);
  const planLine = stops.length ? `<p class="stop-meta">当前计划顺序：${stops.map((stop, index) => `${index + 1}. ${escapeHtml(resolvedStops[index]?.name || '地点已下架')}`).join(' → ')}</p>` : '<p class="stop-meta">当前还没有行程计划；地点加入计划后会在这里按顺序显示。</p>';
  const missingPlaceNotice = missingStops.length ? `<p class="stop-meta" role="status">${missingStops.length} 个计划地点已不在地点目录中；地图与路线不会使用行程快照里的旧资料。</p>` : '';
  const listBody = places.length
    ? `<div class="place-grid map-place-grid">${places.map((place, index) => {
      const facilities = facilityList(place.facilityCodes);
      const locationSummary = place.coordinates ? `已标注位置${distanceLabel(place)}` : '坐标未知，暂不能在地图定位';
      const isFrom = state.mapFrom === place.placeId, isTo = state.mapTo === place.placeId;
      const startFree = !state.mapFrom || state.mapFrom === 'my-location';
      const endFree = !state.mapTo;
      let cls = 'btn-soft role-btn', label = '设为起终点';
      if (isFrom) { cls = 'btn-good'; label = '✓ 起点'; }
      else if (isTo) { cls = 'role-to'; label = '✓ 终点'; }
      else if (startFree) { label = '设为起点'; }
      else if (!endFree) { label = '设为终点'; }
      return `<article class="card map-place-card ${isFavorite(place.placeId) ? 'favorite-place' : ''}"><h3 class="map-place-title">${index + 1}. ${escapeHtml(place.name)}</h3><p class="stop-meta map-place-meta">${escapeHtml(locationSummary)}${facilities ? ` · ${escapeHtml(facilities)}` : ''}</p><div class="stop-actions map-place-actions"><button class="btn-small role-btn ${cls}" data-action="set-card-role" data-place="${escapeHtml(place.placeId)}" ${place.coordinates ? '' : 'disabled'} aria-pressed="${isFrom || isTo ? 'true' : 'false'}">${label}</button><button class="btn-small" data-action="open-place" data-place="${escapeHtml(place.placeId)}">地点详情</button></div></article>`;
    }).join('')}</div>`
    : '<p class="stop-meta">只有加入计划的地点才会显示在地图上。</p>';
  const wholeRouteActive = state.mapRouteView === 'entire';
  return `<div class="page-head"><div><h2>地图与路线</h2></div><button class="btn-soft" data-action="navigate" data-view="favorites">我的收藏</button></div>
    <section class="map-surface" aria-label="地图与地点"><div id="travel-map" class="travel-map" aria-label="旅行地点地图"></div><p id="map-status" class="stop-meta map-surface-status" role="status">正在加载地图…可在地图上选点规划路线。</p></section>
    <section class="card route-planner-card"><div class="route-controls"><div class="field"><label for="routeFrom">从哪里出发</label><select id="routeFrom" data-ui="picker">${fromOptions}</select></div><div class="field"><label for="routeTo">到哪里去</label><select id="routeTo" data-ui="picker">${toOptions}</select></div><div class="field transport-map-field"><label for="routeTransportPicker">交通方式</label>${transportPickerHtml(state.routeMode, { action: 'pick-map-mode', id: 'routeTransportPicker', compact: true })}<select id="routeMode" hidden aria-hidden="true" tabindex="-1">${TRANSPORT_MODES.map(mode => `<option value="${mode.value}" ${mode.value === state.routeMode ? 'selected' : ''}>${escapeHtml(mode.label)}</option>`).join('')}</select></div></div>
    ${planLine}${missingPlaceNotice}
    <div class="stop-actions"><button class="${wholeRouteActive ? 'btn-primary' : 'btn-soft'}" data-action="toggle-full-route" aria-pressed="${wholeRouteActive ? 'true' : 'false'}" aria-label="${wholeRouteActive ? '全程路线已开启，点击返回起终点路线' : '显示计划全程路线'}" ${!wholeRouteActive && plannedCoordinates.length < 2 ? 'disabled' : ''}>全程路线</button></div>
    <p class="stop-meta">${wholeRouteActive ? '全程按各站保存的交通方式规划，再点按钮返回起终点路线。' : '选定起点和终点后自动规划道路；点击“全程路线”可按各站交通方式查看全程。'} ${routeDisclaimer()}</p></section>
    <section id="route-result" class="card" style="margin-top:16px" aria-live="polite"><p>${routeSelectionIsValid(defaultFrom, defaultTo) ? '正在显示起终点路线…' : '请选择不同的起点和终点，路线会自动显示。'}</p></section>
    <div style="margin-top:16px">${listBody}</div>`;
}

function routeDisclaimer() {
  const source = state.mapConfig?.routeSource;
  if (source === 'openstreetmap') return '步行和驾车按 OpenStreetMap 道路网规划；不含实时路况，规划时会把起终点坐标发送给路线服务。公交路线会在高德导航中查看。';
  if (source === 'amap') return '路线由高德规划；规划时会把起终点坐标发送给高德，预计时间会随出发时段变化。';
  return '未确认路线服务状态；只展示服务返回的道路轨迹，缺少轨迹时提示重试。';
}

export function routeSelectionIsValid(from, to) {
  return Boolean(from && to && from !== to);
}

function distanceLabel(place) {
  const origin = state.currentLocation?.coordinates;
  if (!origin || !place.coordinates || typeof window === 'undefined' || !window.gcoord) return '';
  const dest = place.coordinates.source === 'amap' ? window.gcoord.transform([place.coordinates.lng, place.coordinates.lat], window.gcoord.GCJ02, window.gcoord.WGS84) : [place.coordinates.lng, place.coordinates.lat];
  const rad = n => n * Math.PI / 180;
  const a = Math.sin(rad(dest[1] - origin.lat) / 2) ** 2 + Math.cos(rad(origin.lat)) * Math.cos(rad(dest[1])) * Math.sin(rad(dest[0] - origin.lng) / 2) ** 2;
  return ` · 距起点直线约 ${(6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)))).toFixed(1)} 公里`;
}
