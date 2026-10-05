import { enterSceneImmersive, dismissSceneStory, openSceneDetails } from './scene-presentation.js';
import { openAgentConversations, newAgentConversation, switchAgentConversation, renameAgentConversation, saveAgentConversationTitle, deleteAgentConversation, confirmDeleteAgentConversation } from './agent-conversations.js';
import { openSceneSettings, changeSceneSetting, chooseSceneVoiceSetting, previewSceneVoice } from './scene-settings.js';
import { toggleAgentSpeech } from './agent-speech.js';
import { openSmartCompanionSettings, toggleSmartCompanion, retrySmartCompanion, dismissSmartCompanion, speakSmartCompanion, askSmartCompanion, openSmartCompanionPlace, openSmartCompanionScene, refreshSmartCompanion, toggleSmartCompanionAudio } from './smart-companion.js';
import { openAccount, logoutAccount, editCommunityNickname, cancelCommunityNicknameEdit } from './account.js';
import { clearPlanDraft } from './plan-draft-storage.js';
import { openDraftAsScheme, confirmDraftAsScheme } from './plan-library.js';
import { openModeration, authorizeModeration, loadModeration, exitModeration, openModerationReview, prepareModerationDecision, confirmModerationDecision } from './moderation.js';
import { SESSION_NOTICE_KEY } from './account-retention.js';
import { loadPostFeed } from './post-feed.js';
import { dismissStartupRecovery } from './startup-recovery.js';
import { analyzeCandidates } from './candidate-analysis.js';
import { correctProgress, previewProgressCorrection, saveProgressCorrection } from './progress-editor.js';
import { loadPlanHistory, openPlanHistory, openHistoryRecord, saveHistoryRecord, askDeleteHistory, deleteHistory } from './plan-history.js';
import { openProgressBackfill, saveProgressBackfill } from './progress-backfill.js';
import { editPlaceNote, savePlaceNote } from './place-notes.js';
import { openPlaceScene, cancelSceneEntry, sceneEntryErrorFor, leavePlaceScene, selectSceneHotspot, togglePlaceSceneSound, openSceneMap, askSceneAgent, speakPlaceSceneStory, dismissSceneTimingCue, askSceneTimingAgent, askSceneRecapAgent, dismissSceneDepartureCue, askSceneDepartureAgent } from './place-scene.js';
import { openAgentDock, closeAgentDock, toggleAgentDockContext, dismissAgentDock, toggleAgentDockVisibility, takeAgentDockDraft } from './agent-dock.js';
import { appendChatPrompt, dismissChatPrompt, offerChatPrompt, mountChatComposer } from './chat-composer.js';
import { retrySceneArtwork, showSceneTextExploration } from './scene-artwork.js';
import { buildingSheetHtml, rememberBuildingFloor } from './place-tour.js';
import { floorImageBySrc } from './place-tour-data.js';
import { overviewFor } from './place-overview-data.js';
import { floorPlanEvidence, mapEvidenceHtml, overviewEvidenceHtml, restroomEvidenceText } from './place-map-evidence.js';
import { writeDayNote, saveDayNote, writePost, publishPost, removePostImage, removePostPlace, askWithdrawPost, withdrawPost, morePosts, openPostVisibility, savePostVisibility } from './travel-journal.js';
import { toggleHomeFootprint, stepFootprintWeek } from '../views/home.js';
import { askDiscardPlanDraft, confirmPlanDraftChange, cancelPlanDraftChange, resumePlanDraft } from './plan-draft-guard.js';
import { findPlace, toggleFavorite } from './favorites.js';
import { loadPlaceDetail } from './place-detail.js';
import { refreshPlaceSearch, clearPlaceSearch, relaxPlaceFilters, openPlaceFilters } from './place-search.js';
import { saveStopTransport } from './stop-transport.js';
import { pickMapOrigin, pickMapEndpoint, routeToStop, toggleFullRoute, setStopTransport, setMapDestination, setMapOrigin, setCardRole, updateRoleButtons, locateMap, retryMapRoute, cancelMapRoute } from './map.js';
import { editPlaceTags, savePlaceTags } from './place-tags.js';
/**
 * 动作表：`data-action` 的值 → 处理函数。
 *
 * 用查表而不是 if 链：全部可点击的动在一处列全，新增动作＝加一行；
 * 顺序不影响语义，也不会出现"被前面某条提前 return 吞掉"的隐患。
 * tests/ui-actions.test.ts 会校验界面里出现的每个 data-action 都有处理函数。
 */
import { dateKeyInTimeZone, escapeHtml, monthDay } from './format.js';
import { canViewPlanDate, companionTarget } from './day-plan-selection.js';
import { rememberCompanion, refreshCompanionRoute, cancelCompanionRoute } from './companion.js';
import { companionMode } from '../views/companion.js';
import { openTransportPicker } from './transport-picker.js';
import { openCompanionChange, cancelCompanionChange, queryCompanionAdvice, applyCompanionAdvice } from './companion-advice.js';
import { $, state } from './store.js';
import { api } from './api.js';
import { closeSheet, dismissSheet, openSheet, toast } from './ui.js';
import { imageViewerHtml, safeLocalPhotoPath } from './image-viewer.js';
import { selectedComparisonSchemes, comparisonButtonLabel } from './plan-comparison.js';
import { navigate, render, returnFromPlace, returnFromPost } from './render.js';
import { openDatePickerPanel, openDurationPickerPanel, openOptionPickerPanel, openTimePickerPanel } from './ui-picker.js';
import { loadAllMemories, loadOlderMessages, loadPlaces, loadMorePlaces, loadReady } from './loaders.js';
import { toggleLargeText, toggleTheme, toggleCompactMode, openDisplayPreferences } from './preferences.js';
import { restoreVersion, editStopTime, previewStopTime, saveStopTime } from './snapshots.js';
import { openModelSettings, chooseModelService, configureModel } from './model-settings.js';
import { editMemory, saveMemoryEdit, discardMemoryEdit, confirmDiscardMemoryEdit, askDeleteMemory, deleteMemory, sendMemoryToAgent } from './memory-editor.js';
import {openJourneyReview} from './journey-review.js';
import { openDiscovery, publishDiscovery, showDiscovery, openSubmission, communityMutation, confirmWithdrawal, withdrawDiscovery, toggleLike, openPostDetail, submitComment, deleteComment, changeCommunitySort, reportDiscoveryForm, submitReport, togglePostFavorite, sharePlanToCommunity, viewPlanShare, importPlanShare, askWithdrawPlanShare, withdrawPlanShare, copyPlanShareCode, openPlaceReview, submitPlaceReview } from './community.js';
import { loadCommunity, loadMorePlanShares, searchPlanShares } from './loaders.js';
import { loadPlans, openPlanPlanner, openSelectedDayPlanEditor, draftMove, draftRemove, draftAddPlace, savePlanDraft, openSavePlanSheet, openSaveCurrentPlan, confirmSavePlanSheet, confirmDeleteSavedPlan, confirmDeleteDatePlan, removeSavedPlan, loadSchemeAsPlans, confirmSchemeProgressLoad, confirmReplaceLoad, editPlanStopTime, savePlanStopTime, askRemovePlanStop, removePlanStop, draftSwitchDay, setDraftDayCount, setDraftStopStart, setDraftStopDuration, syncPlanDraftInput, restoreSavedPlanVersion, showSavedPlanVersionHistory } from './plan-library.js';
import { estimateDraftRoutes, queueDraftRoutes, setDraftStopTransportMode, moveEmptyDayDraftToTomorrow } from './plan-library.js';
import { cancelPlanShare, confirmPlanShare } from './community.js';
import { confirmPlanEdit, addMemory, addPlaceToPlan, applyCandidate, recordExecution, rejectProposal, retryFailedChat, showVersionHistory } from './commands.js';
import { viewRepeatedPlanPlace } from './commands.js';
import { focusPlanVisit } from './plan-repeat-visit.js';
import { transportModeToStop } from './plan-route-timing.js';
import { openDaytimePlan, cancelDaytimePlan, recheckDaytimePlan, applyDaytimePlan } from './plan-daytime.js';

function repaintDateSelection() {
  if (typeof document !== 'undefined') render();
}

function zoomPlaceImage(el) {
  const src = el.dataset.imageSrc || '';
  if (!/^\/images\/places\/[a-z0-9/_-]+\.(?:jpe?g|png|webp|svg)$/i.test(src)) throw new Error('这张地点图暂时无法打开。');
  const alt = el.dataset.imageAlt || '地点印象插画';
  const title = el.dataset.imageTitle || '地点印象';
  const floorPlan = /\/floorplan\//i.test(src);
  const image = floorPlan ? floorImageBySrc(src) : null;
  const evidence = floorPlan ? mapEvidenceHtml(image?.evidence || floorPlanEvidence('', {}), {
    facilityText: image && image.kind !== 'area-diagram' ? restroomEvidenceText(image) : '',
    notice: image?.notice || '',
  }) : '';
  openSheet(imageViewerHtml({ src, title, alt, floorPlan, evidence }), { nested: true, trigger: el });
}

function zoomPlacePhoto(el) {
  const src = safeLocalPhotoPath(el.dataset.imageSrc);
  if (!src) throw new Error('这张照片暂时无法打开。');
  openSheet(imageViewerHtml({ src, title: el.dataset.imageTitle || '实拍照片', alt: el.dataset.imageAlt || '地点实拍照片' }), { nested: true, trigger: el });
}

const siteMapFullView = [0, 0, 600, 420];

function siteMapViewBox(svg) {
  const values = (svg.getAttribute('viewBox') || siteMapFullView.join(' ')).trim().split(/[ ,]+/).map(Number);
  return values.length === 4 && values.every(Number.isFinite) ? values : [...siteMapFullView];
}

function setSiteMapViewBox(svg, [x, y, width]) {
  const nextWidth = Math.max(240, Math.min(siteMapFullView[2], width));
  const nextHeight = nextWidth * siteMapFullView[3] / siteMapFullView[2];
  const nextX = Math.max(0, Math.min(siteMapFullView[2] - nextWidth, x));
  const nextY = Math.max(0, Math.min(siteMapFullView[3] - nextHeight, y));
  svg.setAttribute('viewBox', `${nextX.toFixed(2)} ${nextY.toFixed(2)} ${nextWidth.toFixed(2)} ${nextHeight.toFixed(2)}`);
}

async function performPostSearch(query) {
  state.postQuery = query;
  if ($('postSearch')) $('postSearch').value = query;
  state.postFeedRestore = null;
  const revision = state.navigationRevision, owner = state.principal?.principalId;
  const request = loadPostFeed({ search:true });
  render();
  try { await request; }
  catch { /* A failed search remains visible with its query and a retry action. */ }
  finally {
    if (state.navigationRevision === revision && state.principal?.principalId === owner && state.currentView === 'community') render();
  }
}

function showPostPhoto(el) {
  const post = state.postDetail;
  if (!post || post.id !== el.dataset.post || state.postDetailId !== post.id) return;
  const picture = post.images?.find(image => image.id === el.dataset.image);
  if (!picture) return;
  const src = `/api/v1/community/posts/${encodeURIComponent(post.id)}/images/${encodeURIComponent(picture.id)}`;
  openSheet(imageViewerHtml({ src, title:'旅行照片', alt:picture.alt || '旅行照片' }), { nested:true, trigger:el });
}

function zoomPlaceOverview(el) {
  const map = el.closest('.place-tour')?.querySelector('.site-map-svg');
  if (!map) return;
  const title = el.dataset.placeName || '景点';
  const enlargedMap = map.cloneNode(true);
  enlargedMap.classList.add('site-map-viewer-map');
  enlargedMap.setAttribute('aria-label', `${title}场地全貌放大图`);
  openSheet(`<div class="place-image-viewer site-map-viewer"><div class="sheet-head place-image-viewer-head"><h3>${escapeHtml(title)} · 场地全貌</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭全貌地图">✕</button></div><figure class="place-image-viewer-frame site-map-viewer-frame">${enlargedMap.outerHTML}</figure><div class="site-map-viewer-tools" role="toolbar" aria-label="全貌地图控制"><span>拖动平移 · 点建筑查看楼层图</span><div class="site-map-viewer-zoom"><button type="button" data-action="zoom-site-map" data-direction="in" aria-label="放大地图">＋</button><button type="button" data-action="zoom-site-map" data-direction="out" aria-label="缩小地图">−</button><button type="button" data-action="zoom-site-map" data-direction="reset">还原</button></div><div class="site-map-viewer-pan"><button type="button" data-action="pan-site-map" data-direction="north" aria-label="地图向北平移">↑</button><button type="button" data-action="pan-site-map" data-direction="west" aria-label="地图向西平移">←</button><button type="button" data-action="pan-site-map" data-direction="east" aria-label="地图向东平移">→</button><button type="button" data-action="pan-site-map" data-direction="south" aria-label="地图向南平移">↓</button></div></div></div>`, { nested: true, trigger: el });
  const viewerMap = $('sheet').querySelector('.site-map-viewer-map');
  $('sheet').querySelector('.place-image-viewer-head')?.insertAdjacentHTML('afterend', overviewEvidenceHtml(overviewFor({ name: title })));
  if (viewerMap) enableSiteMapPan(viewerMap);
}

function zoomSiteMap(el) {
  const svg = el.closest('.site-map-viewer')?.querySelector('.site-map-viewer-map');
  if (!svg) return;
  const [x, y, width] = siteMapViewBox(svg);
  if (el.dataset.direction === 'reset') {
    svg.setAttribute('viewBox', siteMapFullView.join(' '));
    return;
  }
  const factor = el.dataset.direction === 'out' ? 1.25 : .8;
  const nextWidth = Math.max(240, Math.min(siteMapFullView[2], width * factor));
  const nextHeight = nextWidth * siteMapFullView[3] / siteMapFullView[2];
  setSiteMapViewBox(svg, [x + (width - nextWidth) / 2, y + (siteMapViewBox(svg)[3] - nextHeight) / 2, nextWidth]);
}

function panSiteMap(el) {
  const svg = el.closest('.site-map-viewer')?.querySelector('.site-map-viewer-map');
  if (!svg) return;
  const [x, y, width, height] = siteMapViewBox(svg);
  const stepX = width * .28, stepY = height * .28;
  const direction = el.dataset.direction;
  const nextX = direction === 'west' ? x - stepX : direction === 'east' ? x + stepX : x;
  const nextY = direction === 'north' ? y - stepY : direction === 'south' ? y + stepY : y;
  setSiteMapViewBox(svg, [nextX, nextY, width]);
}

function enableSiteMapPan(svg) {
  let drag = null;
  let suppressClickUntil = 0;
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const box = svg.getBoundingClientRect();
    if (!box.width || !box.height) return;
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, box, viewBox: siteMapViewBox(svg), moved: false, target: event.target };
    event.target.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX, deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 3) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    const [x, y, width, height] = drag.viewBox;
    setSiteMapViewBox(svg, [x - deltaX * width / drag.box.width, y - deltaY * height / drag.box.height, width]);
    svg.classList.add('is-dragging');
  });
  const finishDrag = event => {
    if (!drag || drag.id !== event.pointerId) return;
    const { moved, target } = drag;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    if (moved) suppressClickUntil = performance.now() + 350;
    drag = null;
    svg.classList.remove('is-dragging');
  };
  svg.addEventListener('pointerup', finishDrag);
  svg.addEventListener('pointercancel', finishDrag);
  svg.addEventListener('click', event => {
    if (performance.now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  });
}

async function openPlacePage(placeId) {
  if (!placeId) return;
  if (state.currentView !== 'place') {
    state.placeReturnView = state.currentView;
    state.placeReturnScrollY = window.scrollY;
  }
  state.placeDetailId = placeId;
  navigate('place');
}

async function selectPlanDate(date) {
  // 日期切换只是查看偏好，不应把任意 data-date 写入全局状态。除了防止
  // 过期 DOM 传入脏值，也能避免地图/编辑器随后把无效日期当成真实计划日期。
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return;
  // Expired day plans are archived by the server and must not be revived by
  // stale DOM or browser history. Use memories for historical review.
  if (!canViewPlanDate(date, state.savedPlans)) return;
  state.planDateSelectionRevision += 1;
  state.planViewDate = date;
  state.pendingMountedDate = '';
  repaintDateSelection();
}

function openPlanDatePicker(el) {
  const today = dateKeyInTimeZone(new Date());
  const dates = [...new Set((el.dataset.dates || '').split(',').filter(date => canViewPlanDate(date, state.savedPlans)))].sort();
  if (!dates.length) return;
  const options = dates.map(date => {
    const [year, month, day] = date.split('-');
    const label = `${year}年${Number(month)}月${Number(day)}日${date === today ? ' · 今天' : ''}`;
    return `<button class="plan-date-picker-option" data-action="select-plan-date-from-picker" data-date="${date}" aria-pressed="${date === state.planViewDate ? 'true' : 'false'}">${escapeHtml(label)}<span aria-hidden="true">›</span></button>`;
  }).join('');
  openSheet(`<div class="sheet-head"><h3>选择其他日期</h3><button class="icon-btn" data-action="close-sheet" aria-label="关闭">✕</button></div><p class="stop-meta">选择一天查看对应计划。</p><div class="plan-date-picker-list">${options}</div>`);
}

async function selectPlanDateFromPicker(el) {
  const date = el.dataset.date || '';
  closeSheet();
  await selectPlanDate(date);
}

    /**
     * 动作表：`data-action` 的值 → 处理函数。
     *
     * 用查表而不是长 if 链，好处是：
     * - 全部可点击的动作在一处列全，新增动作＝加一行，不必在链里找位置；
     * - 顺序不再影响语义，也不会出现"被前面某条提前 return 吞掉"的隐患；
     * - tests/frontend-modules.test.ts 能校验"界面里出现的每个 data-action 都有处理函数"，
     *   拼错动作名会立刻失败，而不是点了没反应。
     *
     * 处理函数统一收 `el`（触发元素），需要额外参数就从 dataset 里取。
     */
    const ACTIONS = {
      'toggle-agent-speech': (el) => toggleAgentSpeech(el),
      'open-smart-companion-settings': () => openSmartCompanionSettings(),
      'toggle-smart-companion': () => toggleSmartCompanion(),
      'retry-smart-companion': () => retrySmartCompanion(),
      'dismiss-smart-companion': () => dismissSmartCompanion(),
      'speak-smart-companion': () => speakSmartCompanion(),
      'ask-smart-companion': () => askSmartCompanion(),
      'open-smart-companion-place': () => openSmartCompanionPlace(),
      'open-smart-companion-scene': () => openSmartCompanionScene(),
      'refresh-smart-companion': () => refreshSmartCompanion(),
      'toggle-smart-companion-audio': () => toggleSmartCompanionAudio(),
      'toggle-agent-dock': () => openAgentDock(),
      'close-agent-dock': () => closeAgentDock(),
      'dismiss-agent-dock': () => dismissAgentDock(),
      'toggle-agent-dock-visibility': () => { toggleAgentDockVisibility(); render(); },
      'toggle-agent-context': () => toggleAgentDockContext(),
      'open-full-agent': () => { takeAgentDockDraft(); state.agentDockOpen = false; navigate('agent'); document.getElementById('chatText')?.focus(); mountChatComposer(); },
      'enter-scene-immersive': () => enterSceneImmersive(),
      'retry-scene-artwork': () => retrySceneArtwork(),
      'show-scene-text': () => showSceneTextExploration(),
      'hide-scene-text': () => showSceneTextExploration(false),
      'dismiss-scene-story': () => dismissSceneStory(),
      'open-scene-details': () => openSceneDetails(),
      'explore-scene-element': (el) => { closeSheet(); selectSceneHotspot(el.dataset.hotspot); },
      'explore-scene-text-topic': (el) => selectSceneHotspot(el.dataset.element),
      'open-place-scene': async (el) => {
        try { await openPlaceScene(el.dataset.place); }
        catch (error) { if (!sceneEntryErrorFor(el.dataset.place)) throw error; }
      },
      'cancel-scene-entry': (el) => cancelSceneEntry(el.dataset.place),
      'leave-place-scene': () => leavePlaceScene(),
      'select-scene-hotspot': (el) => selectSceneHotspot(el.dataset.hotspot),
      'open-scene-settings': () => openSceneSettings(),
      'change-scene-setting': (el) => changeSceneSetting(el.dataset.setting),
      'choose-scene-voice': (el) => chooseSceneVoiceSetting(el),
      'preview-scene-voice': () => previewSceneVoice(),
      'toggle-scene-sound': () => togglePlaceSceneSound(),
      'dismiss-scene-timing': () => dismissSceneTimingCue(),
      'ask-scene-timing-agent': () => askSceneTimingAgent(),
      'dismiss-scene-departure': () => dismissSceneDepartureCue(),
      'ask-scene-departure-agent': () => askSceneDepartureAgent(),
      'ask-scene-recap-agent': () => { closeSheet(); return askSceneRecapAgent(); },
      'open-scene-map': (el) => openSceneMap(el.dataset.floor || ''),
      'ask-scene-agent': (el) => askSceneAgent(el.dataset.hotspot || ''),
      'note-scene-hotspot': (el) => askSceneAgent(el.dataset.hotspot || '', true),
      'speak-scene-story': () => speakPlaceSceneStory(),
      'open-moderation': () => openModeration(),
      'authorize-moderation': (el) => authorizeModeration(el),
      'refresh-moderation': () => loadModeration(),
      'exit-moderation': () => exitModeration(),
      'open-moderation-review': (el) => openModerationReview(el.dataset.id),
      'prepare-moderation-decision': (el) => prepareModerationDecision(el.dataset.decision),
      'confirm-moderation-decision': (el) => confirmModerationDecision(el),
      'refresh-app': () => window.location.reload(),
      'retry-current-view': () => navigate(state.currentView),
      'retry-place-detail': async () => {
        const request = loadPlaceDetail({ force:true });
        const revision = state.navigationRevision;
        render();
        await request;
        if (state.currentView === 'place' && state.navigationRevision === revision) render();
      },
      'analyze-candidates': () => analyzeCandidates(),
      'account-panel': () => openAccount(),
      'account-logout': () => logoutAccount(),
      'edit-community-nickname': () => editCommunityNickname(),
      'dismiss-session-notice': () => {
        state.sessionRecoveryNotice = false;
        try { sessionStorage.removeItem(SESSION_NOTICE_KEY); } catch {}
        render();
      },
      'cancel-community-nickname-edit': () => cancelCommunityNicknameEdit(),
      'correct-progress': (el) => correctProgress(el.dataset.stop, el.dataset.plan || ''),
      'open-plan-history': () => openPlanHistory(),
      'select-achievement': (el) => {
        state.achievementSelected = state.achievementSelected === el.dataset.place ? '' : el.dataset.place;
        render();
        const detail = document.querySelector('.achievement-detail');
        if (detail) { detail.setAttribute('tabindex', '-1'); detail.focus({ preventScroll: true }); detail.scrollIntoView({ block: 'nearest', behavior: 'auto' }); }
        else [...document.querySelectorAll('.achievement-card')].find(card => card.dataset.place === el.dataset.place)?.focus({ preventScroll: true });
      },
      'filter-achievements': (el) => {
        if (!['all', 'shining'].includes(el.dataset.filter)) return;
        state.achievementFilter = el.dataset.filter; state.achievementSelected = ''; render();
        document.querySelector(`.achievement-filters [data-filter="${state.achievementFilter}"]`)?.focus({ preventScroll: true });
      },
      'achievement-view-plan': (el) => { state.planViewDate = el.dataset.date; navigate('today'); },
      'view-plan-history': (el) => openPlanHistory(el.dataset.plan),
      'retry-plan-history': async () => { const pending = loadPlanHistory(); render(); try { await pending; } finally { render(); } },
      'more-plan-history': async () => { if (state.planHistoryLoading) return; const pending = loadPlanHistory(true); render(); try { await pending; } finally { render(); } },
      'backfill-plan-history': (el) => openHistoryRecord(el.dataset.stop),
      'correct-plan-history': (el) => openHistoryRecord(el.dataset.stop, true),
      'save-history-record': (el) => saveHistoryRecord(el),
      'ask-delete-plan-history': () => askDeleteHistory(),
      'delete-plan-history': (el) => deleteHistory(el),
      'backfill-progress': (el) => openProgressBackfill(el.dataset.plan, el.dataset.stop),
      'save-progress-backfill': () => saveProgressBackfill(),
      'preview-progress-correction': () => previewProgressCorrection(),
      'save-progress-correction': (el) => saveProgressCorrection(el),
      'write-day-note': () => writeDayNote(),
      'save-day-note': (el) => saveDayNote(el),
      'share-memory': (el) => writePost(el.dataset.memory, el.dataset.trip),
      'write-post': () => writePost(),
      'publish-travel-post': (el) => publishPost(el),
      'remove-post-image': (el) => removePostImage(Number(el.dataset.imageIndex)),
      'remove-post-place': (el) => removePostPlace(el.dataset.place || ''),
      'withdraw-post': (el) => askWithdrawPost(el.dataset.post),
      'confirm-withdraw-post': (el) => withdrawPost(el.dataset.post),
      'post-visibility': (el) => openPostVisibility(el.dataset.post),
      'save-post-visibility': (el) => savePostVisibility(el),
      'more-posts': () => morePosts(),
      // 导航与旅行切换
      navigate: (el) => { closeSheet(); navigate(el.dataset.view); },
      'open-companion': (el) => { closeSheet(); state.companionOwner = state.principal?.principalId || ''; rememberCompanion(el.dataset.plan); navigate('home'); },
      'view-companion-plan': () => { const plan = companionTarget(state.savedPlans, state.companionPlanId).plan; if (plan) state.planViewDate = plan.localDate; navigate('today'); },
      'focus-home-companion': () => { const section = $('homeCompanion'); if (section) { section.focus({ preventScroll: true }); section.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } },
      'companion-exec': (el) => recordExecution(el.dataset.stop, el.dataset.type, { planId: el.dataset.plan, expectedRevision: Number(el.dataset.revision), transportMode: el.dataset.mode, preserveView: true }),
      'open-journey-review': (el) => openJourneyReview(el.dataset.plan),
      'companion-mode': (el) => {
        const target = companionTarget(state.savedPlans, state.companionPlanId);
        if (state.executionPending || state.stopTransportPending || target.plan?.id !== el.dataset.plan || target.next?.stopId !== el.dataset.stop) return;
        const owner = state.principal?.principalId, revision = target.plan.revision, view = state.currentView;
        const mode = companionMode(target.plan, target.next);
        openTransportPicker(el, mode, picked => {
          const current = companionTarget(state.savedPlans, state.companionPlanId);
          if (state.executionPending || state.currentView !== view || state.principal?.principalId !== owner || current.plan?.id !== target.plan.id || current.plan?.revision !== revision || current.next?.stopId !== target.next.stopId || picked === mode) return;
          saveStopTransport(target.plan, target.next.stopId, picked, { estimate: false }).catch(error => toast(error.message, 'error'));
        });
      },
      'refresh-companion-route': () => refreshCompanionRoute({ locate: true }),
      'cancel-companion-route': () => cancelCompanionRoute(),
      'companion-change': (el) => openCompanionChange(el.dataset.change),
      'cancel-companion-change': (el) => cancelCompanionChange(el),
      'query-companion-advice': (el) => queryCompanionAdvice(el),
      'apply-companion-advice': (el) => applyCompanionAdvice(el.dataset.preview, el.dataset.message),
      'toggle-home-footprint': () => toggleHomeFootprint(),
      'step-footprint-week': (el) => { stepFootprintWeek(el.dataset.direction); render(); },
      'add-place-on-date': (el) => { state.planViewDate = el.dataset.date || state.planViewDate; navigate('places'); },

      // 计划编辑与生成
      'apply': (el) => applyCandidate(el.dataset.proposal, el.dataset.candidate, el.dataset.request),
      reject: () => rejectProposal(),
      'add-to-plan': (el) => addPlaceToPlan(el.dataset.place),

      // 执行与调整
      exec: (el) => recordExecution(el.dataset.stop, el.dataset.type),
      'view-active-plan-visit': (el) => {
        const plan = state.savedPlans.find(item => item.id === el.dataset.plan && item.kind === 'plan');
        const stop = plan?.stops?.find(item => item.stopId === el.dataset.stop && ['en_route', 'visiting'].includes(item.status));
        if (!stop) { render(); return; }
        const owner = state.principal?.principalId;
        const sameDay = state.planViewDate === plan.localDate;
        state.planViewDate = plan.localDate;
        if (state.currentView !== 'today') navigate('today');
        else if (!sameDay) render();
        requestAnimationFrame(() => {
          if (state.principal?.principalId === owner && state.currentView === 'today' && state.planViewDate === plan.localDate) focusPlanVisit(stop.stopId);
        });
      },
      'cancel-departure': () => { state.companionDepartureFallback = null; closeSheet(); },
      'cancel-departure-review': () => { state.departureReview = null; closeSheet(); },
      'open-daytime-plan': (el) => openDaytimePlan(el),
      'cancel-daytime-plan': () => cancelDaytimePlan(),
      'recheck-daytime-plan': () => recheckDaytimePlan(),
      'apply-daytime-plan': () => applyDaytimePlan(),
      'confirm-departure-route': () => {
        const pending = state.departureReview;
        if (!pending) return;
        state.departureReview = null;
        closeSheet();
        return recordExecution(pending.stopId, 'depart', { ...pending, reviewConfirmed: true });
      },
      'arrive-at-place': async () => {
        const pending = state.departureReview;
        if (!pending) return;
        state.departureReview = null;
        closeSheet();
        await recordExecution(pending.stopId, 'depart', { ...pending, withoutLocation: true });
        await recordExecution(pending.stopId, 'arrive', { planId: pending.planId });
      },
      'retry-departure-location': () => {
        const pending = state.companionDepartureFallback;
        if (!pending) return;
        closeSheet();
        return recordExecution(pending.stopId, 'depart', pending);
      },
      'confirm-departure-without-location': () => {
        const pending = state.companionDepartureFallback;
        if (!pending) return;
        closeSheet();
        return recordExecution(pending.stopId, 'depart', { ...pending, withoutLocation: true });
      },

      // 地点
      shortlist: (el) => toggleFavorite(el.dataset.place),
      // 地点卡点击 → 进入地点详情页（独立大板块）
      'open-place': (el) => openPlacePage(el.dataset.place),
      'open-approved-community-place': (el) => openPlacePage(el.dataset.place),
      'back-from-place': () => returnFromPlace(),
      'zoom-place-image': (el) => zoomPlaceImage(el),
      'zoom-place-photo': (el) => zoomPlacePhoto(el),
      'zoom-place-overview': (el) => zoomPlaceOverview(el),
      'zoom-site-map': (el) => zoomSiteMap(el),
      'pan-site-map': (el) => panSiteMap(el),
      'map-pick-origin': (el) => pickMapOrigin(el),
      'map-locate': () => locateMap(),
      'retry-map-route': () => retryMapRoute(),
      'cancel-map-route': () => cancelMapRoute(),
      'map-pick-endpoint': (el) => pickMapEndpoint(el),
      'set-card-role': (el) => setCardRole(el.dataset.place),
      // 规划器站点时间：点击弹时间面板，确认后改写该站开始时刻并顺延后续站点。
      'edit-draft-stop-time': (el) => {
        const dayIndex = Number(el.dataset.day || 0), index = Number(el.dataset.index || 0);
        const stopId = el.dataset.stopId || '';
        const days = state.planDraft?.days || [];
        const day = days.find(item => item.dayIndex === dayIndex) || days[dayIndex];
        const stop = day?.stops?.[index];
        if (!stop) return;
        const dayOffset = Math.max(0, Math.floor(stop.startMinutes / 1440));
        const value = `${String(Math.floor(stop.startMinutes % 1440 / 60)).padStart(2, '0')}:${String(stop.startMinutes % 60).padStart(2, '0')}`;
        openTimePickerPanel(el, value, (picked) => {
          const [h, m] = picked.split(':').map(Number);
          const currentDays = state.planDraft?.days || [];
          const plan = currentDays.find(item => item.dayIndex === dayIndex) || currentDays[dayIndex];
          const currentIndex = stopId ? plan?.stops?.findIndex(item => item.stopId === stopId) : index;
          if (!plan?.stops?.[currentIndex]) return;
          setDraftStopStart(dayIndex, currentIndex, dayOffset * 1440 + h * 60 + m);
          render();
        });
      },
      'edit-draft-stop-duration': (el) => {
        const dayIndex = Number(el.dataset.day || 0), index = Number(el.dataset.index || 0);
        const stopId = el.dataset.stopId || '';
        const day = state.planDraft?.days?.find(item => item.dayIndex === dayIndex) || state.planDraft?.days?.[dayIndex];
        const stop = stopId ? day?.stops?.find(item => item.stopId === stopId) : day?.stops?.[index];
        if (!stop) return;
        openDurationPickerPanel(el, Math.max(15, Math.min(480, stop.endMinutes - stop.startMinutes)), (minutes) => {
          if (!setDraftStopDuration(dayIndex, stopId, index, minutes)) {
            toast('这一天的地点已变化，请重新选择。', 'error');
            return;
          }
          render();
        });
      },
      // 待出发站点直接选交通方式：选完按该方式计算上一站→本站路线并保存。
      'pick-stop-mode': (el) => {
        const stopId = el.dataset.stop;
        if (state.executionPending || state.stopTransportPending) return;
        const owner = state.principal?.principalId, viewDate = state.planViewDate, trip = state.trip, view = state.currentView;
        const plan = el.dataset.plan ? state.savedPlans?.find(item => item.id === el.dataset.plan) : null;
        const revision = plan?.revision;
        const current = el.dataset.mode || state.stopModes?.[stopId] || 'walking';
        openTransportPicker(el, current, (mode) => {
          if (state.executionPending || state.currentView !== view || state.principal?.principalId !== owner || state.planViewDate !== viewDate || state.trip !== trip) return;
          if (el.dataset.plan && !state.savedPlans?.some(item => item.id === plan?.id && item.revision === revision && item.stops?.some(stop => stop.stopId === stopId && (stop.status || 'planned') === 'planned'))) return;
          if (mode === current) return;
          setStopTransport(stopId, mode).catch((error) => toast(error.message, 'error'));
        });
      },
      'pick-map-mode': (el) => {
        const control = $('routeMode'), owner = state.principal?.principalId;
        if (!control || state.currentView !== 'map') return;
        openTransportPicker(el, control.value, mode => {
          if (!control.isConnected || $('routeMode') !== control || state.currentView !== 'map' || state.principal?.principalId !== owner || control.value === mode) return;
          control.value = mode;
          control.dispatchEvent(new Event('change', { bubbles: true }));
        }, { routeModes: state.mapConfig?.routeModes });
      },
      'toggle-full-route': () => toggleFullRoute(),
      'map-destination': (el) => setMapDestination(el.dataset.place),
      'map-origin': (el) => setMapOrigin(el.dataset.place),
      'route-detail': (el) => routeToStop(el.dataset.stop),
      'edit-place-tags': (el) => editPlaceTags(el.dataset.place),
      'save-place-tags': () => savePlaceTags(),
      'search-places': async () => {
        // 发现地点目录中的平台精选与审核通过地点使用同一搜索框。
        const query = $('placeSearch')?.value || '';
        state.placeQuery = query;
        state.communityQuery = query;
        await refreshPlaceSearch();
      },
      'clear-place-search': () => clearPlaceSearch(),
      'more-places': async () => {
        const owner = state.principal?.principalId, revision = state.navigationRevision;
        const request = loadMorePlaces(); render();
        try { await request; } catch { /* Keep the cursor and cards for retry. */ }
        finally { if (owner === state.principal?.principalId && revision === state.navigationRevision && state.currentView === 'places') render(); }
      },
      'relax-place-filters': () => relaxPlaceFilters(),
      'open-place-filters': () => openPlaceFilters(),
      'search-posts': () => performPostSearch($('postSearch')?.value || ''),
      'view-post-image': (el) => showPostPhoto(el),
      'clear-post-search': () => performPostSearch(''),
      'retry-post-search': () => performPostSearch(state.postQuery || ''),
      'filter-places': async (el) => {
        // 所有已收录地点共用同一排标签筛选。
        state.placeCategory = el.dataset.category;
        state.communityTag = el.dataset.category === '全部' ? '' : el.dataset.category;
        await refreshPlaceSearch();
      },
      'filter-facility': (el) => {
        const id = el.dataset.facility;
        const list = new Set(state.placeAdvanced?.facilities || []);
        if (list.has(id)) list.delete(id); else list.add(id);
        state.placeAdvanced = { ...(state.placeAdvanced || { cost: '', duration: '', rating: '' }), facilities: [...list] };
        render();
      },
      'filter-cost': (el) => { state.placeAdvanced = { facilities: [...(state.placeAdvanced?.facilities || [])], ...(state.placeAdvanced || {}), cost: el.dataset.cost }; render(); },
      'filter-duration': (el) => { state.placeAdvanced = { facilities: [...(state.placeAdvanced?.facilities || [])], ...(state.placeAdvanced || {}), duration: el.dataset.duration }; render(); },
      'filter-rating': (el) => { state.placeAdvanced = { facilities: [...(state.placeAdvanced?.facilities || [])], ...(state.placeAdvanced || {}), rating: el.dataset.rating }; render(); },
      'reset-advanced': () => { state.placeAdvanced = { facilities: [], cost: '', duration: '', rating: '' }; render(); },

      // 记录与回顾
      'add-memory': async (el) => {
        if (state.savingMemory) return;
        state.savingMemory = true; el.disabled = true;
        try { await addMemory(); } finally { state.savingMemory = false; el.disabled = false; }
      },
      'load-memories': async () => {
        await loadAllMemories();
        render();
      },

      // 面板与设置
      'close-sheet': () => dismissSheet(),
      versions: (el) => el.dataset.plan
        ? showSavedPlanVersionHistory(el.dataset.plan)
        : showVersionHistory(el.dataset.date || ''),
      'restore-saved-plan-version': (el) => restoreSavedPlanVersion(el.dataset.plan, el.dataset.revision),
      'edit-memory': (el) => editMemory(el.dataset.memory, el.dataset.trip),
      'save-memory-edit': (el) => saveMemoryEdit(el),
      'discard-memory-edit': () => discardMemoryEdit(),
      'confirm-discard-memory-edit': (el) => confirmDiscardMemoryEdit(el),
      'delete-memory': (el) => askDeleteMemory(el.dataset.memory, el.dataset.trip),
      'confirm-delete-memory': (el) => deleteMemory(el),
      'memory-to-agent': () => sendMemoryToAgent(),
      'publish-discovery': () => openDiscovery(),
      'save-discovery': (el) => publishDiscovery(el),
      'community-detail': (el) => showDiscovery(el.dataset.id),
      'submit-discovery-form': () => openSubmission(),
      'submit-discovery': (el) => communityMutation('submit', el),
      'review-discovery': (el) => communityMutation('reviews', el),
      'more-plan-shares': async () => { const request = loadMorePlanShares(); render(); await request; render(); },
      'search-plan-shares': async () => { const request = searchPlanShares($('planShareSearch')?.value || ''); render(); try { await request; } finally { render(); } },
      'copy-plan-share-code': (el) => copyPlanShareCode(el),
      'community-post-filter': (el) => { state.communityPostFilter = el.dataset.filter === 'mine' ? 'mine' : 'all'; render(); },
      'community-plan-share-filter': (el) => { state.planShareMineFilter = el.dataset.filter === 'mine' ? 'mine' : 'all'; render(); },
      'edit-place-note': (el) => editPlaceNote(el.dataset.place),
      'open-building-plan': (el) => {
        const place = findPlace(el.dataset.place);
        if (!place) return;
        if (el.dataset.floor !== undefined && el.dataset.floor !== '') rememberBuildingFloor(place, el.dataset.building, Number(el.dataset.floor));
        openSheet(buildingSheetHtml(place, el.dataset.building), { nested: true, trigger: el });
      },
      'switch-building-floor': (el) => {
        const place = findPlace(el.dataset.place);
        if (!place) return;
        if (el.dataset.floor !== undefined && el.dataset.floor !== '') rememberBuildingFloor(place, el.dataset.building, Number(el.dataset.floor));
        openSheet(buildingSheetHtml(place, el.dataset.building), { replace: true });
      },
      'save-place-note': (el) => savePlaceNote(el),
      'withdraw-discovery-form': () => confirmWithdrawal(),
      'withdraw-discovery': (el) => withdrawDiscovery(el),
      'like-post': (el) => toggleLike(el),
      'open-post-detail': (el) => openPostDetail(el.dataset.post),
      'back-from-post': () => returnFromPost(),
      'submit-comment': (el) => submitComment(el),
      'delete-comment': (el) => deleteComment(el),
      'community-sort': (el) => changeCommunitySort(el),
      'filter-city': async (el) => {
        // 所有已收录地点共用同一排城市筛选。
        state.placeCity = el.dataset.city || '';
        state.communityCity = el.dataset.city || '';
        await refreshPlaceSearch();
      },
      'write-place-review': (el) => openPlaceReview(el),
      'submit-place-review': (el) => submitPlaceReview(el),
      'report-discovery-form': () => reportDiscoveryForm(),
      'submit-report': (el) => submitReport(el),
      // 我的方案库与手动规划器
      'save-current-plan': () => openSaveCurrentPlan(),
      'save-candidate-plan': (el) => {
        const candidate = (state.proposal?.candidates || []).find(item => item.candidateId === el.dataset.candidate);
        if (!candidate) return;
        openSavePlanSheet(candidate.title || '伴途候选', { stops: candidate.snapshot.stops, routeLegs: candidate.snapshot.routeLegs, plannedCharges: candidate.snapshot.plannedCharges }, 'candidate');
      },
      'confirm-save-plan-sheet': () => confirmSavePlanSheet(),
      'new-plan-draft': async () => { await loadPlaces().catch(() => {}); openPlanPlanner({ baseStops: state.trip?.snapshot.stops || [] }); render(); },
      // 点击方案卡上的起始日期：打开日历面板，选完直接保存方案的起始日期。
      // 方案草稿表单的起始日期：用日历面板替代原生 date 输入（留空显示「日期待定」，不再是「年/月/日」占位符）。
      'edit-draft-date': (el) => {
        const input = document.getElementById('draftStartDate');
        openDatePickerPanel(el, input?.value || '', (value) => {
          if (input) input.value = value;
          syncPlanDraftInput(input);
          el.textContent = value ? monthDay(value) : '日期待定';
          el.classList.toggle('placeholder', !value);
        }, { minDate: dateKeyInTimeZone() });
      },
      'edit-scheme-date': async (el) => {
        const planId = el.dataset.plan;
        const plan = (state.savedPlans || []).find(item => item.id === planId);
        if (!plan) return;
        const owner = state.principal?.principalId;
        const expectedRevision = plan.revision || 0;
        openDatePickerPanel(el, plan.localDate || '', async (value) => {
          // 清除日期（空值）＝改为日期待定；同样允许保存。
          if (value === plan.localDate) return;
          try {
            if (owner !== state.principal?.principalId) throw new Error('账号已切换，请重新打开日期选择。');
            await api(`/api/v1/plans/${encodeURIComponent(planId)}`, { method: 'PUT', body: JSON.stringify({
              name: plan.name, expectedRevision, localDate: value, cityCode: plan.cityCode || '310100',
              days: (plan.days || []).map(day => ({ dayIndex: day.dayIndex, stops: day.stops, routeLegs: day.routeLegs || [], plannedCharges: day.plannedCharges || [] })),
            }) });
            // 服务端在同一次更新中原子顺延该方案已展开的每日计划，避免部分请求失败后日期错位。
            await loadPlans().catch(() => {});
            render();
            toast(value ? `起始日期已改为 ${value}` : '日期已清除，方案改为日期待定');
          } catch (error) { toast(error.message, 'error'); }
        }, { minDate: dateKeyInTimeZone() });
      },
      'toggle-compare': (el) => {
        const id = el.dataset.plan;
        selectedComparisonSchemes();
        if (!(state.savedPlans || []).some(plan => plan.id === id && plan.kind === 'scheme')) return;
        const selected = state.compareSelection.has(id);
        if (selected) state.compareSelection.delete(id); else state.compareSelection.add(id);
        const nowSelected = state.compareSelection.has(id);
        // 保留 SVG 与按钮尺寸；只更新选择样式，避免重绘丢失草稿、焦点和展开内容。
        el.classList.toggle('is-selected', nowSelected);
        el.setAttribute('aria-pressed', String(nowSelected));
        el.setAttribute('aria-label', nowSelected ? '取消方案对比' : '加入方案对比');
        el.title = nowSelected ? '取消方案对比' : '加入方案对比';
        const visibleLabel = el.querySelector?.('.button-label');
        if (visibleLabel) visibleLabel.textContent = nowSelected ? '已加入' : '加入对比';
        el.closest('.candidate')?.classList.toggle('compare-selected', nowSelected);
        const count = selectedComparisonSchemes().length;
        const btn = document.querySelector('[data-action="compare-schemes"]');
        if (btn) {
          btn.dataset.count = String(count);
          btn.toggleAttribute('disabled', count < 2);
          btn.setAttribute('aria-disabled', String(count < 2));
          const label = comparisonButtonLabel(count);
          btn.setAttribute('aria-label', label);
          btn.title = label;
        }
      },
      // 让伴途在 Agent 对话里对比选中的方案：预填对比请求，用户确认后发送。
      'compare-schemes': async (el) => {
        const plans = selectedComparisonSchemes();
        if (plans.length < 2) return;
        const lines = plans.map((plan, index) => {
          const days = plan.days || [];
          const detail = days.map(day => `第 ${day.dayIndex + 1} 天：${(day.stops || []).filter(stop => stop.status !== 'skipped').map(stop => stop.place?.name || stop.stopId).join(' → ') || '暂无地点'}`).join('；');
          return `${index + 1}. ${plan.name}（${days.length} 天${plan.localDate ? `，${plan.localDate} 起` : '，日期待定'}）：${detail}`;
        });
        const newline = String.fromCharCode(10);
        const message = `请对比这几套方案，从节奏、路线顺路程度和体力消耗上给出建议，哪套更适合照着走：${newline}${lines.join(newline)}`;
        el.dataset.pendingCompare = message;
        await navigate('agent');
        offerChatPrompt(message);
        render();
        document.getElementById('chatText')?.focus();
      },
      'load-scheme': (el) => loadSchemeAsPlans(el.dataset.scheme),
      'confirm-scheme-progress-load': (el) => confirmSchemeProgressLoad(el.dataset.scheme, el.dataset.replaceExisting === 'true', el.dataset.confirmationToken || ''),
      'confirm-replace-load': (el) => confirmReplaceLoad(el.dataset.scheme, el.dataset.progressConfirmed === 'true', el.dataset.confirmationToken || ''),
      'plan-view-date': (el) => selectPlanDate(el.dataset.date || ''),
      'open-plan-date-picker': (el) => openPlanDatePicker(el),
      'select-plan-date-from-picker': (el) => selectPlanDateFromPicker(el),
      'delete-date-plan': (el) => confirmDeleteDatePlan(el.dataset.date || ''),
      'plan-draft-day': (el) => { draftSwitchDay(Number(el.dataset.day)); render(); },
      'confirm-plan-day-count': (el) => { setDraftDayCount(el.dataset.count); closeSheet(); render(); },
      'edit-saved-plan': (el) => {
        const showEditor = () => resumePlanDraft();
        if (openPlanPlanner({ editId: el.dataset.plan }, showEditor)) showEditor();
      },
      // 编辑已保存的计划只需要计划快照本身；地点目录用于补全下拉选项，临时不可用时不应阻塞编辑器。
      'edit-day-plan': async (el) => { await loadPlaces().catch(() => {}); openPlanPlanner({ editId: el.dataset.plan }); render(); },
      'edit-selected-day-plan': async (el) => { await loadPlaces().catch(() => {}); openSelectedDayPlanEditor(el.dataset.date || state.planViewDate); render(); },
      'edit-plan-stop-time': (el) => editPlanStopTime(el.dataset.plan, el.dataset.stop),
      'save-plan-stop-time': () => savePlanStopTime(),
      'ask-remove-plan-stop': (el) => askRemovePlanStop(el.dataset.plan, el.dataset.stop),
      'remove-plan-stop': (el) => removePlanStop(el.dataset.plan, el.dataset.stop),
      'discard-plan-draft': (el) => askDiscardPlanDraft(() => { clearPlanDraft(); state.planDraft = null; render(); }, { alwaysConfirm:el?.dataset.confirm === 'true' }),
      'resume-plan-draft': () => { resumePlanDraft(); queueDraftRoutes(state.planDraft?.days?.[state.planDraft.activeDay]); },
      'draft-as-new-scheme': () => openDraftAsScheme(),
      'confirm-draft-as-scheme': (el) => confirmDraftAsScheme(el),
      'confirm-plan-draft-change': (el) => confirmPlanDraftChange(el),
      'cancel-plan-draft-change': (el) => cancelPlanDraftChange(el),
      'plan-draft-move': (el) => { draftMove(Number(el.dataset.index), Number(el.dataset.dir)); render(); },
      'draft-stop-transport-mode': (el) => {
        const draft = state.planDraft, day = draft?.days?.find(item => item.dayIndex === Number(el.dataset.day));
        const stopId = el.dataset.stop;
        const stop = day?.stops?.find(item => item.stopId === stopId);
        if (!stop || stop.status && stop.status !== 'planned') return;
        const owner = state.principal?.principalId, view = state.currentView;
        const index = day.stops.indexOf(stop);
        const previous = [...day.stops.slice(0, index)].reverse().find(item => item.status !== 'skipped');
        const current = transportModeToStop(day, stop, previous);
        openTransportPicker(el, current, mode => {
          if (state.currentView !== view || state.principal?.principalId !== owner || state.planDraft !== draft ||
            !draft.days.includes(day) || !day.stops.includes(stop)) return;
          if (setDraftStopTransportMode(day.dayIndex, stopId, mode)) render();
        });
      },
      'retry-draft-stop-route': (el) => {
        const day = state.planDraft?.days?.find(item => item.dayIndex === Number(el.dataset.day));
        if (day) return estimateDraftRoutes(day, { targetStopId: el.dataset.stop });
      },
      'plan-draft-remove': (el) => { draftRemove(Number(el.dataset.index)); render(); },
      'draft-add-place': () => { draftAddPlace($('draft-add-place-select')?.value); render(); },
      'draft-next-day': () => { if (moveEmptyDayDraftToTomorrow()) { render(); toast('已改为明天的日计划'); } },
      'view-repeated-plan-place': () => viewRepeatedPlanPlace(),
      'save-plan-draft': async (el) => {
        const draft = state.planDraft;
        const editingDay = state.currentView === 'today' && Boolean(draft?.editId || draft?.dailyPlanDate);
        el.disabled = true;
        try {
          await savePlanDraft(); await loadPlans().catch(() => {}); render();
          toast(state.planDraft === draft && draft?.saveNotice ? draft.saveNotice : editingDay ? '这一天已保存' : '方案已保存到我的方案库');
        } catch (error) {
          const message = /Failed to fetch|NetworkError|Load failed/i.test(error?.message || '')
            ? '保存失败，请检查网络后重试。' : error.message;
          if (state.planDraft === draft && draft) { draft.saveError = message; render(); }
          const errorNotice = document.querySelector?.('.planner-save-error[role="alert"]');
          if (errorNotice) errorNotice.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
          else toast(message, 'error');
        } finally { el.disabled = false; }
      },
      'delete-saved-plan': (el) => confirmDeleteSavedPlan(el.dataset.plan),
      'confirm-delete-saved-plan': (el) => removeSavedPlan(el.dataset.plan),
      // 完整方案码只作内部内容格式；发布成功后由服务端返回可附在帖子里的短码。
      'share-plan-to-community': (el) => sharePlanToCommunity(el?.dataset.plan || '', el),
      'cancel-plan-share': () => cancelPlanShare(),
      'confirm-plan-share': (el) => confirmPlanShare(el),
      'view-plan-share': (el) => viewPlanShare(el.dataset.share),
      'import-plan-share': (el) => importPlanShare(el.dataset.share, el),
      'ask-withdraw-plan-share': (el) => askWithdrawPlanShare(el),
      'confirm-withdraw-plan-share': (el) => withdrawPlanShare(el),
      'favorite-post': (el) => togglePostFavorite(el),
      // 服务不可用恢复
      'dismiss-startup-error': () => dismissStartupRecovery(),
      'retry-bootstrap': () => window.location.reload(),
      'repair-app': async () => {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const registration of regs) await registration.unregister();
          const keys = await caches.keys();
          for (const key of keys) await caches.delete(key);
        } catch { /* 清理失败也直接刷新 */ }
        window.location.reload();
      },
      'model-settings': () => openModelSettings(),
      'official-model-settings': () => openModelSettings(true),
      'choose-model-service': (el) => chooseModelService(el),
      'use-official-model': () => configureModel('official'),
      'test-model': () => configureModel('test'),
      'save-model': () => configureModel('save'),
      'save-thinking': () => configureModel('thinking'),
      'disable-model': () => configureModel('disable'),
      'restore-version': (el) => restoreVersion(el.dataset.revision, el.dataset.date || ''),
      'edit-stop-time': (el) => editStopTime(el.dataset.stop),
      'preview-time': () => previewStopTime(),
      'confirm-plan-edit': async () => {
        try { await confirmPlanEdit(); }
        catch (error) {
          const status = document.getElementById('planAddStatus');
          if (!status || status.hidden || status.textContent !== error.message) throw error;
        }
      },
      'retry-chat': () => retryFailedChat(),
      'append-agent-prompt': () => { appendChatPrompt(); render(); $('chatText')?.focus({ preventScroll: true }); },
      'dismiss-agent-prompt': () => { dismissChatPrompt(); render(); },
      'open-agent-conversations': () => openAgentConversations(),
      'new-agent-conversation': () => newAgentConversation(),
      'rename-agent-conversation': el => renameAgentConversation(el.dataset.conversation || ''),
      'save-agent-conversation-title': el => saveAgentConversationTitle(el.dataset.conversation || ''),
      'delete-agent-conversation': el => deleteAgentConversation(el.dataset.conversation || ''),
      'confirm-delete-agent-conversation': el => confirmDeleteAgentConversation(el.dataset.conversation || ''),
      'switch-agent-conversation': (el) => switchAgentConversation(el.dataset.conversation || ''),
      'use-agent-suggestion': (el) => {
        const input = $('chatText');
        if (!input) return;
        offerChatPrompt(el?.dataset.text || '');
        render();
        $('chatText')?.focus({ preventScroll: true });
      },
      'load-older-messages': async () => { await loadOlderMessages(); render(); },
      'save-time': () => saveStopTime(),
      'install-pwa': () => {
        openSheet(
          '<h3>安装为 Windows 应用</h3><p>用 Edge 或 Chrome 打开本页，选择菜单“应用 → 安装此站点为应用”。安装后可从开始菜单独立启动。</p><div class="stop-actions"><button class="btn-primary" data-action="close-sheet">知道了</button></div>',
        );
      },
      'load-ready': async () => {
        await loadReady();
        render();
      },
      'font-toggle': () => toggleLargeText(),
      'theme-toggle': () => toggleTheme(),
      'compact-toggle': () => toggleCompactMode(),
      'display-preferences': () => openDisplayPreferences(),
    };

    export async function handleAction(action, el) {
      const handler = ACTIONS[action];
      if (!handler) return;
      await handler(el);
    }
