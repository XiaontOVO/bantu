import { state } from './store.js';

const lastTripStorageKey = () => state.principal?.principalId ? `bantu:last-trip:${state.principal.principalId}` : null;
const tripInfo = (entry) => entry?.trip || entry || {};

export function rememberTrip(id) {
  const name = lastTripStorageKey();
  if (!name) return;
  try { if (id) localStorage.setItem(name, id); else localStorage.removeItem(name); } catch {}
}

export function restoredTripId() {
  let saved;
  try { saved = lastTripStorageKey() ? localStorage.getItem(lastTripStorageKey()) : null; } catch {}
  // 只从当前身份的服务端旅行列表选择，删除或其他账号的 ID 不可恢复。
  const match = state.trips.find(trip => tripInfo(trip).tripId === saved);
  return tripInfo(match).tripId || tripInfo(state.trips[0]).tripId || null;
}
