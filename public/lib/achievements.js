import { api } from './api.js';
import { state } from './store.js';

let sequence = 0;
export async function loadAchievements() {
  const owner = state.principal?.principalId, request = ++sequence;
  if (state.achievementsOwner !== owner) {
    state.achievements = null; state.achievementSelected = ''; state.achievementFilter = 'all';
  }
  const result = await api('/api/v1/achievements');
  if (request !== sequence || owner !== state.principal?.principalId) return;
  state.achievements = result; state.achievementsOwner = owner;
  if (!result.cards.some(card => card.placeId === state.achievementSelected)) state.achievementSelected = '';
}

export function ownedAchievements() {
  return state.achievementsOwner === state.principal?.principalId ? state.achievements : null;
}
