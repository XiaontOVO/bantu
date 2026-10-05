import { state } from './store.js';

// A post's like/comment writes share a slot so full-post replies stay ordered.
// Favorites have their own slot; unrelated posts never block one another.
const pending = new Map();
function postInteractionOwner() { return state.principal?.principalId || 'guest'; }
function postInteractionKey(id, kind) { return JSON.stringify([postInteractionOwner(), kind === 'favorite' ? 'favorite' : 'engagement', id]); }
export function postInteractionPending(id, kind = 'engagement') {
  if (state.accountContextChanged) return null;
  return pending.get(postInteractionKey(id, kind)) || null;
}
export function beginPostInteraction(id, kind) {
  if (!id || state.accountContextChanged) return null;
  const slot = postInteractionKey(id, kind);
  if (pending.has(slot)) return null;
  const token = { id, kind, owner: postInteractionOwner(), slot };
  pending.set(slot, token);
  return token;
}
export const isCurrentPostInteraction = token => Boolean(token && !state.accountContextChanged &&
  token.owner === postInteractionOwner() && pending.get(token.slot) === token);
export function finishPostInteraction(token) {
  if (token && pending.get(token.slot) === token) pending.delete(token.slot);
}
