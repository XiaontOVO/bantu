import { isFavorite } from './favorite-state.js';
import { api } from './api.js';
import { $, state, tripId, tripRevision } from './store.js';
import { cityNameOf } from './cities.js';
import { cityName, escapeHtml, placeIdHtml } from './format.js';
import { closeSheet, toast } from './ui.js';
import { navigate, render } from './render.js';
import { loadTrip } from './loaders.js';
import { loadFavorites } from './favorites.js';
import { loadTracked } from './load-state.js';
import { mapPlaces, mapPlaceForStop, mapDayPlan, plannedMapPlaces, planStops, routeSelectionIsValid } from '../views/map.js';
import { startLocation, requestCurrentLocation, isFreshCurrentLocation, getLocationStatus } from './location.js';
import { baseMapPoint, mapDistanceMeters, validMapPoint } from './map-coordinates.js';
import { roadRoutePath } from './map-route-geometry.js';
import { TRANSPORT_LABELS as modes } from './transport-modes.js';
import { syncTransportPicker } from './transport-picker.js';
import { addMapZoomControl, addMapLocateControl } from './map-controls.js';
import { saveStopTransport, stopTransportMode } from './stop-transport.js';

let map, routeLayer, requestSequence = 0, mapGeneration = 0, mapDataSequence = 0;
let locationMarker = null, accuracyCircle = null, mapOwner = '', mapView = null, mapTouched = false;
let routeController = null, routeTimer = null, routePending = false, lastOrigin = null, lastRouteAt = 0;
let setMapStatus = () => {}, locationTimer = null, mapLocatePending = false, mapLocateController = null;
let locateIntentRevision = 0;
const point = place => place?.coordinates;
// 底图为高德瓦片（GCJ02 坐标系）：内部统一存 WGS84，显示时转成 GCJ02；高德来源的坐标原样使用。
function onBaseMap(coords, crs) {
  return baseMapPoint(coords, crs);
}
function navigationLink(place, mode = 'walking', origin) {
  if (!validMapPoint(point(place))) return '';
  const destination = baseMapPoint(point(place));
  const xy = [destination[1],destination[0]];
  const from = validMapPoint(point(origin)) ? baseMapPoint(point(origin)) : null;
  const start = from ? [from[1],from[0]] : null;
  return `https://uri.amap.com/navigation?${start ? `from=${start[0]},${start[1]},${encodeURIComponent(origin.name)}&` : ''}to=${xy[0]},${xy[1]},${encodeURIComponent(place.name)}&mode=${mode === 'walking' ? 'walk' : mode === 'driving' ? 'car' : 'bus'}&coordinate=gaode&callnative=1`;
}
export async function loadMapData() {
  const sequence = ++mapDataSequence;
  const owner = state.principal?.principalId;
  const isCurrentMapLoad = () => sequence === mapDataSequence && owner === state.principal?.principalId;
  // Use the selected city's directory; keep old responses from replacing a newer load.
  const places = [];
  let cursor = '';
  let pageCount = 0;
  // 地图目录跟随当前计划的城市（T 城市扩展）：配置接口短暂不可用时仍可打开地图和地点，
  // 路线模式会按保守的步行/驾车能力工作，不让一个辅助接口把整页卡死。
  // 城市范围：用户显式选择优先，否则跟随当前计划的城市。
  const planCity = state.mapCity || mapDayPlan(state.planViewDate)?.cityCode || state.trip?.trip?.cityCode || '';
  const fallbackConfig = {
    cityCode: planCity || '310100',
    districtAdcode: planCity === '310100' || !planCity ? '310104' : planCity,
    cityName: `${cityNameOf(planCity) || '上海'}市`,
    districtName: planCity && planCity !== '310100' ? '全市' : '徐汇区',
    routeModes: ['walking', 'driving'], routeSource: 'demo',
  };
  const [config] = await Promise.all([
    api(`/api/v1/map-config?cityCode=${encodeURIComponent(planCity)}`).catch(() => fallbackConfig),
    loadTracked('favorites', loadFavorites),
  ]);
  if (!isCurrentMapLoad()) return;
  const city = encodeURIComponent(config.cityCode || '310100');
  const district = encodeURIComponent(config.districtAdcode || '310104');
  do {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await api(`/api/v1/places?limit=50&cityCode=${city}&districtAdcode=${district}${suffix}`, {}, true);
    if (!isCurrentMapLoad()) return;
    places.push(...(page.data || []));
    cursor = page.meta?.nextCursor ?? '';
    pageCount += 1;
  } while (cursor && pageCount < 100);
  state.mapPlaces = places;
  state.mapConfig = config;
}
export function disposeMap({ cancelData = true } = {}) {
  if (map && !cancelData && mapOwner === state.principal?.principalId) mapView = { center:map.getCenter(), zoom:map.getZoom(), touched:mapTouched };
  else if (cancelData) mapView = null;
  mapGeneration++;
  if (cancelData) mapDataSequence++;
  requestSequence++;
  cancelRouteRequest();
  mapLocateController?.abort(); mapLocateController = null; mapLocatePending = false;
  clearInterval(locationTimer); locationTimer = null;
  locationMarker = null; accuracyCircle = null;
  if (map) map.remove(); map = null; routeLayer = null;
}
function updateFullRouteButton() {
  const button = document.querySelector('[data-action="toggle-full-route"]');
  if (!button) return;
  const active = state.mapRouteView === 'entire';
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', active ? '全程路线已开启，点击返回起终点路线' : '显示计划全程路线');
  button.classList.toggle('btn-primary', active);
  button.classList.toggle('btn-soft', !active);
}
function showRoutePrompt(message) {
  clearRoute(message);
}
function refreshVisibleRoute({ fit = true } = {}) {
  if (state.mapRouteView === 'entire') return calculateTripRoute({ fit });
  const from = $('routeFrom')?.value || '';
  const to = $('routeTo')?.value || '';
  if (!routeSelectionIsValid(from, to)) {
    showRoutePrompt('请选择不同的起点和终点，路线会自动显示。');
    return Promise.resolve();
  }
  return calculateRoute({ fit });
}
function handleRouteError(error) {
  if (state.currentView === 'map' && !state.accountContextChanged && error?.name !== 'AbortError') routeFailure(error?.message);
}

function cancelRouteRequest() {
  routeController?.abort(); routeController = null;
  clearTimeout(routeTimer); routeTimer = null; routePending = false;
}
function routeFailure(message = '道路路线未能取得，请检查起终点位置后重试。') {
  const result = $('route-result');
  if (result) result.innerHTML = `<p role="status">${escapeHtml(message)}</p><p class="stop-meta">未取得实际道路轨迹，不绘制起终点连线。</p><button class="btn-soft" data-action="retry-map-route">重新规划</button>`;
}
export function cancelMapRoute({ feedback = true } = {}) {
  requestSequence++; cancelRouteRequest();
  if (feedback) routeFailure('本次道路查询已取消。');
}
export function retryMapRoute() { return refreshVisibleRoute(); }
function requestContext(origin, from, to, mode, entireTrip = false) {
  const plan = mapDayPlan();
  return { owner:state.principal?.principalId, mapGeneration, navigationRevision:state.navigationRevision,
    tripId:tripId(), revision:tripRevision(), planId:plan?.id || '', planRevision:plan?.revision || 0,
    origin:origin ? structuredClone(origin) : null, mapFrom:from, mapTo:to, mode, entireTrip };
}
function routeContextCurrent(context) {
  const plan = mapDayPlan();
  return Boolean(map && state.currentView === 'map' && !state.accountContextChanged && !document.hidden &&
    context.owner === state.principal?.principalId && context.mapGeneration === mapGeneration && context.navigationRevision === state.navigationRevision &&
    context.tripId === tripId() && context.revision === tripRevision() && context.planId === (plan?.id || '') && context.planRevision === (plan?.revision || 0) &&
    context.mode === state.routeMode && context.entireTrip === (state.mapRouteView === 'entire') &&
    (context.entireTrip || (context.mapFrom === state.mapFrom && context.mapTo === state.mapTo &&
      (context.mapFrom !== 'my-location' || (isFreshCurrentLocation(state.currentLocation) && mapDistanceMeters(point(context.origin), point(state.currentLocation)) <= 40)))));
}
function routePreviewCurrent(preview) {
  return routeContextCurrent({ ...preview, mapGeneration, navigationRevision:state.navigationRevision });
}
function routeReceiptCurrent(pending) {
  if (pending.current()) return true;
  if (pending.sequence === requestSequence && map && state.currentView === 'map' && !state.accountContextChanged && !document.hidden)
    routeFailure('计划或起点位置已变化，请按最新信息重新规划。');
  return false;
}
function beginRouteRequest(context, message) {
  const controller = new AbortController(), sequence = ++requestSequence;
  routeController = controller; routePending = true;
  routeTimer = setTimeout(() => controller.abort(new DOMException('道路服务响应超时，请重试。','TimeoutError')),25000);
  $('route-result').innerHTML = `<div class="route-query-status"><p>${escapeHtml(message)}</p><button class="btn-soft" data-action="cancel-map-route">取消查询</button></div>`;
  return { controller, sequence, current:() => sequence === requestSequence && routeContextCurrent(context) };
}
function finishRouteRequest(controller) {
  if (routeController !== controller) return;
  clearTimeout(routeTimer); routeTimer = null; routeController = null; routePending = false;
}
function rememberSelectedStopMode(destinationId, mode = state.routeMode) {
  if (!destinationId || !mode) return;
  const stop = planStops().find(item => mapPlaceForStop(item)?.placeId === destinationId);
  if (!stop) return;
  state.stopModes = state.stopModes || {};
  state.stopModes[stop.stopId] = mode;
}
export function mountMap() {
  disposeMap({ cancelData:false });
  const generation = mapGeneration;
  const node = $('travel-map');
  if (!node) return;
  if (!window.L || !window.gcoord) { $('map-status').textContent = '地图组件未加载，请刷新页面。'; return; }
  const L = window.L;
  mapOwner = state.principal?.principalId;
  const freshLocation = isFreshCurrentLocation(state.currentLocation) ? state.currentLocation : null;
  const places = mapPlaces().filter(place => validMapPoint(point(place)));
  const initialCenter = point(freshLocation) || point(places[0]) || { lat:31.192304, lng:121.432458 };
  map = L.map(node, { scrollWheelZoom:false, zoomControl:false, zoomAnimation:false, fadeAnimation:false, markerZoomAnimation:false }).setView(onBaseMap(initialCenter), 14);
  mapTouched = Boolean(mapView?.touched);
  const zoomControl = addMapZoomControl(map, L);
  zoomControl.getContainer().addEventListener('pointerdown', () => { mapTouched = true; });
  addMapLocateControl(map, L);
  map.on('dragstart', () => { mapTouched = true; });
  map.on('popupopen', () => { mapTouched = true; });
  map.on('zoomstart', event => { if (event.originalEvent) mapTouched = true; });
  node.addEventListener('wheel', () => { mapTouched = true; }, { passive:true });
  node.addEventListener('keydown', event => { if (['+', '-', '=', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) mapTouched = true; });
  let tileFailed = false;
  setMapStatus = message => {
    const status = $('map-status');
    if (generation === mapGeneration && status) status.textContent = `${tileFailed ? '底图加载失败，可重试定位或继续选择地点。 ' : ''}${message || '可拖动、缩放地图，点击站点或地图位置规划道路路线。'}`;
  };
  const tiles = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', { maxZoom:18, subdomains:['1','2','3','4'], attribution:'高德地图 · GCJ02 坐标系' }).addTo(map);
  tiles.on('tileerror', () => { tileFailed = true; syncMapLocation({ recalculate:false }); });
  tiles.on('load', () => syncMapLocation({ recalculate:false }));
  map.on('click', event => {
    const {lat, lng} = event.latlng;
    const internal = window.gcoord.transform([lng,lat], window.gcoord.GCJ02, window.gcoord.WGS84);
    L.popup({maxHeight:Math.max(100,node.clientHeight-95),autoPanPadding:[12,14],keepInView:true,className:'bantu-place-popup'}).setLatLng(event.latlng).setContent(`<p>选中位置：${internal[1].toFixed(5)}, ${internal[0].toFixed(5)}</p><p><button data-action="map-pick-origin" data-lat="${internal[1]}" data-lng="${internal[0]}">选为起点</button> <button data-action="map-pick-endpoint" data-lat="${internal[1]}" data-lng="${internal[0]}">选为终点</button></p>`).openOn(map);
  });
  for (const id of ['routeFrom','routeTo','routeMode']) $(id)?.addEventListener('change', () => {
    if (id === 'routeFrom' || (id !== 'routeMode' && state.mapRouteView === 'entire')) locateIntentRevision++;
    state.mapFrom = $('routeFrom').value; state.mapTo = $('routeTo').value; state.routeMode = $('routeMode').value;
    syncTransportPicker(document.querySelector('[data-action="pick-map-mode"]'), state.routeMode);
    if (id === 'routeMode') state.routeModeSelected = true;
    if (id === 'routeMode' || (id === 'routeTo' && state.routeModeSelected)) rememberSelectedStopMode(state.mapTo, state.routeMode);
    if (id !== 'routeMode') state.mapRouteView = 'endpoints';
    mapTouched = false;
    updateFullRouteButton(); updateRoleButtons();
    refreshVisibleRoute().catch(handleRouteError);
  });
  const bounds = [];
  places.forEach((place, index) => {
    const coords = onBaseMap(point(place)); bounds.push(coords);
    const identifier = placeIdHtml(place);
    L.marker(coords, { icon:L.divIcon({ className:`map-number${place.inPlan ? ' is-plan' : ''} ${isFavorite(place.placeId) ? 'is-favorite' : ''}`, html:String(index+1), iconSize:[28,28] }) }).addTo(map)
      .bindPopup(`<strong>${escapeHtml(place.name)}</strong>${identifier ? `<p class="map-place-id">${identifier}${place.inPlan ? ` · 第 ${place.planOrder} 站` : ''}</p>` : ''}<p><button data-action="map-origin" data-place="${escapeHtml(place.placeId)}">设为起点</button> <button data-action="map-destination" data-place="${escapeHtml(place.placeId)}">设为终点</button></p><p><button data-action="open-place" data-place="${escapeHtml(place.placeId)}">地点详情</button></p>`,{maxHeight:Math.max(100,node.clientHeight-95),autoPanPadding:[12,14],keepInView:true,className:'bantu-place-popup'});
  });
  if (freshLocation) bounds.push(onBaseMap(point(freshLocation)));
  if (mapView) map.setView(mapView.center, mapView.zoom, { animate:false });
  else if (bounds.length) map.fitBounds(bounds, { padding:[35,35], maxZoom:15, animate:false });
  if (!['walking','transit','driving'].includes(state.routeMode)) state.routeMode = 'walking';
  if ($('routeMode')) $('routeMode').value = state.routeMode;
  syncTransportPicker(document.querySelector('[data-action="pick-map-mode"]'), state.routeMode);
  state.mapFrom = $('routeFrom').value || ''; state.mapTo = $('routeTo').value || '';
  if (state.mapRouteView === 'entire' && planStops().filter(stop => validMapPoint(point(mapPlaceForStop(stop)))).length < 2) state.mapRouteView = 'endpoints';
  updateFullRouteButton(); syncMapLocation({ recalculate:false });
  void startLocation();
  locationTimer = setInterval(() => syncMapLocation(), 5000);
  const preview = state.routePreview;
  if (preview && routePreviewCurrent(preview)) showRouteResult(preview, { fit:!mapView });
  else { state.routePreview = null; refreshVisibleRoute().catch(handleRouteError); }
}

export function syncMapLocation({ recalculate = true } = {}) {
  if (!map || state.currentView !== 'map' || mapOwner !== state.principal?.principalId || state.accountContextChanged || document.hidden) return;
  const fresh = isFreshCurrentLocation(state.currentLocation);
  if (!fresh) {
    if (locationMarker) map.removeLayer(locationMarker);
    if (accuracyCircle) map.removeLayer(accuracyCircle);
    locationMarker = null; accuracyCircle = null;
    const status = getLocationStatus();
    setMapStatus(status.message || '等待新的设备定位；可点击定位按钮重试或在地图上设置起点。');
    if (state.mapFrom === 'my-location' && (routePending || state.routePreview)) clearRoute('当前位置已失效，请重新定位或在地图上设置起点。');
    return;
  }
  const coordinates = point(state.currentLocation), converted = onBaseMap(coordinates);
  if (locationMarker) locationMarker.setLatLng(converted);
  else locationMarker = window.L.circleMarker(converted, { radius:8, color:'#fff', weight:3, fillColor:'#2878f0', fillOpacity:1 }).addTo(map).bindPopup('<strong>设备当前位置</strong>');
  if (accuracyCircle) { accuracyCircle.setLatLng(converted); accuracyCircle.setRadius(coordinates.accuracyMeters); }
  else accuracyCircle = window.L.circle(converted, { radius:coordinates.accuracyMeters, color:'#397af4', weight:1, opacity:.35, fillOpacity:.06, interactive:false }).addTo(map);
  const routeFrom = $('routeFrom');
  if (routeFrom) {
    let option = [...routeFrom.options].find(item => item.value === 'my-location');
    if (!option) { option = document.createElement('option'); option.value = 'my-location'; option.textContent = '我的位置'; routeFrom.prepend(option); }
    option.disabled = true; option.hidden = true;
    if (!routeFrom.value || state.mapFrom === 'my-location') { state.mapFrom = 'my-location'; routeFrom.value = 'my-location'; }
  }
  setMapStatus(`设备定位误差约 ${Math.round(coordinates.accuracyMeters)} 米${coordinates.accuracyMeters > 50 ? '，蓝色范围表示定位误差，可在地图上手动修正起点。' : '，蓝点随新位置更新。'}`);
  const locate = document.querySelector('[data-action="map-locate"]');
  if (locate) locate.setAttribute('aria-busy', String(mapLocatePending));
  if (recalculate && !routePending && !mapLocatePending && state.mapRouteView !== 'entire' && state.mapFrom === 'my-location' && $('routeTo')?.value &&
      (!lastOrigin || (Date.now()-lastRouteAt >= 15000 && mapDistanceMeters(lastOrigin, coordinates) >= 30)))
    void refreshVisibleRoute({ fit:false }).catch(handleRouteError);
}

export async function locateMap() {
  if (!map || mapLocatePending) return;
  const generation = mapGeneration, owner = state.principal?.principalId, intentRevision = locateIntentRevision;
  const isCurrentLocate = () => map && generation === mapGeneration && owner === state.principal?.principalId &&
    state.currentView === 'map' && !state.accountContextChanged && !document.hidden && intentRevision === locateIntentRevision;
  const controller = new AbortController(); mapLocateController = controller;
  mapLocatePending = true; setMapStatus('正在重新获取设备位置…');
  const button = document.querySelector('[data-action="map-locate"]');
  if (button) { button.disabled = true; button.setAttribute('aria-busy','true'); }
  try {
    const place = await requestCurrentLocation({ force:true, timeout:15000, signal:controller.signal });
    // A new GPS fix still belongs to the shared location channel, but a later
    // manual origin or full-route choice owns the map's selection and camera.
    if (!isCurrentLocate()) return;
    mapTouched = false;
    map.setView(onBaseMap(point(place)), Math.max(map.getZoom(),15), { animate:false });
    state.mapFrom = 'my-location'; state.mapRouteView = 'endpoints';
    syncMapLocation({ recalculate:false }); updateFullRouteButton();
    await refreshVisibleRoute();
  } catch (error) { if (isCurrentLocate() && !controller.signal.aborted) { setMapStatus(error.message || '定位失败，请允许定位或在地图上设置起点。'); toast(error.message || '定位失败，请重试。','error'); } }
  finally { if (mapLocateController === controller) { mapLocateController = null; mapLocatePending = false; } if (button?.isConnected) { button.disabled = false; button.setAttribute('aria-busy','false'); } }
}

if (typeof window !== 'undefined') {
  window.addEventListener('bantu:location-updated', () => syncMapLocation());
  window.addEventListener('bantu:location-state', () => syncMapLocation({ recalculate:false }));
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.hidden && map) { mapLocateController?.abort(); cancelMapRoute({ feedback:false }); }
  else if (state.currentView === 'map') { syncMapLocation(); if (!routePending) void refreshVisibleRoute().catch(handleRouteError); }
});

export async function openMap(id) {
  state.mapTo = id || ''; state.routePreview = null;
  await loadMapData(); closeSheet(); navigate('map');
}
export function selectStopRoute(id) {
  // In standalone planning mode, planStops() reads the selected saved day plan;
  // with an executed trip it continues to read the trip snapshot.
  const stops = planStops();
  const index = stops.findIndex(stop => stop.stopId === id);
  if (index < 0) throw new Error('地点不在当前计划中。');
  const hasCurrentLocation = isFreshCurrentLocation(state.currentLocation);
  const previous = index > 0 ? mapPlaceForStop(stops[index - 1]) : null;
  if (index > 0 && !previous && !hasCurrentLocation) throw new Error('上一站不在徐汇地点目录中，暂时无法规划路线。');
  const destination = mapPlaceForStop(stops[index]);
  if (!destination) throw new Error('这个计划地点不在徐汇地点目录中，暂时无法规划路线。');
  locateIntentRevision++;
  state.mapFrom = hasCurrentLocation ? 'my-location' : previous?.placeId || '';
  const dayPlan = mapDayPlan();
  state.routeMode = stopTransportMode(stops[index], dayPlan || state.trip?.snapshot);
  state.routeModeSelected = true;
  state.mapRouteView = 'endpoints';
  state.mapTo = destination.placeId;
  state.routePreview = null;
  return { from: state.mapFrom, to: state.mapTo, mode: state.routeMode };
}
export async function routeToStop(id) {
  await loadMapData();
  selectStopRoute(id);
  closeSheet();
  navigate('map');
}
function syncRoleControls() {
  if ($('routeFrom')) $('routeFrom').value = state.mapFrom || '';
  if ($('routeTo')) $('routeTo').value = state.mapTo || '';
  updateRoleButtons();
  updateFullRouteButton();
  refreshVisibleRoute().catch(handleRouteError);
}

/** 设定地点角色：点击在 起点/终点/清除 间切换；起点被占用时其它卡片只能设终点。 */
export function setCardRole(placeId) {
  const previousFrom = state.mapFrom, previousView = state.mapRouteView;
  if (state.mapFrom === placeId) { state.mapFrom = ''; }
  else if (state.mapTo === placeId) { state.mapTo = ''; }
  else if (!state.mapFrom || state.mapFrom === 'my-location') { state.mapFrom = placeId; }
  else if (!state.mapTo) { state.mapTo = placeId; }
  else { state.mapTo = placeId; }
  if (previousFrom !== state.mapFrom || previousView === 'entire') locateIntentRevision++;
  state.mapRouteView = 'endpoints';
  syncRoleControls();
  const status = $('map-status');
  if (status) {
    status.textContent = state.mapFrom === placeId ? '已设为路线起点。'
      : state.mapTo === placeId ? '已设为路线终点。' : '已清除该地点的起终点设置。';
  }
}

/** 刷新所有卡片角色按钮（label/可用性随全局占用状态变化）。 */
export function updateRoleButtons() {
  document.querySelectorAll('[data-action="set-card-role"]').forEach((btn) => {
    const id = btn.dataset.place;
    const isFrom = state.mapFrom === id, isTo = state.mapTo === id;
    const startFree = !state.mapFrom || state.mapFrom === 'my-location';
    const endFree = !state.mapTo;
    btn.classList.toggle('btn-good', isFrom);
    btn.classList.toggle('role-to', isTo);
    btn.setAttribute('aria-pressed', String(isFrom || isTo));
    if (isFrom) { btn.textContent = '✓ 起点'; btn.hidden = false; }
    else if (isTo) { btn.textContent = '✓ 终点'; btn.hidden = false; }
    else if (startFree) { btn.textContent = '设为起点'; btn.hidden = false; }
    else if (endFree) { btn.textContent = '设为终点'; btn.hidden = false; }
    else { btn.hidden = true; }
  });
}
/** 待出发站点直接选交通方式：按上一站→本站计算路线腿并保存进快照。 */
export async function setStopTransport(stopId, mode) {
  if (!['walking', 'transit', 'driving'].includes(mode)) throw new Error('请选择有效的交通方式。');
  const saved = mapDayPlan();
  if (saved?.kind === 'plan' && state.savedPlans?.some(plan => plan.id === saved.id)) {
    return saveStopTransport(saved, stopId, mode);
  }
  state.stopModes = state.stopModes || {};
  state.stopModes[stopId] = mode;
  state.routeMode = mode;
  state.routeModeSelected = true;
  render();
  await loadMapData();
  const directory = new Map(mapPlaces().map(place => [place.placeId, place]));
  // 日计划是当前产品的默认执行容器，不需要先创建旧版 Trip。
  // 仍保留旧快照分支，方便尚未迁移的历史页面完成一次性兼容。
  const dayPlan = mapDayPlan();
  // The compatibility fallback in mapDayPlan uses the legacy trip id too.
  // Only account-owned saved plans may be written through /plans; otherwise
  // an old snapshot would be sent to the wrong endpoint.
  const standalone = Boolean(dayPlan?.kind === 'plan' && dayPlan?.id &&
    (state.savedPlans || []).some(plan => plan.id === dayPlan.id && plan.kind === 'plan'));
  const sourceStops = standalone ? (dayPlan.stops || []) : (state.trip?.snapshot?.stops || []);
  const stops = sourceStops.filter(stop => stop.status !== 'skipped').map(stop => {
    return { ...stop, place: mapPlaceForStop(stop, directory) };
  });
  const index = stops.findIndex(stop => stop.stopId === stopId);
  const stop = stops[index];
  if (!stop) throw new Error('地点不在当前计划中。');
  if (!stop.place) throw new Error('这个计划地点不在徐汇地点目录中，暂时无法规划路线。');
  if (index > 0 && !stops[index - 1].place) throw new Error('上一站不在徐汇地点目录中，暂时无法规划路线。');
  // 首站出发前可能尚未定位；先保留交通方式，真正出发时再用最新位置规划。
  if (index === 0 && !isFreshCurrentLocation(state.currentLocation)) { render(); return; }
  if (mode === 'transit' && !state.mapConfig?.routeModes?.includes('transit')) { render(); return; }
  // 首站：从我的位置出发；非首站：从上一站出发。
  let previous;
  if (index > 0) previous = stops[index - 1];
  else {
    if (!isFreshCurrentLocation(state.currentLocation)) throw new Error('请先重新定位或设一个起点。');
    previous = { stopId: 'my-location', place: state.currentLocation };
  }
  const result = await estimate(previous.place, stop.place, mode);
  const leg = { ...(result.leg || {}), fromStopId: previous.stopId, toStopId: stopId };
  const routeLegs = [...(standalone ? (dayPlan.routeLegs || []) : (state.trip?.snapshot?.routeLegs || []))
    .filter(item => item.toStopId !== stopId), leg];
  if (standalone) {
    await api(`/api/v1/plans/${encodeURIComponent(dayPlan.id)}`, { method: 'PUT', body: JSON.stringify({
      name: dayPlan.name,
      cityCode: dayPlan.cityCode || '310100',
      timezone: dayPlan.timezone || 'Asia/Shanghai',
      localDate: dayPlan.localDate,
      snapshot: {
        stops: dayPlan.stops || [],
        routeLegs,
        plannedCharges: dayPlan.plannedCharges || [],
      },
    }) });
    await import('./plan-library.js').then(module => module.loadPlans());
  } else {
    const target = tripId();
    if (!target || !state.trip) throw new Error('当前没有可更新的日计划，请先打开计划与进度。');
    await api(`/api/v1/trips/${target}/plan-edits`, { method: 'POST', body: JSON.stringify({
      expectedRevision: tripRevision(), allowPast: true, routeLegs,
    }) });
    await loadTrip(target).catch(() => {});
  }
  render();
}
export function setMapOrigin(id) {
  locateIntentRevision++;
  mapTouched = false; map?.closePopup();
  state.mapRouteView = 'endpoints';
  state.mapFrom = id; if ($('routeFrom')) $('routeFrom').value = id;
  const place = mapPlaces().find(item => item.placeId === id);
  if (point(place) && map) map.setView(onBaseMap(point(place)), 15);
  updateFullRouteButton();
  updateRoleButtons();
  refreshVisibleRoute().catch(handleRouteError);
}
/** 把地图上点选的坐标设为终点（虚拟地点，仅参与本次路线计算）。 */
export function pickMapEndpoint(button) {
  const lat = Number(button.dataset.lat), lng = Number(button.dataset.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('位置坐标无效。');
  if (state.mapRouteView === 'entire') locateIntentRevision++;
  mapTouched = false; map?.closePopup();
  state.routeMode = $('routeMode').value;
  state.mapRouteView = 'endpoints';
  state.mapCustomTo = { placeId: 'map-point-to', name: '地图选定的终点', coordinates: { lat, lng, source: 'manual' } };
  state.mapTo = 'map-point-to';
  if ($('routeTo')) {
    const select = $('routeTo');
    let opt = [...select.options].find(option => option.value === 'map-point-to');
    if (!opt) { opt = document.createElement('option'); opt.value = 'map-point-to'; opt.textContent = '地图选定的终点'; select.appendChild(opt); }
    select.value = 'map-point-to';
  }
  if (map) map.setView(onBaseMap({ lat, lng }), 15);
  updateFullRouteButton();
  updateRoleButtons();
  refreshVisibleRoute().catch(handleRouteError);
}
export function setMapDestination(id) {
  if (state.mapRouteView === 'entire') locateIntentRevision++;
  mapTouched = false; map?.closePopup();
  state.mapRouteView = 'endpoints';
  state.mapTo = id; if ($('routeTo')) $('routeTo').value = id;
  if (state.routeModeSelected) rememberSelectedStopMode(id, state.routeMode);
  const place = mapPlaces().find(item => item.placeId === id);
  if (point(place) && map) map.setView(onBaseMap(point(place)), 15);
  updateFullRouteButton();
  updateRoleButtons();
  refreshVisibleRoute().catch(handleRouteError);
}
async function estimate(origin, destination, mode, signal) {
  if (!point(origin) || !point(destination)) throw new Error('起点或终点缺少坐标，请换一个地点。');
  const originCity = origin.cityCode;
  const destinationCity = destination.cityCode;
  if (mode === 'transit' && originCity && destinationCity && originCity !== destinationCity) throw new Error('起点和终点不在同一城市，暂不支持跨城公共交通路线。');
  const cityCode = originCity || destinationCity || state.mapConfig?.cityCode;
  const result = await api('/api/v1/routes', { method:'POST', signal, body:JSON.stringify({ origin, destination, transportMode:mode, ...(cityCode ? { cityCode } : {}) }) });
  if (result?.error) throw new Error(result.error.message || '道路规划失败，请重试。');
  if (result?.leg?.transportMode !== mode) throw new Error('未取得所选交通方式的道路路线，请重新规划。');
  return result;
}
export async function calculateRoute({ fit = true } = {}) {
  const from = $('routeFrom').value, to = $('routeTo').value, mode = $('routeMode').value;
  if (!to || !from) throw new Error('请选择起点和终点。');
  if (from === to) throw new Error('起点和终点是同一个地点，请换一个终点。');
  const places = mapPlaces();
  const origin = from === 'my-location' ? state.currentLocation : from === 'map-point-from' ? state.mapCustomFrom : places.find(place => place.placeId === from);
  const destination = places.find(place => place.placeId === to) || (to === 'map-point-to' ? state.mapCustomTo : null);
  if (!validMapPoint(point(origin)) || !validMapPoint(point(destination))) throw new Error('起点或终点缺少有效坐标，请重新选择。');
  if (from === 'my-location' && !isFreshCurrentLocation(origin)) { clearRoute(); routeFailure('当前位置已过期，请点击地图定位按钮，或在地图上修正起点。'); return; }
  state.mapFrom = from; state.mapTo = to; state.routeMode = mode;
  clearRoute();
  const context = requestContext(origin, from, to, mode);
  const pending = beginRouteRequest(context,'正在按实际道路规划路线…');
  lastOrigin = from === 'my-location' ? { ...point(origin) } : null; lastRouteAt = Date.now();
  try {
    if (mode === 'transit' && !state.mapConfig?.routeModes?.includes('transit')) { showExternalTransitResult([{origin,destination}],false); return; }
    const result = await estimate(origin,destination,mode,pending.controller.signal);
    if (!routeReceiptCurrent(pending)) return;
    state.routePreview = { ...context, segments:[{origin,destination,...result}] };
    showRouteResult(state.routePreview,{fit});
  } catch (error) {
    if (!routeReceiptCurrent(pending)) return;
    if (pending.controller.signal.aborted && pending.controller.signal.reason?.name !== 'TimeoutError') return;
    state.routePreview = null;
    routeFailure(pending.controller.signal.reason?.name === 'TimeoutError' ? '道路服务响应超时，请重新规划。' : error.message);
  } finally {
    const moved = pending.sequence === requestSequence && state.currentView === 'map' && !document.hidden &&
      from === 'my-location' && isFreshCurrentLocation(state.currentLocation) && mapDistanceMeters(point(origin),point(state.currentLocation)) > 40;
    finishRouteRequest(pending.controller);
    if (moved) void refreshVisibleRoute({fit:false}).catch(handleRouteError);
  }
}

export async function calculateTripRoute({ fit = true } = {}) {
  const directory = new Map(mapPlaces().map(place => [place.placeId,place]));
  const allStops = structuredClone(planStops()).map(stop => ({ ...stop, place:mapPlaceForStop(stop,directory) }));
  const stops = allStops.filter(stop => stop.status !== 'skipped' && stop.place);
  const missingDirectory = allStops.filter(stop => stop.status !== 'skipped' && !stop.place);
  if (missingDirectory.length) throw new Error(`有 ${missingDirectory.length} 个计划地点已不在地点目录中，请重新选择地点。`);
  if (stops.length < 2) throw new Error('行程至少需要两站。');
  if (stops.some(stop => !validMapPoint(point(stop.place)))) throw new Error('部分地点缺少有效坐标，暂时无法显示全程路线。');
  clearRoute();
  const mode = $('routeMode').value; state.routeMode = mode;
  const context = requestContext(null,'','',mode,true), dayPlan = mapDayPlan();
  const pending = beginRouteRequest(context,'正在按各站交通方式规划道路路线…');
  try {
    const results = await Promise.allSettled(stops.slice(1).map(async (stop,index) => {
      const selectedMode = stopTransportMode(stop,dayPlan);
      if (selectedMode === 'transit' && !state.mapConfig?.routeModes?.includes('transit')) throw new Error('当前公交路线服务未配置，这一段路线待确认。');
      return { origin:stops[index].place, destination:stop.place,
        ...await estimate(stops[index].place,stop.place,selectedMode,pending.controller.signal),
        fromStopId:stops[index].stopId, toStopId:stop.stopId };
    }));
    if (!routeReceiptCurrent(pending)) return;
    if (pending.controller.signal.aborted) {
      if (pending.controller.signal.reason?.name === 'TimeoutError') routeFailure('全程道路查询超时，请重试。');
      return;
    }
    const segments = results.map((result,index) => result.status === 'fulfilled' ? result.value : {
      origin:stops[index].place,destination:stops[index+1].place,
      error:{message:result.reason?.message || '这一段道路路线暂不可用。'},
      fromStopId:stops[index].stopId,toStopId:stops[index+1].stopId });
    state.routePreview = { ...context, stops:allStops, segments };
    showRouteResult(state.routePreview,{fit});
  } finally { finishRouteRequest(pending.controller); }
}

function showExternalTransitResult(segments, entireTrip) {
  clearRoute('公交路线将在高德导航中查看。');
  const valid = segments.filter(segment => point(segment.origin) && point(segment.destination));
  if (!valid.length) {
    $('route-result').textContent = '缺少有效地点坐标，无法打开公交导航。';
    return;
  }
  $('route-result').innerHTML = `<div class="route-result-head"><h3>${entireTrip ? '全程公交导航' : '公交导航'}</h3></div><p>路线详情会在高德地图中打开；本页不显示未核实的公交距离、时间或线路。</p>${valid.map((segment, index) => `<article class="route-segment"><strong>${entireTrip ? `${index + 1}. ` : ''}${escapeHtml(segment.origin.name)} → ${escapeHtml(segment.destination.name)}</strong><a class="btn-soft" href="${escapeHtml(navigationLink(segment.destination, 'transit', segment.origin))}" target="_blank" rel="noreferrer">在高德查看这段公交路线</a></article>`).join('')}`;
}
export async function toggleFullRoute() {
  locateIntentRevision++;
  if (state.mapRouteView === 'entire') {
    state.mapRouteView = 'endpoints';
    updateFullRouteButton();
    await refreshVisibleRoute();
    return;
  }
  state.mapRouteView = 'entire';
  updateFullRouteButton();
  try {
    await calculateTripRoute();
  } catch (error) {
    clearRoute(); routeFailure(error.message);
  }
}
function showRouteResult(preview, { fit = true } = {}) {
  if (!$('route-result') || !map) return;
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = window.L.featureGroup().addTo(map);
  const paths = preview.segments.map(roadRoutePath), verified = paths.filter(Boolean).length;
  const complete = verified === preview.segments.length;
  const distances = preview.segments.map(segment => segment.leg?.distanceMeters);
  const durations = preview.segments.map(segment => segment.leg?.durationMinutes ?? (segment.leg?.durationSeconds == null ? null : segment.leg.durationSeconds / 60));
  const totalDistance = complete && distances.every(value => Number.isFinite(value) && value >= 0) ? distances.reduce((sum,meters) => sum+meters,0) : null;
  const totalMinutes = complete && durations.every(value => Number.isFinite(value) && value >= 0) ? durations.reduce((sum,minutes) => sum+minutes,0) : null;
  $('route-result').innerHTML = `<div class="route-result-head"><h3>${preview.entireTrip ? '全程路线' : '起终点路线'}</h3>${preview.entireTrip ? '<span class="chip green">按各站交通方式</span>' : ''}</div><p class="route-total">${complete ? `${preview.segments.length} 段` : `已取得 ${verified}／${preview.segments.length} 段道路轨迹`} · ${totalDistance == null ? '总路程待确认' : `总路程 ${(totalDistance/1000).toFixed(1)} 公里`} · ${totalMinutes == null ? '交通时间待确认' : `交通时间约 ${Math.ceil(totalMinutes)} 分钟`}</p>${preview.segments.map((segment,index) => {
    const leg = segment.leg, path = paths[index];
    if (!path) return `<article class="route-segment"><strong>${index+1}. ${escapeHtml(segment.origin.name)} → ${escapeHtml(segment.destination.name)}</strong><p role="status">${escapeHtml(segment.error?.message || '未取得实际道路轨迹，这一段路线待确认。')}</p><p class="stop-meta">不以起终点连线代替道路，不给出未经确认的预计时间。</p></article>`;
    window.L.polyline(path,{color:'#2576fb',weight:4,className:'bantu-road-route'}).addTo(routeLayer);
    const minutes = leg.durationMinutes ?? (leg.durationSeconds == null ? null : leg.durationSeconds/60);
    const label = leg.evidenceId === 'amap_route' ? '高德道路路线' : leg.evidenceId === 'fossgis_osrm' ? 'OpenStreetMap 道路路线' : '道路服务返回的轨迹';
    return `<article class="route-segment"><strong>${index+1}. ${escapeHtml(segment.origin.name)} → ${escapeHtml(segment.destination.name)}</strong><p>${escapeHtml(modes[leg.transportMode] || '')} · ${Number.isFinite(minutes) ? `约 ${Math.ceil(minutes)} 分钟` : '时间待确认'} · ${Number.isFinite(leg.distanceMeters) ? `${(leg.distanceMeters/1000).toFixed(1)} 公里` : '距离待确认'}</p><p class="stop-meta">${label} · 预计时间不含实时路况。</p>${leg.instructions?.length ? `<details><summary>逐步路线说明</summary><ol>${leg.instructions.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ol></details>` : ''}<a class="btn-soft" href="${escapeHtml(navigationLink(segment.destination,leg.transportMode,segment.origin))}" target="_blank" rel="noreferrer">打开高德导航</a></article>`;
  }).join('')}<div class="stop-actions"><button class="btn-soft" data-action="retry-map-route">${complete ? '重新规划' : '重试道路查询'}</button></div>`;
  if (preview.segments.some(segment => segment.leg?.evidenceId === 'fossgis_osrm'))
    $('route-result').insertAdjacentHTML('beforeend','<p class="stop-meta">路线数据 © OpenStreetMap contributors · ODbL。</p>');
  if (fit && !mapTouched && verified) map.fitBounds(routeLayer.getBounds(),{padding:[30,30],maxZoom:17,animate:false});
}

function clearRoute(message = '起点、终点或交通方式已更新。') {
  requestSequence++; cancelRouteRequest();
  state.routePreview = null;
  if (routeLayer && map) map.removeLayer(routeLayer);
  routeLayer = null;
  if ($('route-result')) $('route-result').textContent = message;
}
export function pickMapOrigin(button) {
  const lat = Number(button.dataset.lat), lng = Number(button.dataset.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('位置坐标无效。');
  locateIntentRevision++;
  mapTouched = false; map?.closePopup();
  state.routeMode = $('routeMode').value; state.mapRouteView = 'endpoints';
  state.mapCustomFrom = { placeId: 'map-point-from', name: '地图选定的起点', coordinates: { lat, lng, source: 'manual' } };
  state.mapFrom = 'map-point-from';
  const select = $('routeFrom');
  if (select) {
    let option = [...select.options].find(item => item.value === 'map-point-from');
    if (!option) { option = document.createElement('option'); option.value = 'map-point-from'; option.textContent = '地图选定的起点'; select.appendChild(option); }
    select.value = 'map-point-from';
  }
  if (map) map.setView(onBaseMap({ lat, lng }), 15);
  updateFullRouteButton();
  updateRoleButtons();
  refreshVisibleRoute().catch(handleRouteError);
}
