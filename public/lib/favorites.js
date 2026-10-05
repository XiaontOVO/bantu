import { isFavorite, refreshFavoriteButtons } from './favorite-state.js';
import { api } from './api.js';
import { state } from './store.js';
import { render } from './render.js';
import { toast } from './ui.js';
import { loadPlans } from './plan-library.js';
import { cachedPlaceDetail, savedPlaceSnapshot } from './place-detail.js';

let placeFavoritesRead = 0;
let postFavoritesRead = 0;
export async function loadFavorites() {
  const placeRequest = ++placeFavoritesRead;
  const postRequest = ++postFavoritesRead;
  const [favoritesResult, postFavoritesResult] = await Promise.allSettled([
    api('/api/v1/favorites'),
    api('/api/v1/community/post-favorites'),
  ]);
  let succeeded = false;
  if (placeRequest === placeFavoritesRead && favoritesResult.status === 'fulfilled') {
    state.favorites = Array.isArray(favoritesResult.value) ? favoritesResult.value : [];
    succeeded = true;
  }
  if (postRequest === postFavoritesRead && postFavoritesResult.status === 'fulfilled') {
    state.postFavorites = normalizePostFavorites(postFavoritesResult.value);
    succeeded = true;
  }
  try {
    await loadPlans();
  } catch { /* 收藏仍可查看；添加计划时会在保存阶段再次校验当天计划。 */ }
  // 单个收藏源故障不应隐藏另一个收藏源；两个源都失败时保留页面错误提示。
  if (!succeeded && favoritesResult.status === 'rejected' && postFavoritesResult.status === 'rejected') {
    throw favoritesResult.reason;
  }
}

const normalizePostFavorites = (entries) => Array.isArray(entries)
  ? entries.filter(item => item?.post?.postId)
  : [];

export function replacePostFavorites(entries) {
  ++postFavoritesRead;
  state.postFavorites = normalizePostFavorites(entries);
}

export async function toggleFavorite(id) {
  if (state.favoritePending) return;
  state.favoritePending = id;
  refreshFavoriteButtons();
  try {
    // 按按钮展示的状态表达用户意图。POST / DELETE 都是幂等写入，
    // 避免另一标签页更新后，把“收藏”误解释为“取消收藏”。
    const saved = isFavorite(id);
    const updated = await api(saved ? `/api/v1/favorites/${encodeURIComponent(id)}` : '/api/v1/favorites', {
      method: saved ? 'DELETE' : 'POST', ...(saved ? {} : { body: JSON.stringify({ placeId: id }) }) });
    ++placeFavoritesRead; // 写入前发出的旧列表不能覆盖这次结果。
    state.favorites = updated;
    render();
    toast(saved ? '已取消收藏' : '已收藏，可在“我的收藏”查看');
  } finally {
    state.favoritePending = null;
    refreshFavoriteButtons();
  }
}
export function findPlace(id) {
  const known = cachedPlaceDetail(id) || state.mapPlaces?.find(place => place.placeId === id) || state.places.find(place => place.placeId === id)
    || state.placeCatalog?.find(place => place.placeId === id) || savedPlaceSnapshot(id);
  if (known) return known;
  const shared = [...(state.community || []), ...(state.communityMine?.places || [])]
    .find(item => item.status === 'approved' && (item.id === id || item.placeId === id));
  if (!shared) return undefined;
  return {
    placeId: shared.placeId || shared.id, name: shared.name, cityCode: shared.cityCode, address: shared.address,
    description: shared.description, provider: 'community_reviewed', createdAt: shared.createdAt,
    coordinates: shared.coordinateCrs === 'WGS84' && Number.isFinite(shared.lat) && Number.isFinite(shared.lng)
      ? { lat: shared.lat, lng: shared.lng, source: 'community' } : null,
    category: 'unknown', facilityCodes: [], openingIntervals: [], suggestedDurationMinutes: null,
    costEstimate: null, tags: shared.tags || [], reviews: shared.reviews || [],
  };
}
