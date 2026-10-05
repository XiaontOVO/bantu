import { state } from './store.js';

const artworkStates = new Map();
const imageBindings = new WeakMap();
function artworkIdentity(scene) {
  return JSON.stringify([state.principal?.principalId || '', scene?.placeId, scene?.id, scene?.version, scene?.artwork]);
}

export function sceneArtworkState(scene = state.sceneData) {
  const key = artworkIdentity(scene);
  if (!artworkStates.has(key)) artworkStates.set(key, { status: 'loading', attempt: 0, textMode: false });
  return artworkStates.get(key);
}

export function sceneArtworkSource(scene = state.sceneData) {
  const attempt = sceneArtworkState(scene).attempt;
  if (!attempt) return scene.artwork;
  const [source, fragment] = scene.artwork.split('#');
  return `${source}${source.includes('?') ? '&' : '?'}scene_retry=${attempt}${fragment === undefined ? '' : `#${fragment}`}`;
}

function applyArtworkState(root, record) {
  const textView = record.status !== 'ready' || record.textMode;
  root.dataset.artworkStatus = record.status;
  root.dataset.artworkText = String(record.textMode);
  document.body?.classList?.toggle('scene-text-active', textView);
  const stage = root.querySelector('.scene-stage');
  stage?.setAttribute('aria-busy', String(record.status === 'loading'));
  root.querySelectorAll('.scene-hotspot').forEach(button => { button.disabled = textView; });
  const fallback = root.querySelector('[data-scene-artwork-state]');
  const restoreArtworkFocus = !textView && fallback?.contains?.(document.activeElement);
  if (fallback) fallback.hidden = !textView;
  const heading = root.querySelector('[data-scene-artwork-heading]');
  if (heading) heading.textContent = record.status === 'error' ? '画面暂时没有加载出来' : record.status === 'loading' ? '正在铺开画面…' : '换一种方式，慢慢看';
  const message = root.querySelector('[data-scene-artwork-message]');
  if (message) message.textContent = record.status === 'error' ? '可以重新加载画面，也可以先探索下面的文字主题。' : record.status === 'loading' ? '画面准备期间，也可以先听听这个地点的故事。' : '点击主题，继续查看和收听介绍。';
  const topics = root.querySelector('[data-scene-text-topics]');
  if (topics) topics.hidden = record.status !== 'error' && !record.textMode;
  const show = root.querySelector('[data-action="show-scene-text"]');
  if (show) show.hidden = record.status === 'error' || record.textMode;
  const hide = root.querySelector('[data-action="hide-scene-text"]');
  if (hide) hide.hidden = record.status !== 'ready';
  const retry = root.querySelector('[data-action="retry-scene-artwork"]');
  if (retry) retry.hidden = record.status === 'ready';
  if (restoreArtworkFocus) stage?.focus({ preventScroll: true });
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('bantu:scene-artwork-layout'));
}

/** Image outcomes update only this mounted scene, without recreating its media or story. */
export function mountSceneArtwork(root = globalThis.document) {
  if (state.currentView !== 'scene') { document.body?.classList?.remove('scene-text-active'); return; }
  const scene = state.sceneData;
  const host = root?.querySelector?.('.place-scene');
  const image = host?.querySelector('.scene-artwork');
  if (!scene || scene.placeId !== state.scenePlaceId || !image) return;
  imageBindings.get(image)?.();
  const key = artworkIdentity(scene), revision = state.navigationRevision;
  const record = sceneArtworkState(scene), attempt = record.attempt;
  const artworkCurrent = () => image.isConnected && state.currentView === 'scene' &&
    state.scenePlaceId === scene.placeId && artworkIdentity(state.sceneData) === key && state.navigationRevision === revision && record.attempt === attempt;
  const artworkLoaded = () => {
    if (!artworkCurrent() || !image.complete || !image.naturalWidth) return;
    record.status = 'ready'; applyArtworkState(host, record);
  };
  const artworkFailed = () => {
    if (!artworkCurrent() || !image.complete || image.naturalWidth) return;
    record.status = 'error'; applyArtworkState(host, record);
  };
  image.addEventListener('load', artworkLoaded); image.addEventListener('error', artworkFailed);
  imageBindings.set(image, () => { image.removeEventListener('load', artworkLoaded); image.removeEventListener('error', artworkFailed); });
  if (image.getAttribute('src')) {
    if (image.complete) image.naturalWidth ? artworkLoaded() : artworkFailed();
    else { record.status = 'loading'; applyArtworkState(host, record); }
  } else applyArtworkState(host, record);
}

export function retrySceneArtwork() {
  if (state.currentView !== 'scene' || state.accountContextChanged || document.hidden) return;
  const image = document.querySelector('.place-scene .scene-artwork');
  if (!image || state.sceneData?.placeId !== state.scenePlaceId) return;
  const record = sceneArtworkState();
  record.attempt++; record.status = 'loading';
  const next = image.cloneNode(false);
  next.removeAttribute('src');
  imageBindings.get(image)?.();
  image.replaceWith(next);
  mountSceneArtwork();
  next.src = sceneArtworkSource();
}

export function showSceneTextExploration(enabled = true) {
  if (state.currentView !== 'scene' || state.accountContextChanged || document.hidden) return;
  const host = document.querySelector('.place-scene');
  if (!host) return;
  const record = sceneArtworkState(); record.textMode = enabled;
  applyArtworkState(host, record);
  (enabled ? host.querySelector('[data-scene-text-topics] button') : host.querySelector('.scene-stage'))?.focus({ preventScroll: true });
}
