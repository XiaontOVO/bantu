/** One foreground GPS channel. Device coordinates remain WGS84 until map rendering. */
import { api } from './api.js';
import { state } from './store.js';
import { distanceMeters } from './scene-arrival.js';

export const MAX_LOCATION_ACCURACY_METERS = 200;
export const MAX_LOCATION_FIX_AGE_MS = 30_000;
const FUTURE_FIX_TOLERANCE_MS = 5000;
const REVERSE_INTERVAL_MS = 5000;
let requested = false;
let generation = 0;
let activeWatch = null;
let boundLifecycle = false;
let knownOwner = '';
let healthTimer = null;
let firstFixTimer = null;
let reverseTimer = null;
let reverseDeadline = null;
let reverseController = null;
let reverseSequence = 0;
let lastReverseAt = 0;
let reverseAnchor = null;
let latestTimestamp = 0;
let locationStatus = { phase:'idle', message:'尚未开启定位', errorCode:'', accuracyMeters:null, measuredAt:null, coarseCoordinates:null };
const pendingRequests = new Set();

function locationOwner() { return state.principal?.principalId || 'guest'; }
function foregroundLocation() { return (typeof document === 'undefined' || (!document.hidden && document.visibilityState !== 'hidden')) && !state.accountContextChanged; }
function locationElement() { return typeof document === 'undefined' ? null : document.getElementById('appbarPlace'); }
function locationError(message, code) { return Object.assign(new Error(message), {code}); }

// Remove the fixed-campus override left by older app versions.
try { localStorage.removeItem('bantu.location.override.v1'); } catch { /* Storage is optional. */ }

function validLocationCoordinates(coordinates) {
  return Boolean(coordinates && Number.isFinite(coordinates.lat) && Math.abs(coordinates.lat) <= 90 &&
    Number.isFinite(coordinates.lng) && Math.abs(coordinates.lng) <= 180 && Number.isFinite(coordinates.accuracyMeters) && coordinates.accuracyMeters > 0);
}

function freshLocationTimestamp(measuredAt, maxAge = MAX_LOCATION_FIX_AGE_MS, now = Date.now()) {
  return Number.isFinite(measuredAt) && measuredAt > 0 && measuredAt <= now + FUTURE_FIX_TOLERANCE_MS && now - measuredAt <= Math.max(0, Number(maxAge) || 0);
}

/** A fresh GPS place suitable for a route origin; old addresses are not evidence. */
export function isFreshCurrentLocation(place, maxAge = MAX_LOCATION_FIX_AGE_MS) {
  const coordinates = place?.coordinates;
  return Boolean(coordinates?.source === 'gps' && validLocationCoordinates(coordinates) &&
    coordinates.accuracyMeters <= MAX_LOCATION_ACCURACY_METERS && freshLocationTimestamp(coordinates.measuredAt, maxAge));
}

/** Retained for existing map callers, with complete coordinate and age checks. */
export function isPrecisePosition(position) {
  return isFreshCurrentLocation({coordinates:{lat:position?.coords?.latitude,lng:position?.coords?.longitude,
    accuracyMeters:position?.coords?.accuracy, measuredAt:position?.timestamp, source:'gps'}});
}

export function getLocationStatus() {
  const fresh = isFreshCurrentLocation(state.currentLocation);
  const expired = locationStatus.phase === 'tracking' && !fresh;
  const message = expired ? '定位已过期，正在等待新的设备位置' : locationStatus.message;
  return { ...locationStatus, phase:expired ? 'stale' : locationStatus.phase, message, statusMessage:message,
    fresh, watching:Boolean(activeWatch), coordinates:state.currentLocation?.coordinates ? {...state.currentLocation.coordinates} : null,
    coarseCoordinates:locationStatus.coarseCoordinates ? {...locationStatus.coarseCoordinates} : null };
}

function notifyLocationUpdated() {
  const element = locationElement();
  if (element) element.textContent = state.geoLabel || state.geoAppbarText || '';
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  if (typeof CustomEvent !== 'undefined') window.dispatchEvent(new CustomEvent('bantu:location-state', {detail:getLocationStatus()}));
  if (typeof Event !== 'undefined') window.dispatchEvent(new Event('bantu:location-updated'));
}

function publishLocation(phase, message, changes = {}) {
  locationStatus = {...locationStatus, ...changes, phase, message};
  notifyLocationUpdated();
}

function settleLocationRequest(request, failure, place) {
  if (!pendingRequests.delete(request)) return;
  clearTimeout(request.timer); request.signal?.removeEventListener('abort',request.onAbort);
  if (failure) request.reject(failure); else request.resolve(place);
}

function rejectLocationRequests(failure) {
  for (const request of [...pendingRequests]) settleLocationRequest(request, failure);
}

function cancelReverseLocation() {
  reverseSequence++; reverseController?.abort(); reverseController = null;
  clearTimeout(reverseTimer); clearTimeout(reverseDeadline); reverseTimer = null; reverseDeadline = null;
}

function retireLocationWatch() {
  generation++;
  const previous = activeWatch; activeWatch = null;
  if (previous?.id !== null && previous?.id !== undefined) { try { previous.geo.clearWatch(previous.id); } catch { /* Browser already released the watch. */ } }
  clearInterval(healthTimer); clearTimeout(firstFixTimer); healthTimer = null; firstFixTimer = null;
  cancelReverseLocation();
}

function clearLocationAddress(message) { state.geoLabel = ''; state.geoAppbarText = message; }

function reverseLocationLabel(token = generation) {
  reverseTimer = null;
  if (token !== generation || !foregroundLocation() || !isFreshCurrentLocation(state.currentLocation)) return;
  const coordinates = {...state.currentLocation.coordinates}, owner = locationOwner();
  const sequence = ++reverseSequence;
  reverseController?.abort(); clearTimeout(reverseDeadline);
  const controller = new AbortController(); reverseController = controller;
  lastReverseAt = Date.now(); reverseAnchor = coordinates;
  reverseDeadline = setTimeout(() => controller.abort(),8000); reverseDeadline.unref?.();
  void api(`/api/v1/geo/reverse?lat=${coordinates.lat}&lng=${coordinates.lng}`,{signal:controller.signal}).then(result => {
    if (sequence !== reverseSequence || token !== generation || owner !== locationOwner() || !foregroundLocation() || locationStatus.phase !== 'tracking' ||
      !isFreshCurrentLocation(state.currentLocation) || distanceMeters(coordinates,state.currentLocation.coordinates) > 100) return;
    if (typeof result?.label === 'string' && result.label.trim()) {
      state.geoLabel = result.label.trim(); state.geoAppbarText = ''; notifyLocationUpdated();
    }
  }).catch(() => { /* GPS is usable independently of the address service. */ }).finally(() => {
    if (sequence === reverseSequence) { clearTimeout(reverseDeadline); reverseDeadline = null; reverseController = null; }
  });
}

function scheduleReverseLocation() {
  const coordinates = state.currentLocation?.coordinates;
  if (!coordinates || reverseTimer !== null) return;
  if (reverseAnchor && distanceMeters(reverseAnchor,coordinates) < 50 && Date.now() - lastReverseAt < 60_000) return;
  const delay = Math.max(0, REVERSE_INTERVAL_MS - (Date.now() - lastReverseAt));
  if (!delay) { reverseLocationLabel(); return; }
  const token = generation;
  reverseTimer = setTimeout(() => reverseLocationLabel(token),delay); reverseTimer.unref?.();
}

/** Accept each newer valid device fix, even when its error radius grows slightly. */
export function acceptDevicePosition(position) {
  if (!foregroundLocation() || (knownOwner && knownOwner !== locationOwner())) return false;
  const coordinates = {lat:position?.coords?.latitude,lng:position?.coords?.longitude,
    accuracyMeters:position?.coords?.accuracy,measuredAt:position?.timestamp,source:'gps'};
  if (!validLocationCoordinates(coordinates) || !freshLocationTimestamp(coordinates.measuredAt)) {
    if (!isFreshCurrentLocation(state.currentLocation)) {
      clearLocationAddress('正在等待有效定位…');
      publishLocation('stale','设备位置无效或已过期，正在等待新的定位',{errorCode:'LOCATION_INVALID_FIX'});
    }
    return false;
  }
  if (coordinates.measuredAt <= latestTimestamp || coordinates.measuredAt <= (state.currentLocation?.coordinates?.measuredAt || 0)) return false;
  latestTimestamp = coordinates.measuredAt;
  if (coordinates.accuracyMeters > MAX_LOCATION_ACCURACY_METERS) {
    state.currentLocation = null;
    clearLocationAddress('定位不够准确');
    publishLocation('coarse',`设备报告误差约 ${Math.round(coordinates.accuracyMeters)} 米，暂不用于行程起点`,
      {errorCode:'LOCATION_COARSE',accuracyMeters:coordinates.accuracyMeters,measuredAt:coordinates.measuredAt,coarseCoordinates:coordinates});
    return false;
  }
  clearTimeout(firstFixTimer); firstFixTimer = null;
  if (reverseAnchor && distanceMeters(reverseAnchor,coordinates) > 100) state.geoLabel = '';
  state.geoAppbarText = state.geoLabel ? '' : '当前位置';
  state.currentLocation = {placeId:'my-location',name:'我的位置',coordinates};
  publishLocation('tracking',`当前位置持续更新 · 设备报告误差约 ${Math.round(coordinates.accuracyMeters)} 米`,
    {errorCode:'',accuracyMeters:coordinates.accuracyMeters,measuredAt:coordinates.measuredAt,coarseCoordinates:null});
  for (const request of [...pendingRequests]) settleLocationRequest(request,null,state.currentLocation);
  scheduleReverseLocation();
  return true;
}

function deviceLocationError(error) {
  const denied = error?.code === 1;
  const code = denied ? 'LOCATION_PERMISSION_DENIED' : error?.code === 3 ? 'LOCATION_TIMEOUT' : 'LOCATION_UNAVAILABLE';
  const message = denied ? '定位未获允许，请在系统和浏览器设置中开启权限后重试' : error?.code === 3 ? '设备尚未返回准确位置，请重试或等待新的定位' : '设备暂时无法定位，请检查定位服务后重试';
  if (denied) retireLocationWatch();
  state.currentLocation = null;
  clearLocationAddress(denied ? '未允许定位' : '定位暂不可用');
  publishLocation(denied ? 'denied' : 'error',message,{errorCode:code,accuracyMeters:null,measuredAt:null,coarseCoordinates:null});
  rejectLocationRequests(locationError(message,code));
}

function checkLocationFreshness() {
  if (locationStatus.phase !== 'tracking' || isFreshCurrentLocation(state.currentLocation)) return;
  clearLocationAddress('定位已过期，正在更新…');
  publishLocation('stale','定位已过期，正在等待新的设备位置',{errorCode:'LOCATION_STALE'});
}

function bindLocationLifecycle() {
  if (boundLifecycle || typeof document === 'undefined') return;
  boundLifecycle = true;
  document.addEventListener('visibilitychange', () => {
    if (!requested) return;
    if (!foregroundLocation()) {
      retireLocationWatch(); clearLocationAddress('定位已暂停');
      publishLocation('paused','应用在后台，定位已暂停');
      rejectLocationRequests(locationError('应用在后台，定位请求已暂停','LOCATION_PAUSED'));
    } else void startLocation({force:true});
  });
  document.addEventListener('bantu:account-context-paused', () => {
    retireLocationWatch(); state.currentLocation = null; latestTimestamp = 0; reverseAnchor = null;
    clearLocationAddress('定位已暂停'); publishLocation('paused','账号正在核对，定位已暂停');
    rejectLocationRequests(locationError('账号正在核对，定位请求已暂停','LOCATION_ACCOUNT_PAUSED'));
  });
  document.addEventListener('bantu:account-context-resumed', () => { if (requested) void startLocation({force:true}); });
  if (typeof window !== 'undefined') window.addEventListener('bantu:rendered', () => {
    if (!requested || knownOwner === locationOwner()) return;
    retireLocationWatch(); state.currentLocation = null; latestTimestamp = 0; reverseAnchor = null;
    clearLocationAddress('正在定位…'); rejectLocationRequests(locationError('账号已切换，请重新定位','LOCATION_ACCOUNT_CHANGED'));
    if (foregroundLocation()) void startLocation({force:true});
  });
}

/** Start or retain the shared foreground watch; force immediately replaces old work. */
export async function startLocation({force = false} = {}) {
  requested = true; bindLocationLifecycle();
  if (!foregroundLocation()) { retireLocationWatch(); clearLocationAddress('定位已暂停'); publishLocation('paused','应用不在前台，定位已暂停'); return getLocationStatus(); }
  if (activeWatch && !force && knownOwner === locationOwner()) return getLocationStatus();
  retireLocationWatch();
  if (knownOwner && knownOwner !== locationOwner()) { state.currentLocation = null; latestTimestamp = 0; }
  knownOwner = locationOwner(); lastReverseAt = 0; reverseAnchor = null;
  const geo = globalThis.navigator?.geolocation;
  if (!geo?.watchPosition || (typeof window !== 'undefined' && window.isSecureContext === false)) {
    const message = geo?.watchPosition ? '定位需要 HTTPS 或本机安全环境' : '此设备或浏览器暂不支持定位';
    state.currentLocation = null;
    clearLocationAddress('定位不可用'); publishLocation('unavailable',message,{errorCode:'LOCATION_UNAVAILABLE',accuracyMeters:null,measuredAt:null,coarseCoordinates:null});
    rejectLocationRequests(locationError(message,'LOCATION_UNAVAILABLE')); return getLocationStatus();
  }
  clearLocationAddress('正在定位…'); publishLocation('locating','正在获取设备位置',{errorCode:'',accuracyMeters:null,measuredAt:null,coarseCoordinates:null});
  const token = generation, watch = {geo,id:null,owner:knownOwner}; activeWatch = watch;
  try {
    const id = geo.watchPosition(position => {
      if (token !== generation || activeWatch !== watch || watch.owner !== locationOwner() || !foregroundLocation()) return;
      acceptDevicePosition(position);
    },error => {
      if (token === generation && activeWatch === watch && watch.owner === locationOwner() && foregroundLocation()) deviceLocationError(error);
    },{enableHighAccuracy:true,timeout:15000,maximumAge:0});
    if (activeWatch !== watch || token !== generation) { geo.clearWatch(id); return getLocationStatus(); }
    watch.id = id;
    healthTimer = setInterval(checkLocationFreshness,5000); healthTimer.unref?.();
    firstFixTimer = setTimeout(() => {
      firstFixTimer = null;
      if (token !== generation || isFreshCurrentLocation(state.currentLocation) || locationStatus.phase === 'coarse') return;
      clearLocationAddress('尚未获取位置'); publishLocation('error','设备尚未返回准确位置，可以重试；仍在等待新的定位',{errorCode:'LOCATION_TIMEOUT'});
    },15000); firstFixTimer.unref?.();
  } catch { activeWatch = null; deviceLocationError({code:2}); }
  return getLocationStatus();
}

export function stopLocation({clear = false} = {}) {
  requested = false; retireLocationWatch();
  if (clear) { state.currentLocation = null; latestTimestamp = 0; reverseAnchor = null; }
  clearLocationAddress('定位已停止'); publishLocation('idle','定位已停止');
  rejectLocationRequests(locationError('定位请求已取消','LOCATION_CANCELED'));
}

/** Await a usable GPS place while sharing the global watch; cancel only this waiter. */
export function requestCurrentLocation({timeout = 15000,signal,force = false} = {}) {
  if (signal?.aborted) return Promise.reject(Object.assign(locationError('定位请求已取消','LOCATION_CANCELED'),{name:'AbortError'}));
  if (!foregroundLocation()) return Promise.reject(locationError('请回到应用前台后重新定位','LOCATION_PAUSED'));
  if (!force && (!knownOwner || knownOwner === locationOwner()) && isFreshCurrentLocation(state.currentLocation)) { void startLocation(); return Promise.resolve(state.currentLocation); }
  return new Promise((resolve,reject) => {
    const request = {resolve,reject,signal,timer:null,onAbort:null};
    request.onAbort = () => settleLocationRequest(request,Object.assign(locationError('定位请求已取消','LOCATION_CANCELED'),{name:'AbortError'}));
    pendingRequests.add(request); signal?.addEventListener('abort',request.onAbort,{once:true});
    const duration = Math.max(1,Math.min(15000,Number(timeout) || 15000));
    request.timer = setTimeout(() => settleLocationRequest(request,locationError(getLocationStatus().phase === 'coarse' ? getLocationStatus().message : '设备尚未返回准确位置，请重试','LOCATION_TIMEOUT')),duration);
    request.timer.unref?.();
    void startLocation({force});
  });
}
