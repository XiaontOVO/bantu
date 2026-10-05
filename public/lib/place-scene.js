import { releaseSceneFullscreen } from './scene-presentation.js';
import { scenePreferences, saveScenePreference } from './scene-preferences.js';
import { api } from './api.js';
import { state } from './store.js';
import { navigate, render } from './render.js';
import { toast, openSheet } from './ui.js';
import { companionTarget } from './day-plan-selection.js';
import { resolveStopPlace } from './components.js';
import { hasPlaceScene } from './place-scene-catalog.js';
import { advanceSceneArrival, advanceSceneDeparture, sceneArrivalPreference, sceneDeparturePreference, setSceneArrivalPreference, setSceneDeparturePreference, SCENE_DWELL_MS, SCENE_DEPARTURE_DWELL_MS } from './scene-arrival.js';
import { startSceneSound, stopSceneSound, stopSceneSpeech, sceneSoundPlaying, sceneSoundStarting, speakSceneText } from './scene-sound.js';
import { findPlace } from './favorites.js';
import { tourFor } from './place-tour-data.js';
import { buildingSheetHtml, rememberBuildingFloor, tourSectionHtml } from './place-tour.js';
import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';
import { openAgentDock } from './agent-dock.js';
import { sceneTimingCandidate } from './scene-timing.js';
import { smartCompanionEnabled } from './smart-companion-preferences.js';

let arrivalWatch = null;
let arrivalKey = '';
let arrivalState = null;
let arrivalLoading = false;
let arrivalGeneration = 0;
let arrivalLoadController = null;
let arrivalRecheckTimer = null;
let introTimer = null;
let timingTimer = null;
let departureWatch = null;
let departureKey = '';
let departureState = null;
let departureRecheckTimer = null;
let departurePending = null;
const openedVisits = new Set();
let musicRequestGeneration = 0;
let narrationGeneration = 0;
let narrationController = null;
let sceneLoadGeneration = 0;
let activeSceneLoad = null;

function sceneForeground() {
  return !document.hidden && !state.accountContextChanged;
}

function cancelSceneNarration() {
  narrationGeneration++;
  narrationController?.abort();
  narrationController = null;
}

async function beginSceneMusic({ reportError = false } = {}) {
  if (state.currentView !== 'scene' || !sceneForeground()) return;
  const token = ++musicRequestGeneration;
  const owner = state.principal?.principalId;
  const placeId = state.scenePlaceId;
  const revision = state.navigationRevision;
  const quiet = state.sceneQuiet;
  const pending = startSceneSound(state.sceneData?.soundTheme);
  render();
  const started = await pending;
  if (token !== musicRequestGeneration || !sceneForeground() || state.currentView !== 'scene' ||
      owner !== state.principal?.principalId || placeId !== state.scenePlaceId || revision !== state.navigationRevision ||
      quiet !== state.sceneQuiet || !scenePreferences(owner).music) return;
  if (started === false && reportError) toast('当前设备暂时无法播放场景音乐，请重试。', 'error');
  render();
}

function stopIntroTimer() {
  if (introTimer) clearTimeout(introTimer);
  introTimer = null;
}

export async function loadPlaceScene(placeId, { signal } = {}) {
  if (!placeId) throw new Error('请先选择地点。');
  const scene = await api(`/api/v1/places/${encodeURIComponent(placeId)}/scene`, { signal });
  if (scene?.placeId !== placeId || !scene?.hotspots?.length) throw new Error('这个地点的现场体验暂未完成。');
  return scene;
}

function sceneSourceIdentity() {
  if(state.currentView==='home') {
    const target=companionTarget(state.savedPlans || [],state.companionPlanId);
    return target.plan&&target.next?`${target.plan.id}:${target.plan.revision || 0}:${target.next.stopId}:${target.phase}`:'';
  }
  return { place:state.placeDetailId, scene:state.scenePlaceId, 'post-detail':state.postDetailId, 'plan-history':state.planHistoryId }[state.currentView] || '';
}

function sceneLoadContextIsCurrent(request) {
  return sceneForeground() && request.owner === state.principal?.principalId && request.revision === state.navigationRevision &&
    request.view === state.currentView && request.sourceIdentity === sceneSourceIdentity();
}

function beginSceneLoad(automatic = false, placeId = state.scenePlaceId) {
  activeSceneLoad?.controller.abort();
  state.sceneEntryPending = null;
  const request = { token:++sceneLoadGeneration, automatic, placeId, sourceIdentity:sceneSourceIdentity(), owner:state.principal?.principalId, revision:state.navigationRevision,
    view:state.currentView, controller:new AbortController() };
  activeSceneLoad = request;
  return request;
}

function sceneLoadIsCurrent(request) {
  return request.token === sceneLoadGeneration && !request.controller.signal.aborted && sceneLoadContextIsCurrent(request);
}

function finishSceneLoad(request) {
  if (activeSceneLoad === request) activeSceneLoad = null;
  if (state.sceneEntryPending?.token === request.token) {
    state.sceneEntryPending = null;
    if (sceneEntryDisplayed(request)) render();
  }
}

function sceneEntryDisplayed(record) {
  if(!record || !sceneLoadContextIsCurrent(record))return false;
  if(record.view==='place')return record.placeId===state.placeDetailId;
  if(record.view==='home') {
    const target=companionTarget(state.savedPlans || [],state.companionPlanId);
    return target.phase==='visit'&&record.placeId===resolveStopPlace(target.next)?.placeId;
  }
  return false;
}

function sceneEntryRecord(request) {
  const { token, placeId, owner, revision, view, sourceIdentity } = request;
  return { token, placeId, owner, revision, view, sourceIdentity };
}

export function sceneEntryPendingFor(placeId) {
  const record = state.sceneEntryPending;
  return record?.placeId === placeId && activeSceneLoad?.token === record.token && sceneEntryDisplayed(record) ? record : null;
}

export function sceneEntryErrorFor(placeId) {
  const record = state.sceneEntryError;
  return record?.placeId === placeId && sceneEntryDisplayed(record) ? record : null;
}

function invalidateSceneLoad() {
  sceneLoadGeneration++;
  activeSceneLoad?.controller.abort();
  activeSceneLoad = null;
  state.sceneEntryPending = null;
}

export function syncSceneEntryNavigation() {
  if (activeSceneLoad && !activeSceneLoad.automatic && state.sceneEntryPending?.token === activeSceneLoad.token &&
      !sceneLoadIsCurrent(activeSceneLoad)) invalidateSceneLoad();
}

export function cancelSceneEntry(placeId) {
  const request = activeSceneLoad;
  if (!request || request.automatic || request.placeId !== placeId || !sceneLoadIsCurrent(request)) return;
  const displayed = sceneEntryDisplayed(request);
  invalidateSceneLoad();
  if (displayed) {
    render();
    requestAnimationFrame(() => {
      if (!sceneEntryDisplayed(request) || state.sceneEntryPending) return;
      [...document.querySelectorAll('[data-action="open-place-scene"]')].find(button => button.dataset.place === placeId)?.focus({ preventScroll:true });
    });
  }
}

function automaticSceneEntryAllowed(placeId, visit = currentSceneVisit()) {
  const owner = state.principal?.principalId;
  const currentVisit = currentSceneVisit();
  return Boolean(owner && sceneForeground() && sceneArrivalPreference(owner) === 'on' &&
    (!activeSceneLoad || activeSceneLoad.automatic || !sceneLoadIsCurrent(activeSceneLoad)) &&
    visit && currentVisit?.stopId === visit.stopId && currentVisit.placeId === placeId &&
    state.currentView !== 'scene' && state.currentView !== 'agent' && !state.agentDockOpen &&
    !state.chatPending && !state.chatImagesBusy && !state.planDraft && !state.planEdit &&
    !document.querySelector('#sheetBackdrop:not([hidden])') &&
    !document.activeElement?.matches?.('input, textarea, [contenteditable]'));
}

function stopSceneActivity() {
  musicRequestGeneration++;
  cancelSceneNarration();
  stopIntroTimer();
  stopSceneTimingWatch();
  stopSceneDepartureWatch();
  stopSceneSound();
}

function activateScene(scene, { returnView = 'place', navigateToScene = false } = {}) {
  const owner = state.principal?.principalId;
  const placeId = scene.placeId;
  const visit = currentSceneVisit();
  const sessionKey = `${owner || 'guest'}:${visit?.placeId === placeId ? visit.stopId : `manual:${placeId}`}`;
  const resuming = state.sceneSessionKey === sessionKey && state.sceneData?.placeId === placeId &&
    state.sceneData.id === scene.id && state.sceneData.version === scene.version;
  if (!resuming) stopSceneActivity();
  if (navigateToScene || !resuming) state.sceneReturnView = returnView === 'scene' ? 'place' : returnView;
  state.scenePlaceId = placeId;
  state.sceneData = scene;
  if (!resuming) {
    state.sceneSelectedHotspotId = '';
    state.sceneStoryOpen = true;
    state.sceneNarration = null;
    state.sceneVisited = [];
    state.sceneQuiet = scenePreferences(owner).quiet;
    state.scenePromptCount = 0;
    state.sceneLastPromptAt = 0;
    state.sceneTimingCue = null;
    state.sceneTimingDismissedKey = '';
    state.sceneDepartureCue = null;
    state.sceneDepartureDismissedKey = '';
    const target = companionTarget(state.savedPlans || [], state.companionPlanId);
    const urgent = sceneTimingCandidate(target.plan, target.next, placeId);
    if (urgent) {
      state.sceneTimingCue = urgent;
      state.scenePromptCount = 1;
      state.sceneLastPromptAt = Date.now();
    }
  }
  state.sceneSessionKey = sessionKey;
  if (visit?.placeId === placeId && owner) openedVisits.add(`${owner}:${visit.stopId}`);
  stopSceneArrivalWatch();
  if (navigateToScene) navigate('scene');
  else render();
  if (!resuming && !state.sceneTimingCue) void requestSceneNarration('welcome');
  scheduleGentleNudge();
}

export async function openPlaceScene(placeId, { automatic = false, returnView = state.currentView } = {}) {
  if (!sceneForeground()) return;
  const visit = automatic ? currentSceneVisit() : null;
  if (automatic && !automaticSceneEntryAllowed(placeId, visit)) return;
  const request = beginSceneLoad(automatic, placeId);
  if (!automatic) {
    state.sceneEntryError = null;
    state.sceneEntryPending = sceneEntryRecord(request);
    if (sceneEntryDisplayed(request)) render();
  }
  let activated = false;
  let failed = false;
  try {
    const scene = await loadPlaceScene(placeId, { signal:request.controller.signal });
    if (!sceneLoadIsCurrent(request) || automatic && !automaticSceneEntryAllowed(placeId, visit)) return;
    activateScene(scene, { returnView, navigateToScene:true });
    activated = true;
  } catch (error) {
    if (sceneLoadIsCurrent(request)) {
      if (automatic) {
        if (automaticSceneEntryAllowed(placeId, visit)) {
          failed = true;
          toast(error.message || '地点现场暂时无法自动打开，可在地点页重试。', 'error');
        }
      }
      else {
        if (sceneEntryDisplayed(request)) state.sceneEntryError = { ...sceneEntryRecord(request),
          message:error?.name === 'TypeError' ? '网络暂时不可用，请重试。' : error?.message || '场景暂时无法打开，请重试。' };
        throw error;
      }
    }
  } finally {
    finishSceneLoad(request);
    if (automatic && !activated && !failed && request.token === sceneLoadGeneration &&
        request.owner === state.principal?.principalId && sceneForeground()) void startSceneArrivalWatch();
  }
}

export async function loadDeepLinkedScene() {
  const placeId = state.scenePlaceId;
  if (!placeId || state.currentView !== 'scene' || !sceneForeground()) return;
  const request = beginSceneLoad();
  if (state.sceneData?.placeId !== placeId) {
    state.sceneReturnView = 'place';
    stopSceneActivity();
  }
  try {
    const scene = await loadPlaceScene(placeId, { signal:request.controller.signal });
    if (!sceneLoadIsCurrent(request) || state.scenePlaceId !== placeId) return;
    activateScene(scene);
  } catch (error) {
    if (sceneLoadIsCurrent(request) && state.scenePlaceId === placeId) {
      state.sceneData = null;
      toast(error.message || '地点现场暂时无法打开。', 'error');
      state.placeDetailId = placeId;
      navigate('place');
    }
  } finally { finishSceneLoad(request); }
}

export function leavePlaceScene() {
  invalidateSceneLoad();
  releaseSceneFullscreen();
  stopSceneActivity();
  if (state.sceneTimingCue) state.sceneTimingDismissedKey = state.sceneTimingCue.key;
  state.sceneTimingCue = null;
  if (state.sceneDepartureCue) state.sceneDepartureDismissedKey = state.sceneDepartureCue.key;
  state.sceneDepartureCue = null;
  stopSceneSound();
  const target = state.sceneReturnView && state.sceneReturnView !== 'scene' ? state.sceneReturnView : 'place';
  if (target === 'place') state.placeDetailId = state.scenePlaceId;
  navigate(target);
}

export function selectedSceneHotspot() {
  if (state.sceneData?.placeId !== state.scenePlaceId) return null;
  return state.sceneData?.hotspots?.find(item => item.id === state.sceneSelectedHotspotId) || null;
}

export function selectSceneHotspot(id) {
  const hotspot = state.sceneData?.hotspots?.find(item => item.id === id);
  if (!hotspot || state.sceneData?.placeId !== state.scenePlaceId || state.currentView !== 'scene' || !sceneForeground()) return;
  state.sceneSelectedHotspotId = id;
  state.sceneStoryOpen = true;
  state.sceneNarration = null;
  if (!state.sceneVisited.includes(id)) state.sceneVisited = [...state.sceneVisited, id];
  stopIntroTimer();
  const prefs = scenePreferences(state.principal?.principalId);
  if (!prefs.quiet) {
    if (prefs.music) void beginSceneMusic({ reportError:true });
    if (prefs.narration) speakSceneText(hotspot.story || `${hotspot.summary} ${hotspot.detail}`, {voice:prefs.voice});
  }
  render();
  void requestSceneNarration('hotspot', id);
}

export async function requestSceneNarration(moment, hotspotId = '') {
  if (!sceneForeground() || state.currentView !== 'scene' || !state.sceneData || state.sceneData.placeId !== state.scenePlaceId || state.sceneQuiet && moment !== 'hotspot') return;
  if (moment !== 'hotspot' && (state.scenePromptCount >= 3 || state.sceneLastPromptAt && Date.now() - state.sceneLastPromptAt < 8 * 60_000)) return;
  cancelSceneNarration();
  const token = narrationGeneration;
  const controller = new AbortController();
  narrationController = controller;
  const placeId = state.scenePlaceId;
  const sceneVersion = state.sceneData.version;
  const navigationRevision = state.navigationRevision;
  const owner = state.principal?.principalId;
  if (moment !== 'hotspot') { state.scenePromptCount++; state.sceneLastPromptAt = Date.now(); }
  try {
    const result = await api(`/api/v1/places/${encodeURIComponent(placeId)}/scene/narration`, {
      method: 'POST', signal: controller.signal, body: JSON.stringify({ moment, ...(hotspotId ? { hotspotId } : {}), sceneVersion }),
    });
    if (token !== narrationGeneration || !sceneForeground() || state.currentView !== 'scene' || state.scenePlaceId !== placeId || state.sceneData?.version !== sceneVersion ||
        state.navigationRevision !== navigationRevision || state.principal?.principalId !== owner ||
        (hotspotId && state.sceneSelectedHotspotId !== hotspotId) || state.sceneQuiet && moment !== 'hotspot') return;
    state.sceneNarration = { ...result, hotspotId };
    render();
  } catch { /* Curated, source-labelled scene text remains available. */ }
  finally { if (narrationController === controller) narrationController = null; }
}

function scheduleGentleNudge() {
  stopIntroTimer();
  const placeId = state.scenePlaceId;
  introTimer = setTimeout(() => {
    introTimer = null;
    if (state.currentView !== 'scene' || state.scenePlaceId !== placeId || state.sceneVisited.length ||
        state.chatPending || state.agentDockOpen || state.sceneQuiet || !sceneForeground()) return;
    void requestSceneNarration('nudge');
  }, 8 * 60_000);
}

export function refreshSceneTimingCue() {
  if (!sceneForeground() || state.currentView !== 'scene' || !state.sceneData || state.sceneData.placeId !== state.scenePlaceId || state.sceneDepartureCue) return;
  const target = companionTarget(state.savedPlans || [], state.companionPlanId);
  const candidate = sceneTimingCandidate(target.plan, target.next, state.scenePlaceId);
  if (state.sceneTimingCue && (!candidate || candidate.key !== state.sceneTimingCue.key || state.sceneQuiet)) {
    state.sceneTimingCue = null;
    render();
    return;
  }
  if (!candidate || state.sceneTimingCue || state.sceneTimingDismissedKey === candidate.key || state.sceneQuiet ||
      document.hidden || state.chatPending || state.agentDockOpen || state.planDraft ||
      typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking ||
      state.scenePromptCount >= 3 || state.sceneLastPromptAt && Date.now() - state.sceneLastPromptAt < 8 * 60_000) return;
  state.sceneTimingCue = candidate;
  state.scenePromptCount++;
  state.sceneLastPromptAt = Date.now();
  render();
}

function stopSceneTimingWatch() {
  if (timingTimer) clearInterval(timingTimer);
  timingTimer = null;
}

export function syncSceneTimingWatch() {
  if (state.currentView !== 'scene' || !sceneForeground()) { stopSceneTimingWatch(); return; }
  if (!timingTimer) timingTimer = setInterval(refreshSceneTimingCue, 30_000);
}

export function dismissSceneTimingCue() {
  if (!state.sceneTimingCue) return;
  state.sceneTimingDismissedKey = state.sceneTimingCue.key;
  state.sceneTimingCue = null;
  render();
}

export async function askSceneTimingAgent() {
  dismissSceneTimingCue();
  await openAgentDock({ prefill: '请核对我当前日计划、这个地点的计划结束时间和现在的时间，帮我判断接下来先了解哪个已收录的现场元素；如果后续安排需要调整，请使用工具实际保存并给出回执。不要把我查看场景当作已到达或完成。' });
}

export async function askSceneRecapAgent() {
  const scene = state.sceneData;
  const titles = scene?.hotspots?.filter(item => state.sceneVisited.includes(item.id)).map(item => item.title) || [];
  if (!scene || !titles.length) return;
  await openAgentDock({ prefill: `请将我在伴途的「${scene.placeName}」地点现场点开查看的资料点（${titles.join('、')}）整理成一条私人旅行记忆并保存。只记录我在应用中查看了这些资料，不推断我实地到达、进入楼层、看到了展品或产生了感受；保存后给我实际回执。` });
}

export async function togglePlaceSceneSound() {
  if (state.currentView !== 'scene' || !sceneForeground()) return;
  if (sceneSoundPlaying() || sceneSoundStarting()) {
    musicRequestGeneration++;
    stopSceneSound({speech:false});
    saveScenePreference(state.principal?.principalId,'music',false);
  }
  else {
    saveScenePreference(state.principal?.principalId,'music',true);
    await beginSceneMusic({ reportError:true });
    return;
  }
  render();
}

export function speakPlaceSceneStory() {
  if (state.currentView !== 'scene' || !sceneForeground()) return;
  const selected = selectedSceneHotspot();
  const curated = selected?.story || selected?.detail || state.sceneData?.introduction || '';
  const narration = state.sceneNarration?.hotspotId === (selected?.id || '') && state.sceneNarration?.source === 'model'
    ? state.sceneNarration.text : '';
  const text = !selected?.story && narration && narration !== curated ? `${curated} ${narration}` : curated;
  if (!speakSceneText(text, {voice:scenePreferences(state.principal?.principalId).voice})) toast('当前浏览器暂时无法朗读，请阅读下方文字。', 'error');
}

export function toggleSceneAutoEnter() {
  const owner = state.principal?.principalId;
  const enabled = sceneArrivalPreference(owner) !== 'on';
  if (!setSceneArrivalPreference(owner, enabled)) { toast('当前浏览器无法保存自动进入设置。', 'error'); return; }
  if (!enabled && activeSceneLoad?.automatic) {
    invalidateSceneLoad();
  }
  startSceneArrivalWatch();
  render();
  toast(enabled ? '已开启到场自动进入；只在应用前台检测。' : '已关闭到场自动进入。');
}

export function toggleSceneQuiet() {
  const enabled = !scenePreferences(state.principal?.principalId).quiet;
  if (!saveScenePreference(state.principal?.principalId,'quiet',enabled)) { toast('设置未能保存，请重试。','error'); return; }
  state.sceneQuiet = enabled;
  if (state.sceneQuiet) {
    musicRequestGeneration++;
    cancelSceneNarration();
    stopSceneSound();
    stopIntroTimer();
    if (state.sceneTimingCue) state.sceneTimingDismissedKey = state.sceneTimingCue.key;
    state.sceneTimingCue = null;
    if (state.sceneDepartureCue) state.sceneDepartureDismissedKey = state.sceneDepartureCue.key;
    state.sceneDepartureCue = null;
    stopSceneDepartureWatch();
  }
  else scheduleGentleNudge();
  render();
}

export function openSceneMap(floor = '') {
  const placeId = state.scenePlaceId;
  const place = findPlace(placeId);
  if (state.currentView !== 'scene' || !place) { toast('场地资料暂不可用，请稍后重试。', 'error'); return; }
  stopSceneSpeech({ source: 'scene' });
  const building = floor && tourFor(place).buildings.find(item => item.floors?.some(level => level.name === floor));
  if (building) {
    rememberBuildingFloor(place, building.id, building.floors.findIndex(item => item.name === floor));
    openSheet(buildingSheetHtml(place, building.id));
    return;
  }
  openSheet(`<section class="scene-map-panel"><div class="sheet-head"><h3>${escapeHtml(place.name)} · 场地总览</h3><button type="button" class="action-icon" data-action="close-sheet" aria-label="返回地点场景">${uiIcon('close', { size: 20 })}</button></div>${tourSectionHtml(place)}</section>`);
}

export async function askSceneAgent(hotspotId = '', note = false) {
  const hotspot = state.sceneData?.hotspots?.find(item => item.id === hotspotId) || selectedSceneHotspot();
  const prompt = note && hotspot ? `请保存一条私人旅行笔记：我想记住${state.sceneData.placeName}的「${hotspot.title}」。保存后告诉我实际结果，不要编造我的感受。`
    : hotspot ? `介绍一下我正在查看的「${hotspot.title}」，并根据我今天的安排建议下一步。` : `我正在看${state.sceneData?.placeName || '这个地点'}的地点现场，应该从哪里开始？`;
  await openAgentDock({ prefill: prompt });
}

function currentSceneVisit() {
  const target = companionTarget(state.savedPlans || [], state.companionPlanId);
  const stop = target.next;
  const place = resolveStopPlace(stop);
  if (!stop?.stopId || !place?.placeId || !hasPlaceScene(place)) return null;
  return { stopId: stop.stopId, placeId: place.placeId, name: place.name, status: stop.status };
}

export function stopSceneDepartureWatch({ keepPending = false } = {}) {
  if (departureWatch !== null && typeof navigator !== 'undefined' && navigator.geolocation) navigator.geolocation.clearWatch(departureWatch);
  departureWatch = null;
  departureKey = '';
  departureState = null;
  if (!keepPending) departurePending = null;
  if (departureRecheckTimer) clearTimeout(departureRecheckTimer);
  departureRecheckTimer = null;
}

export function syncSceneDepartureWatch() {
  const owner = state.principal?.principalId;
  const visit = currentSceneVisit();
  const zone = state.sceneData?.arrival;
  const key = owner && visit ? `${owner}:${visit.stopId}` : '';
  if (!owner || !visit || visit.status !== 'visiting' || visit.placeId !== state.scenePlaceId || !zone || state.sceneData?.placeId !== state.scenePlaceId ||
      state.currentView !== 'scene' || state.sceneQuiet || !sceneForeground() || !navigator.geolocation ||
      sceneDeparturePreference(owner) !== 'on' || state.sceneDepartureCue || state.sceneDepartureDismissedKey === key) {
    stopSceneDepartureWatch();
    return;
  }
  if (departurePending?.key === key) {
    if (Date.now() - departurePending.detectedAt > 60_000) departurePending = null;
    else {
      const busy = state.chatPending || state.agentDockOpen || state.planDraft ||
        document.querySelector('#sheetBackdrop:not([hidden])') ||
        typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking;
      if (busy) return;
      departurePending = null;
      if (state.sceneTimingCue) state.sceneTimingDismissedKey = state.sceneTimingCue.key;
      state.sceneTimingCue = null;
      state.sceneDepartureCue = { key, text: '定位显示你可能走出了这处地点附近的候选范围。要请伴途核对下一站吗？' };
      render();
      return;
    }
  }
  if (departureKey === key && departureWatch !== null) return;
  stopSceneDepartureWatch();
  departureKey = key;
  const recheck = (delay, callback) => {
    if (departureRecheckTimer) clearTimeout(departureRecheckTimer);
    departureRecheckTimer = setTimeout(() => {
      departureRecheckTimer = null;
      if (departureKey === key && sceneForeground()) navigator.geolocation.getCurrentPosition(callback, () => {},
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }, delay);
  };
  const observe = position => {
    if (departureKey !== key || !sceneForeground() || state.currentView !== 'scene' || state.principal?.principalId !== owner) return;
    const fix = { lat: position.coords.latitude, lng: position.coords.longitude,
      accuracyMeters: position.coords.accuracy, measuredAt: position.timestamp };
    departureState = advanceSceneDeparture(departureState, fix, zone);
    if (departureState.departed) {
      departurePending = { key, detectedAt: Date.now() };
      stopSceneDepartureWatch({ keepPending: true });
      syncSceneDepartureWatch();
      return;
    }
    if (!departureState.armed && departureState.inside?.samples) recheck(Math.max(500, departureState.inside.firstAt + SCENE_DWELL_MS - Date.now() + 500), observe);
    else if (departureState.armed && departureState.outsideSamples) recheck(Math.max(500, departureState.outsideFirstAt + SCENE_DEPARTURE_DWELL_MS - Date.now() + 500), observe);
    else if (departureRecheckTimer) { clearTimeout(departureRecheckTimer); departureRecheckTimer = null; }
  };
  departureWatch = navigator.geolocation.watchPosition(observe, () => { departureState = null; },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

export function toggleSceneDeparture() {
  const owner = state.principal?.principalId;
  const enabled = sceneDeparturePreference(owner) !== 'on';
  if (!setSceneDeparturePreference(owner, enabled)) { toast('当前浏览器无法保存离开范围提醒设置。', 'error'); return; }
  if (!enabled) {
    stopSceneDepartureWatch();
    state.sceneDepartureCue = null;
  }
  render();
  toast(enabled ? '已开启离开范围提醒；仅在现场页前台检测，不会自动修改进度。' : '已关闭离开范围提醒。');
}

export function dismissSceneDepartureCue() {
  if (!state.sceneDepartureCue) return;
  state.sceneDepartureDismissedKey = state.sceneDepartureCue.key;
  state.sceneDepartureCue = null;
  render();
}

export async function askSceneDepartureAgent() {
  if (!state.sceneDepartureCue) return;
  dismissSceneDepartureCue();
  await openAgentDock({ prefill: '定位提示我可能离开了当前地点附近。请核对本人最新日计划、当前站点状态及下一站，并根据实际路线帮我安排接下来的行动。定位候选范围不证明我已经完成游览；未经我明确确认，不要把当前站点设为完成。若需要调整计划，请使用工具保存并给出真实回执。' });
}

export function stopSceneArrivalWatch() {
  arrivalGeneration++;
  arrivalLoadController?.abort();
  arrivalLoadController = null;
  if (arrivalWatch !== null && typeof navigator !== 'undefined' && navigator.geolocation) navigator.geolocation.clearWatch(arrivalWatch);
  arrivalWatch = null;
  arrivalKey = '';
  arrivalState = null;
  arrivalLoading = false;
  if (arrivalRecheckTimer) clearTimeout(arrivalRecheckTimer);
  arrivalRecheckTimer = null;
}

export async function startSceneArrivalWatch() {
  const owner = state.principal?.principalId;
  const visit = currentSceneVisit();
  if (!owner || !visit || state.currentView === 'scene' || smartCompanionEnabled(owner) || sceneArrivalPreference(owner) !== 'on' || !sceneForeground() || !navigator.geolocation) {
    stopSceneArrivalWatch(); return;
  }
  const key = `${owner}:${visit.stopId}`;
  if (openedVisits.has(key) || arrivalKey === key && (arrivalWatch !== null || arrivalLoading)) return;
  stopSceneArrivalWatch();
  arrivalKey = key;
  arrivalLoading = true;
  const watchRevision = arrivalGeneration;
  const controller = new AbortController();
  arrivalLoadController = controller;
  try {
    const scene = await loadPlaceScene(visit.placeId, { signal:controller.signal });
    if (watchRevision !== arrivalGeneration || arrivalKey !== key || state.principal?.principalId !== owner || !sceneForeground()) return;
    arrivalLoading = false;
    if (arrivalLoadController === controller) arrivalLoadController = null;
    const observePosition = position => {
      if (watchRevision !== arrivalGeneration || arrivalKey !== key || !sceneForeground() || state.principal?.principalId !== owner) return;
      const fix = { lat: position.coords.latitude, lng: position.coords.longitude,
        accuracyMeters: position.coords.accuracy, measuredAt: position.timestamp };
      arrivalState = advanceSceneArrival(arrivalState, fix, scene.arrival);
      if (arrivalState.samples === 1 && !arrivalRecheckTimer) {
        arrivalRecheckTimer = setTimeout(() => {
          arrivalRecheckTimer = null;
          if (watchRevision !== arrivalGeneration || arrivalKey !== key || !sceneForeground()) return;
          navigator.geolocation.getCurrentPosition(observePosition, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
        }, 20_500);
      }
      if (!arrivalState.arrived || !automaticSceneEntryAllowed(visit.placeId, visit)) return;
      stopSceneArrivalWatch();
      void openPlaceScene(visit.placeId, { automatic: true, returnView: state.currentView });
    };
    arrivalWatch = navigator.geolocation.watchPosition(observePosition, () => {
      if (watchRevision === arrivalGeneration && arrivalKey === key) arrivalState = null;
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  } catch {
    if (watchRevision === arrivalGeneration && arrivalKey === key && state.principal?.principalId === owner) stopSceneArrivalWatch();
  }
}

export function suspendPlaceScene() {
  invalidateSceneLoad();
  stopSceneActivity();
  stopSceneArrivalWatch();
  stopSceneSpeech();
  releaseSceneFullscreen();
}

export function onSceneVisibilityChange() {
  if (!sceneForeground()) suspendPlaceScene();
  else {
    if (state.currentView === 'scene' && state.sceneData?.placeId !== state.scenePlaceId) void loadDeepLinkedScene();
    void startSceneArrivalWatch(); syncSceneDepartureWatch(); syncSceneTimingWatch();
    if (state.currentView === 'scene') scheduleGentleNudge();
    if (state.currentView === 'scene' || state.currentView === 'place') render();
  }
}
