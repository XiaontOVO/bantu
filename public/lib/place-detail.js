/** Targeted details never become search results; personalized fields stay with their owner. */
import { api } from './api.js';
import { state } from './store.js';

let owner = null;
let active = null;
let generation = 0;
const details = new Map();
const principal = () => state.principal?.principalId || '';

function resetDetailOwner() {
  if (owner === principal()) return;
  active?.controller.abort();
  active = null;
  generation++;
  owner = principal();
  details.clear();
  state.placeDetailResource = null;
}

export function cachedPlaceDetail(id) {
  resetDetailOwner();
  return state.accountContextChanged ? undefined : details.get(id);
}

/** A foreground reader may hydrate a detail, never the filtered directory list. */
export function cachePlaceDetail(id, place, expectedOwner) {
  resetDetailOwner();
  if (state.accountContextChanged || expectedOwner !== principal() || !place?.placeId || !place.name ||
      (place.placeId !== id && `amap_${id}` !== place.placeId)) return false;
  details.delete(id);
  details.set(id, place);
  if (details.size > 64) details.delete(details.keys().next().value);
  return true;
}

export function placeDetailResourceFor(id) {
  resetDetailOwner();
  const resource = state.placeDetailResource;
  return !state.accountContextChanged && resource?.placeId === id && resource.owner === principal() ? resource : null;
}

function detailRequestIsCurrent(request) {
  return active === request && request.token === generation && !request.controller.signal.aborted && !state.accountContextChanged &&
    request.owner === principal() && state.currentView === 'place' && state.placeDetailId === request.placeId &&
    state.navigationRevision === request.revision;
}

export function syncPlaceDetailNavigation() {
  resetDetailOwner();
  if (!active || detailRequestIsCurrent(active)) return;
  active.controller.abort();
  active = null;
  generation++;
  state.placeDetailResource = null;
}

export function invalidatePlaceDetail(id) {
  resetDetailOwner();
  details.delete(id);
}

export function loadPlaceDetail({ force = false } = {}) {
  resetDetailOwner();
  const id = state.placeDetailId;
  if (!id || state.currentView !== 'place' || state.accountContextChanged) return Promise.resolve(false);
  if (!force && active && detailRequestIsCurrent(active)) return active.promise;
  active?.controller.abort();
  const request = { placeId:id, owner:principal(), revision:state.navigationRevision,
    token:++generation, controller:new AbortController(), promise:null };
  active = request;
  state.placeDetailResource = { placeId:id, owner:request.owner, status:'loading', message:'' };
  request.promise = (async () => {
    try {
      const place = await api(`/api/v1/places/${encodeURIComponent(id)}`, { signal:request.controller.signal });
      if (!detailRequestIsCurrent(request)) return false;
      // Amap also accepts its raw provider ID; all other IDs must identify this exact place.
      if (!place?.placeId || !place.name || (place.placeId !== id && `amap_${id}` !== place.placeId)) {
        throw new Error('地点资料暂时无法核对，请重试。');
      }
      cachePlaceDetail(id, place, request.owner);
      state.placeDetailResource = { placeId:id, owner:request.owner, status:'ready', message:'' };
      return true;
    } catch (error) {
      if (!detailRequestIsCurrent(request)) return false;
      const missing = error.status === 404 && error.code === 'RESOURCE_NOT_FOUND';
      if (missing) details.delete(id);
      state.placeDetailResource = { placeId:id, owner:request.owner, status:missing ? 'missing' : 'error',
        message:missing ? '地点已不在公开目录中，或链接编号有误。' : error instanceof TypeError ? '网络暂时不可用，请检查连接后重试。' : error.message || '地点资料暂时无法加载，请重试。' };
      return false;
    } finally {
      if (active === request) active = null;
    }
  })();
  return request.promise;
}

/** Refresh only the detail being viewed; a write must not navigate back to its source. */
export async function refreshPlaceDetailAfterMutation(id) {
  invalidatePlaceDetail(id);
  if (state.currentView === 'place' && state.placeDetailId === id) await loadPlaceDetail({ force:true });
}

export function savedPlaceSnapshot(id) {
  return state.favorites?.find(item => item.place?.placeId === id)?.place ||
    state.trip?.snapshot?.stops?.find(stop => stop.place?.placeId === id)?.place ||
    (state.savedPlans || []).flatMap(plan => [...(plan.stops || []), ...(plan.days || []).flatMap(day => day.stops || [])])
      .find(stop => stop.place?.placeId === id)?.place;
}
