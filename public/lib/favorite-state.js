import { state } from './store.js';
import { escapeHtml } from './format.js';

export const isFavorite = id => (state.favorites || []).some(item => item.place.placeId === id);

export function favoriteButton(id) {
  const saved = isFavorite(id);
  return `<button class="btn-small btn-soft favorite-toggle${saved ? ' is-favorite' : ''}" data-action="shortlist" data-place="${escapeHtml(id)}" aria-pressed="${saved}" aria-busy="${state.favoritePending === id}" ${state.favoritePending ? 'disabled' : ''} title="${saved ? '点击取消收藏' : '收藏这个地点'}">${state.favoritePending === id ? '正在保存…' : saved ? '已收藏' : '收藏'}</button>`;
}

export function refreshFavoriteButtons() {
  document.querySelectorAll('[data-action="shortlist"]').forEach(button => {
    const saved = isFavorite(button.dataset.place);
    button.classList.add('favorite-toggle');
    button.classList.toggle('is-favorite', saved);
    button.setAttribute('aria-pressed', String(saved));
    button.disabled = Boolean(state.favoritePending);
    button.setAttribute('aria-busy', String(state.favoritePending === button.dataset.place));
    button.title = saved ? '点击取消收藏' : '收藏这个地点';
    button.textContent = state.favoritePending === button.dataset.place ? '正在保存…' : saved ? '已收藏' : '收藏';
  });
}
