/** 随行会话只缓存目标和短期道路视图，事实继续走原执行接口。 */
import { $, state } from './store.js';
import { companionTarget } from './day-plan-selection.js';
import { companionMode } from '../views/companion.js';
import { api } from './api.js';
import { render } from './render.js';
import { loadPlans } from './plan-library.js';
import { resolveStopPlace } from './components.js';
import { addMapZoomControl } from './map-controls.js';
import { cachedPlaceDetail, cachePlaceDetail } from './place-detail.js';
import { requestCurrentLocation, isFreshCurrentLocation } from './location.js';
import { baseMapPoint, validMapPoint, mapDistanceMeters } from './map-coordinates.js';
import { roadRoutePath } from './map-route-geometry.js';

let request = null, generation = 0, map = null, mapResize = null, timer = null;
let mapTouched = false, mapKey = '', mapView = null;
let locationMarker = null, accuracyCircle = null;
let locationWasFresh = null;
let activeKey = '', lastQueryAt = 0;
let detailLoad = null, detailGeneration = 0, trackingGeneration = 0;
const cacheKey = owner => `bantu:companion:${owner}`;
const companionForeground = () => state.currentView === 'home' && !state.accountContextChanged &&
  (typeof document === 'undefined' || !document.hidden);

export function rememberCompanion(planId) {
  state.companionPlanId = planId || '';
  state.companionFinishedPlan = null;
  state.companionContext = null;
  state.companionError = '';
  state.companionNotice = '';
  state.companionDepartureFallback = null;
  const owner = state.principal?.principalId;
  if (owner) { try { sessionStorage.setItem(cacheKey(owner), state.companionPlanId); } catch {} }
}

export async function loadCompanion() {
  if (!companionForeground()) return;
  const owner = state.principal?.principalId || '', revision = state.navigationRevision, token = ++detailGeneration;
  detailLoad?.abort(); detailLoad = null;
  const isCurrent = () => token === detailGeneration && owner === (state.principal?.principalId || '') &&
    revision === state.navigationRevision && companionForeground();
  await loadPlans();
  if (!isCurrent()) return;
  if (owner !== state.companionOwner) {
    state.companionOwner = owner;
    state.companionContext = null;
    state.companionFinishedPlan = null;
    state.companionNotice = '';
    state.companionPlanId = '';
    try { state.companionPlanId = owner ? sessionStorage.getItem(cacheKey(owner)) || '' : ''; } catch {}
  }
  const preferredId = state.companionPlanId;
  const target = companionTarget(state.savedPlans, preferredId);
  if (preferredId && !(state.savedPlans || []).some(plan => plan.id === preferredId && plan.kind === 'plan')) state.companionNotice = target.plan ? '原来的安排已不可用，已切换到当前有效安排。' : '原来的安排已不可用，可以查看旅行记忆或重新规划。';
  if (target.plan) {
    state.companionPlanId = target.plan.id;
    state.planViewDate = target.plan.localDate;
    const placeId = target.next?.placeId || target.next?.place?.placeId;
    if (placeId && !cachedPlaceDetail(placeId) && !(state.places || []).some(place => place.placeId === placeId)) {
      const controller = new AbortController(), key = currentKey();
      detailLoad = controller;
      try {
        const place = await api(`/api/v1/places/${encodeURIComponent(placeId)}`, { signal:controller.signal });
        if (place && !controller.signal.aborted && isCurrent() && key === currentKey()) cachePlaceDetail(placeId, place, owner);
      } catch { /* The saved place snapshot remains usable when the directory is unavailable. */ }
      finally { if (detailLoad === controller) detailLoad = null; }
    }
  } else state.companionPlanId = '';
}

function currentKey() {
  if (state.accountContextChanged) return '';
  const target = companionTarget(state.savedPlans || [], state.companionPlanId);
  if (!target.plan || !target.next || ['conflict', 'finished'].includes(target.phase) || state.companionFinishedPlan?.id === target.plan.id) return '';
  return `${state.principal?.principalId || ''}:${target.plan.id}:${target.plan.revision || 0}:${target.next.stopId}:${companionMode(target.plan, target.next)}:${target.phase}`;
}

export async function refreshCompanionRoute({ locate = false } = {}) {
  const key = currentKey();
  if (!key || !companionForeground()) return;
  if (request?.key === key && !locate) return request.promise;
  request?.controller.abort();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new DOMException('道路查询超时，请重试。','TimeoutError')),25000);
  const run = ++generation;
  let reroute = false;
  state.companionError = '';
  state.companionLoading = true;
  state.companionQueryStage = locate ? 'locating' : 'routing';
  const updateFeedback = () => queueMicrotask(() => {
    if (typeof document !== 'undefined' && run === generation && key === currentKey() && companionForeground()) render();
  });
  updateFeedback();
  const promise = (async () => {
    try {
      if (locate) {
        await requestCurrentLocation({ signal:controller.signal, force:true, timeout:12000 });
        if (run !== generation || controller.signal.aborted || !companionForeground() || key !== currentKey()) return;
      }
      if (run !== generation || !companionForeground() || key !== currentKey()) return;
      if (state.companionQueryStage !== 'routing') { state.companionQueryStage = 'routing'; updateFeedback(); }
      const target = companionTarget(state.savedPlans, state.companionPlanId);
      const fix = isFreshCurrentLocation(state.currentLocation) ? state.currentLocation.coordinates : null;
      const result = await api(`/api/v1/plans/${encodeURIComponent(target.plan.id)}/companion/context`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ expectedRevision: target.plan.revision || 0, stopId: target.next.stopId, transportMode: companionMode(target.plan, target.next), ...(fix?.source === 'gps' ? { position: fix } : {}) }) });
      if (run === generation && companionForeground() && key === currentKey()) {
        if (fix && (!isFreshCurrentLocation(state.currentLocation) || mapDistanceMeters(fix,state.currentLocation.coordinates) > 40)) {
          reroute = isFreshCurrentLocation(state.currentLocation);
          state.companionContext = null;
          state.companionError = reroute ? '' : '当前位置已过期，请重新定位；预计时间保持待估。';
        } else state.companionContext = result;
      }
    } catch (error) {
      if (run === generation && companionForeground() && key === currentKey() &&
          (error.name !== 'AbortError' || controller.signal.reason?.name === 'TimeoutError')) {
        state.companionContext = null;
        state.companionError = error.code === 1 ? '定位权限未开启，预计到达时间保持待估。仍可手动记录真实进度。'
          : error.code === 2 ? '暂时无法取得设备位置，请稍后重试。'
          : error.code === 3 ? '设备定位超时，请重试；预计时间保持待估。'
          : error instanceof TypeError ? '网络暂时不可用，请检查连接后重试。'
          : controller.signal.reason?.name === 'TimeoutError' ? '道路查询超时，请重试；预计时间保持待估。'
          : error.message || '路线暂时无法更新，预计时间保持待估。';
      }
    } finally {
      clearTimeout(deadline);
      if (run === generation) { state.companionLoading = false; state.companionQueryStage = ''; request = null; if (typeof document !== 'undefined' && companionForeground()) render(); }
      if (reroute && run === generation && companionForeground() && key === currentKey()) void refreshCompanionRoute();
    }
  })();
  request = { key, controller, promise };
  lastQueryAt = Date.now();
  return promise;
}

export function cancelCompanionRoute() {
  if (!state.companionLoading || !companionForeground()) return;
  const key = currentKey(), revision = state.navigationRevision;
  generation++;
  request?.controller.abort(); request = null;
  state.companionLoading = false; state.companionQueryStage = '';
  if (typeof document !== 'undefined') {
    render();
    requestAnimationFrame(() => {
      if (companionForeground() && currentKey() === key && state.navigationRevision === revision &&
          !state.companionLoading && document.activeElement === document.body)
        document.querySelector('[data-action="refresh-companion-route"]')?.focus({ preventScroll:true });
    });
  }
}

function stopTracking() {
  trackingGeneration++;
  clearTimeout(timer); timer = null;
}

function updateTracking() {
  stopTracking();
  if (typeof document === 'undefined' || !companionForeground()) return;
  const token = trackingGeneration, key = currentKey(), revision = state.navigationRevision;
  const isCurrent = () => token === trackingGeneration && key === currentKey() && revision === state.navigationRevision && companionForeground();
  const target = companionTarget(state.savedPlans, state.companionPlanId);
  if (!['ready', 'travel'].includes(target.phase)) return;
  // Device position comes from the same foreground channel as the route map.
  const poll = () => {
    if (!isCurrent()) return;
    void refreshCompanionRoute();
    timer = setTimeout(poll, 60000);
  };
  timer = setTimeout(poll, 60000);
}

export function disposeCompanion() {
  detailGeneration++; detailLoad?.abort(); detailLoad = null;
  generation++;
  request?.controller.abort(); request = null;
  stopTracking();
  mapResize?.disconnect(); mapResize = null;
  map?.remove(); map = null;
  locationMarker = null; accuracyCircle = null;
  mapView = null; mapKey = ''; mapTouched = false;
  activeKey = '';
  state.companionLoading = false;
  state.companionQueryStage = '';
}

export function mountCompanion() {
  const key = currentKey();
  if (map && mapKey === key && mapTouched) mapView = { center:map.getCenter(),zoom:map.getZoom() };
  else if (mapKey !== key) mapView = null;
  mapResize?.disconnect(); mapResize = null;
  map?.remove(); map = null;
  locationMarker = null; accuracyCircle = null;
  if (key !== activeKey) {
    generation++; request?.controller.abort(); request = null;
    state.companionLoading = false; state.companionQueryStage = '';
    activeKey = key;
    updateTracking();
    if (key) void refreshCompanionRoute();
  }
  const element = $('companionRouteMap');
  const target = companionTarget(state.savedPlans, state.companionPlanId);
  if (!element) return;
  const status = $('companionMapStatus');
  const report = message => { if (status) status.textContent = message; };
  element.hidden = false;
  if (!window.L || !window.gcoord) { report('地图组件未加载，请刷新页面。'); return; }
  // 底图与路线查询独立：缺定位、路线待估或查询失败时仍展示目的地。
  const candidate = state.companionContext;
  const ctx = candidate?.planId === target.plan?.id && candidate?.revision === (target.plan?.revision || 0) && candidate?.stopId === target.next?.stopId && candidate?.mode === companionMode(target.plan, target.next)
    && (!candidate.validUntil || Date.now() < Date.parse(candidate.validUntil)) ? candidate : null;
  const validPoint = validMapPoint, convert = baseMapPoint;
  const place = resolveStopPlace(target.next);
  const destination = validPoint(ctx?.destination) ? ctx.destination : validPoint(place?.coordinates) ? place.coordinates : null;
  const path = ctx?.routeUnknown ? null : roadRoutePath(ctx?.route);
  let bounds = null;
  map = window.L.map(element, { scrollWheelZoom: false, zoomControl: false, zoomAnimation: false }).setView(destination ? convert(destination) : [31.2, 121.43], destination ? 15 : 13);
  mapKey = key; mapTouched = Boolean(mapView);
  const zoomControl = addMapZoomControl(map, window.L);
  zoomControl.getContainer().addEventListener('pointerdown', () => { mapTouched = true; });
  map.on('dragstart', () => { mapTouched = true; });
  element.addEventListener('wheel', () => { mapTouched = true; },{passive:true});
  element.addEventListener('keydown', event => { if (['+','-','=','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) mapTouched = true; });
  const mountedMap = map;
  const isMounted = () => map === mountedMap && element.isConnected;
  const mapMessage = path ? '已显示当前道路路线。' : destination ? '已显示目的地；取得有效定位和道路路线后显示起点与路线。' : '已显示徐汇区域底图；目的地坐标待核实。';
  report(`正在加载底图。${mapMessage}`);
  const tiles = window.L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', { subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '高德地图 · 路线 © OpenStreetMap contributors（按供应商）' });
  let tileFailed = false;
  tiles.on('tileerror', () => { if (isMounted()) { tileFailed = true; report('底图暂时加载失败，请检查网络后点击更新路线重试。地点标记和已取得的路线仍保留。'); } });
  tiles.on('load', () => { if (isMounted() && !tileFailed) report(mapMessage); });
  tiles.addTo(map);
  if (path) {
    const line = window.L.polyline(path, { color:'#177c79',weight:5,lineCap:'round',className:'bantu-road-route' }).addTo(map);
    bounds = line.getBounds();
    window.L.circleMarker(path[0], { radius: 5, color: '#177c79', fillOpacity: 1 }).addTo(map).bindTooltip('路线起点');
    window.L.circleMarker(path.at(-1), { radius: 7, color: '#ef8b46', fillOpacity: 1 }).addTo(map).bindTooltip('目的地');
    if (!mapView) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 17, animate: false });
  } else if (destination) {
    window.L.circleMarker(convert(destination), { radius: 7, color: '#ef8b46', fillOpacity: 1 }).addTo(map).bindTooltip('目的地');
  }
  if (mapView) map.setView(mapView.center,mapView.zoom,{animate:false});
  syncCompanionLocation();
  if (typeof ResizeObserver !== 'undefined') {
    mapResize = new ResizeObserver(() => {
      if (!isMounted()) return;
      mountedMap.invalidateSize({ animate: false });
    });
    mapResize.observe(element);
  }
}

function syncCompanionLocation() {
  if (!companionForeground() || !map) return;
  if (!isFreshCurrentLocation(state.currentLocation)) {
    if (locationMarker) map.removeLayer(locationMarker);
    if (accuracyCircle) map.removeLayer(accuracyCircle);
    locationMarker = null; accuracyCircle = null; return;
  }
  const coordinates = state.currentLocation.coordinates, converted = baseMapPoint(coordinates);
  if (locationMarker) locationMarker.setLatLng(converted);
  else locationMarker = window.L.circleMarker(converted,{radius:8,color:'#fff',weight:3,fillColor:'#2878f0',fillOpacity:1}).addTo(map).bindTooltip('设备当前位置');
  if (accuracyCircle) { accuracyCircle.setLatLng(converted); accuracyCircle.setRadius(coordinates.accuracyMeters); }
  else accuracyCircle = window.L.circle(converted,{radius:coordinates.accuracyMeters,color:'#397af4',weight:1,opacity:.35,fillOpacity:.06,interactive:false}).addTo(map);
}

if (typeof window !== 'undefined') window.addEventListener('bantu:location-updated', () => {
  if (!companionForeground()) return;
  syncCompanionLocation();
  const fresh = isFreshCurrentLocation(state.currentLocation), ctx = state.companionContext;
  const recovered = fresh && locationWasFresh === false; locationWasFresh = fresh;
  if (ctx?.origin && !ctx.routeUnknown && (!fresh || mapDistanceMeters(ctx.origin,state.currentLocation.coordinates) > 40)) {
    state.companionContext = {...ctx,route:null,routeUnknown:true,eta:null,validUntil:null,
      routeReason:fresh ? '位置已变化，正在等待更新道路路线。' : '当前位置已过期，请重新定位。'};
    render();
  }
  if (fresh && (recovered || Date.now()-lastQueryAt >= 15000) &&
      ['ready','travel'].includes(companionTarget(state.savedPlans || [],state.companionPlanId).phase)) void refreshCompanionRoute();
});

if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', () => {
  if (document.hidden) { generation++; request?.controller.abort(); request = null; state.companionLoading = false; state.companionQueryStage = ''; stopTracking(); }
  else if (state.currentView === 'home') { updateTracking(); void refreshCompanionRoute(); }
});
