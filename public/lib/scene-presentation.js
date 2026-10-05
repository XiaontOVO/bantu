import { state } from './store.js';
import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';
import { openSheet, toast } from './ui.js';
import { render } from './render.js';
import { stopSceneSpeech } from './scene-sound.js';
import { nativeSceneFullscreenAvailable, setNativeSceneFullscreen } from './native-shell.js';

let ownsFullscreen = false;
let ownsNativeFullscreen = false;
let fullscreenBound = false;
let enteringFullscreen = false;
let immersiveGeneration = 0;

export async function enterSceneImmersive() {
  if (state.currentView !== 'scene' || state.accountContextChanged || document.hidden) return;
  if (ownsFullscreen || ownsNativeFullscreen || enteringFullscreen) {
    releaseSceneFullscreen();
    render();
    return;
  }
  const revision = state.navigationRevision;
  const owner = state.principal?.principalId;
  const token = ++immersiveGeneration;
  const isCurrentImmersiveRequest = () => token === immersiveGeneration && state.currentView === 'scene' &&
    revision === state.navigationRevision && owner === state.principal?.principalId && !state.accountContextChanged && !document.hidden;
  enteringFullscreen = true;
  if (nativeSceneFullscreenAvailable()) {
    const active = await setNativeSceneFullscreen(true);
    if (!isCurrentImmersiveRequest()) {
      if (token === immersiveGeneration) releaseSceneFullscreen();
      return;
    }
    enteringFullscreen = false;
    ownsNativeFullscreen = active;
    state.sceneFullscreenActive = active;
    render();
    if (!active) toast('横屏探索暂未打开，请再试一次。', 'error');
    return;
  }
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
      if (!isCurrentImmersiveRequest()) {
        if (token === immersiveGeneration) releaseSceneFullscreen();
        // A late request must not close a newer scene's fullscreen session.
        if (!ownsFullscreen && !enteringFullscreen && document.fullscreenElement === document.documentElement) await document.exitFullscreen().catch(() => {});
        return;
      }
      ownsFullscreen = true;
      if (!fullscreenBound) {
        fullscreenBound = true;
        document.addEventListener('fullscreenchange', () => {
          const previousActive = state.sceneFullscreenActive;
          const active = Boolean(ownsFullscreen && document.fullscreenElement === document.documentElement);
          if (!document.fullscreenElement && ownsFullscreen) releaseSceneFullscreen();
          if (previousActive !== active) { state.sceneFullscreenActive = active; if (state.currentView === 'scene') render(); }
        });
      }
    }
    if (!isCurrentImmersiveRequest()) {
      releaseSceneFullscreen();
      return;
    }
    if (ownsFullscreen && screen.orientation?.lock) await screen.orientation.lock('landscape');
  } catch { /* Browsers without orientation locking retain natural rotation. */ }
  if (!isCurrentImmersiveRequest()) {
    if (token === immersiveGeneration) releaseSceneFullscreen();
    // Locking can finish after navigation already unlocked the screen.
    else if (!ownsFullscreen && !enteringFullscreen) screen.orientation?.unlock?.();
    return;
  }
  enteringFullscreen = false;
  state.sceneFullscreenActive = Boolean(ownsFullscreen && document.fullscreenElement === document.documentElement);
  if (state.currentView === 'scene') render();
  if (state.currentView === 'scene' && matchMedia('(orientation:portrait)').matches) {
    toast('横过手机，就能展开画面探索。');
  }
}

export function releaseSceneFullscreen() {
  immersiveGeneration++;
  const hadNativeOwnership = ownsNativeFullscreen || enteringFullscreen && nativeSceneFullscreenAvailable();
  const hadOwnership = ownsFullscreen || enteringFullscreen && !hadNativeOwnership;
  ownsFullscreen = false;
  ownsNativeFullscreen = false;
  enteringFullscreen = false;
  state.sceneFullscreenActive = false;
  if (hadNativeOwnership) void setNativeSceneFullscreen(false);
  if (hadOwnership) screen.orientation?.unlock?.();
  if (hadOwnership && document.fullscreenElement === document.documentElement) void document.exitFullscreen().catch(() => {});
}

export function dismissSceneStory() {
  state.sceneStoryOpen = false;
  stopSceneSpeech({source:'scene'});
  render();
  document.querySelector('.scene-hotspot.is-active')?.focus({preventScroll:true});
}

export function openSceneDetails() {
  const scene = state.sceneData;
  if (state.currentView !== 'scene' || !scene) return;
  const selected = scene.hotspots.find(item => item.id === state.sceneSelectedHotspotId);
  const narration = state.sceneNarration?.hotspotId === (selected?.id || '') ? state.sceneNarration : null;
  openSheet(`<section class="scene-details-panel"><div class="row-between row-center"><h3>${escapeHtml(selected?.title || scene.placeName)}</h3><button type="button" class="action-icon" data-action="close-sheet" aria-label="关闭地点资料">${uiIcon('close',{size:20})}</button></div>
    ${selected ? `<p>${escapeHtml(selected.detail)}</p><details class="scene-evidence"><summary>资料依据</summary><p>${escapeHtml(selected.evidence)} · 核对 ${escapeHtml(selected.checkedAt)}</p></details>` : `<p>${escapeHtml(scene.introduction)}</p>`}
    ${narration?.source === 'model' && narration.text ? `<p class="scene-agent-narration">${uiIcon('agent',{size:18})}<span>${escapeHtml(narration.text)}</span></p>` : ''}
${state.sceneVisited?.length ? `<div class="scene-explored"><span>已探索 ${state.sceneVisited.length} / ${scene.hotspots.length} 处</span><button type="button" class="btn-soft" data-action="ask-scene-recap-agent">整理为私人记忆</button></div>` : ''}
    <h4>继续探索</h4><div class="scene-accessible-elements">${scene.hotspots.map(item => `<button type="button" class="btn-soft" data-action="explore-scene-element" data-hotspot="${escapeHtml(item.id)}">${escapeHtml(item.title)}${item.floor ? ` · ${escapeHtml(item.floor)}资料` : ''}</button>`).join('')}</div>
    <details class="scene-source-notes"><summary>画作与资料说明</summary><p>AI 艺术场景用于感受与探索，找路请使用地图。</p><p>${escapeHtml(scene.evidenceNote)}</p></details></section>`);
}
