import { state } from './store.js';
import { loadPlans } from './plan-library.js';
import { loadPlaces, loadAllMemories, loadCommunity } from './loaders.js';
import { loadFavorites } from './favorites.js';
import { api } from './api.js';

async function loadAgentProfile() {
  const principal = state.principal;
  const profile = await api('/api/v1/me');
  if (state.principal !== principal || !principal || profile.principalId !== principal.principalId) return;
  principal.nickname = profile.nickname;
}

const loaders = { plans: loadPlans, places: loadPlaces, memories: loadAllMemories, community: loadCommunity, favorites: loadFavorites, profile: loadAgentProfile };
const activeBatches = new Map();

/** Retry reads only: a failed view refresh must never replay a committed Agent command. */
export function syncAgentViews(refresh = []) {
  const principal = state.principal;
  if (state.agentViewSync?.principal !== principal) state.agentViewSync = null;
  const keys = [...new Set([...(state.agentViewSync?.refresh || []), ...refresh])].filter(key => Object.hasOwn(loaders, key));
  if (keys.length) state.agentViewSync = { principal, refresh: keys };
  const active = activeBatches.get(principal);
  if (active) return active;
  if (!keys.length) return Promise.resolve(false);
  const promise = (async () => {
    let succeeded = false, next = keys;
    const failedReads = new Set();
    // Drain one queued batch; failed reads remain explicitly retryable, never replay writes.
    for (let round=0; round<2 && next.length; round++) {
      if (state.principal !== principal) return false;
      state.agentViewSync = {principal,refresh:[]};
      const results = await Promise.allSettled(next.map(key => loaders[key]()));
      if (state.principal !== principal) return false;
      succeeded ||= results.some(result => result.status === 'fulfilled');
      next.forEach((key,index) => {
        if (results[index].status === 'rejected') failedReads.add(key);
        else failedReads.delete(key);
      });
      const queued = state.agentViewSync?.principal === principal ? state.agentViewSync.refresh : [];
      const remaining = [...new Set([...queued,...failedReads])];
      state.agentViewSync = remaining.length ? {principal,refresh:remaining} : null;
      next = [...new Set(queued)];
    }
    return succeeded;
  })().finally(() => { if (activeBatches.get(principal) === promise) activeBatches.delete(principal); });
  activeBatches.set(principal,promise);
  return promise;
}
