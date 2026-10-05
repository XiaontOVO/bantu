import { $, state } from './store.js';
import { loadPlaces } from './loaders.js';
import { loadTracked } from './load-state.js';
import { render } from './render.js';

/** Keep the user's conditions visible while a directory request is pending or fails. */
export async function refreshPlaceSearch() {
  const owner = state.principal?.principalId;
  const view = state.currentView;
  const isSearchPageCurrent = () => owner === state.principal?.principalId && view === state.currentView;
  const places = loadTracked('places', async () => {
    try { await loadPlaces(); }
    catch (error) {
      if (error instanceof TypeError) throw new Error('地点查询失败，请检查网络后重试。搜索与筛选已保留。');
      throw error;
    }
  });
  if (isSearchPageCurrent()) render();
  await places;
  if (isSearchPageCurrent()) render();
}

export async function clearPlaceSearch() {
  state.placeQuery = '';
  state.communityQuery = '';
  if ($('placeSearch')) $('placeSearch').value = '';
  await refreshPlaceSearch();
}

export async function relaxPlaceFilters() {
  // City, keyword and ordering are still useful context; remove only restrictive conditions.
  state.placeCategory = '全部';
  state.communityTag = '';
  state.placeAdvanced = { facilities: [], cost: '', duration: '', rating: '' };
  await refreshPlaceSearch();
}

export function openPlaceFilters() {
  const panel = $('placeFilterPanel');
  if (!panel) return;
  panel.open = true;
  panel.scrollIntoView({ block: 'start', behavior: 'auto' });
  panel.querySelector('summary')?.focus({ preventScroll: true });
}
