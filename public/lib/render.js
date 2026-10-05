import { releaseSceneFullscreen } from './scene-presentation.js';
import { mountSceneStoryMotion } from './scene-story-motion.js';
import { enhancePickers } from './ui-picker.js';
import { mountCardLayout } from './card-layout.js';
import { restorePostFeedPosition } from './post-feed.js';
import { deferRenderDuringPress } from './render-interaction.js';
import { startupRecoveryBanner } from './startup-recovery.js';
import { renderModeration } from '../views/moderation.js';
import { loadModeration } from './moderation.js';
import { focusAgentResultCard } from './agent-result-focus.js';
import { canonicalView, navigationGroup, sectionNavigation } from './navigation.js';
import { renderFavorites } from '../views/favorites.js';
import { renderMap } from '../views/map.js';
import { mountMap, disposeMap, loadMapData } from './map.js';
import { loadFavorites } from './favorites.js';
import { refreshClockLabels } from './trip-clock.js';
import { sessionRecoveryBanner } from './account-retention.js';
import { captureCommentEditors, restoreCommentEditors } from './comment-drafts.js';
import { retainPlanDraft, planDraftResumeNotice } from './plan-draft-storage.js';
/**
 * 渲染与视图分发。
 *
 * `render()` 负责把当前视图画进 #view，并同步标题、侧栏与待处理角标；
 * `navigate()` 切换视图并在需要时补拉数据。视图函数只产出 HTML，不回调这里，
 * 因此依赖方向是单向的：views → components → store/format。
 */
import { TITLES, escapeHtml, fmt, monthDay } from './format.js';
import { companionTarget } from './day-plan-selection.js';
import { $, state, tripId, usesSavedDayPlans } from './store.js';
import { loadGeneralMessages, loadMessages, loadCommunity, loadPlaceCommunity, loadPostDetail, loadAllMemories, loadPlaces } from './loaders.js';
import { renderCommunity, renderPostDetail } from '../views/community.js';
import { renderPlanShares } from '../views/plan-shares.js';
import { renderHome } from '../views/home.js';
import { renderToday } from '../views/today.js';
import { renderPlanHistory } from '../views/plan-history.js';
import { loadPlanHistory } from './plan-history.js';
import { loadCompanion, mountCompanion, disposeCompanion } from './companion.js';
import { renderPlan } from '../views/plan.js';
import { renderAgent } from '../views/agent.js';
import { captureChatComposer, mountChatComposer } from './chat-composer.js';
import { renderPlaces } from '../views/places.js';
import { renderPlace } from '../views/place.js';
import { renderScene } from '../views/scene.js';
import { mountSceneArtwork } from './scene-artwork.js';
import { syncSceneEntryNavigation } from './place-scene.js';
import { loadPlaceDetail, syncPlaceDetailNavigation } from './place-detail.js';
import { stopSceneSound } from './scene-sound.js';
import { renderAgentDock } from './agent-dock.js';
import { renderMemories } from '../views/memories.js';
import { renderMine } from '../views/mine.js';
import { renderAchievements } from '../views/achievements.js';
import { mountAchievementCardMotion } from './achievement-card-motion.js';
import { loadAchievements } from './achievements.js';
import { loadTracked, loadErrorBanner } from './load-state.js';
import { resolveStopPlace } from './components.js';

function scheduleLoad(key, loader, view) {
  void loadTracked(key, loader).then(() => {
    if (state.currentView === view) render();
  });
}

    export function navigate(view, { preserveScroll = false, replaceHistory = false } = {}) {
      view = canonicalView(view);
      if (!TITLES[view]) view = 'home';
      const previousView = state.currentView;
      state.currentView = view;
      state.navigationRevision = (state.navigationRevision || 0) + 1;
      if (state.agentResultTarget?.view !== view) state.agentResultTarget = null;
      const route = view === 'place' && state.placeDetailId
        ? `#/place/${encodeURIComponent(state.placeDetailId)}`
        : view === 'scene' && state.scenePlaceId ? `#/scene/${encodeURIComponent(state.scenePlaceId)}`
        : view === 'post-detail' && state.postDetailId
          ? `#/post/${encodeURIComponent(state.postDetailId)}`
        : view === 'plan-history' && state.planHistoryId ? `#/history/${encodeURIComponent(state.planHistoryId)}` : `#/${view}`;
      if (location.hash !== route) {
        if (replaceHistory) history.replaceState(null, '', route);
        else history.pushState(null, '', route);
      }
      if (view === 'favorites') scheduleLoad('favorites', loadFavorites, view);
      if (view === 'moderation') void loadModeration();
      if (view === 'map' && !state.mapConfig) scheduleLoad('places', loadMapData, view);
      if (view === 'places') {
        scheduleLoad('places', loadPlaces, view);
        scheduleLoad('community', loadPlaceCommunity, view);
      }
      // 深链接或从收藏/地图等入口直达详情时，目录可能还没加载。
      if (view === 'place') {
        const revision = state.navigationRevision;
        void loadPlaceDetail().then(() => {
          if (state.currentView === 'place' && state.navigationRevision === revision) render();
        });
      }
      if (view === 'scene' && (!state.sceneData || state.sceneData.placeId !== state.scenePlaceId)) {
        const sceneRevision = state.navigationRevision;
        void import('./place-scene.js').then(module => {
          if (state.currentView === 'scene' && state.navigationRevision === sceneRevision) return module.loadDeepLinkedScene();
        });
      }
      if (view === 'post-detail' && state.postDetailId) scheduleLoad('post-detail', () => loadPostDetail(state.postDetailId), view);
      if (view === 'community' || view === 'plan-shares') scheduleLoad('community', loadCommunity, view);
      if (view === 'today') {
        scheduleLoad('plans', () => import('./plan-library.js').then(m => m.ensureNearestPlanSession()), view);
      }
      if (view === 'plan-history') scheduleLoad('plan-history', loadPlanHistory, view);
      if (view === 'home') {
        scheduleLoad('plans', loadCompanion, view);
        scheduleLoad('memories', loadAllMemories, view);
      }
      if (view === 'plan') {
        // 方案库与手动规划不需要旅行：方案与地点目录都按当前身份加载。
        scheduleLoad('places', loadPlaces, view);
      }
      if (view === 'memories') scheduleLoad('memories', loadAllMemories, view);
      if (view === 'achievements' || view === 'mine' || view === 'profile') scheduleLoad('achievements', loadAchievements, view);
      if (view === 'mine' || view === 'profile') {
        scheduleLoad('favorites', loadFavorites, view);
        scheduleLoad('plans', () => import('./plan-library.js').then(m => m.loadPlans()), view);
        scheduleLoad('memories', loadAllMemories, view);
        scheduleLoad('community', loadCommunity, view);
      }
      if (view === 'agent') {
        // 有旅行加载行程对话；无旅行加载通用对话（伴途不绑定行程也能聊）。
        scheduleLoad('messages', usesSavedDayPlans() ? loadGeneralMessages : loadMessages, view);
      }
      render();
      if (previousView !== view) {
        if (!preserveScroll) window.scrollTo({ top: 0, behavior: 'auto' });
        requestAnimationFrame(() => {
          if (state.currentView !== view) return;
          if (state.agentResultTarget?.view === view) return;
          const heading = document.querySelector('#view .page-head h2, #view h2, #view h3') || $('pageTitle');
          if (heading) {
            if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
            heading.focus({ preventScroll: true });
          }
        });
      }
    }

    export function returnFromPlace() {
      const target = state.placeReturnView && state.placeReturnView !== 'place' && TITLES[state.placeReturnView]
        ? state.placeReturnView
        : 'places';
      const scrollY = Number.isFinite(state.placeReturnScrollY) ? state.placeReturnScrollY : 0;
      state.placeReturnView = '';
      state.placeReturnScrollY = 0;
      state.placeDetailId = '';
      navigate(target, { replaceHistory: true, preserveScroll: true });
      const revision = state.navigationRevision;
      requestAnimationFrame(() => {
        if (state.currentView === target && state.navigationRevision === revision) window.scrollTo({ top: scrollY, behavior:'auto' });
      });
    }

    export function returnFromPost(requestedView) {
      const origin = state.postReturnView && state.postReturnView !== 'post-detail' && TITLES[state.postReturnView]
        ? state.postReturnView
        : 'community';
      const target = requestedView && requestedView !== 'post-detail' && TITLES[requestedView] ? requestedView : origin;
      const scrollY = target === origin && Number.isFinite(state.postReturnScrollY) ? state.postReturnScrollY : 0;
      const anchor = target === 'community' && target === origin ? state.postReturnAnchor : null;
      state.postDetailId = '';
      state.postDetail = null;
      state.postReturnView = '';
      state.postReturnScrollY = 0;
      state.postReturnAnchor = null;
      navigate(target, { replaceHistory: true, preserveScroll: true });
      state.postFeedRestore = anchor ? { ...anchor, navigationRevision: state.navigationRevision, createdAt:Date.now() } : null;
      const revision = state.navigationRevision;
      requestAnimationFrame(() => {
        if (state.navigationRevision !== revision || state.currentView !== target) return;
        window.scrollTo({ top: scrollY, behavior:'instant' });
        restorePostFeedPosition();
      });
    }

    export function render() {
      if (deferRenderDuringPress(render)) return;
      captureChatComposer();
      retainPlanDraft();
      const view = canonicalView(state.currentView);
      state.currentView = view;
      syncSceneEntryNavigation();
      syncPlaceDetailNavigation();
      document.body?.classList?.toggle('place-scene-active', view === 'scene');
      const progress = $('trip-progress');
      const progressOpen = Boolean(progress && progress.dataset.trip === tripId() && progress.open);
      const recordsOpen = progressOpen && $('progress-records')?.open;
      const filterPanelOpen = $('placeFilterPanel')?.open;
      const advancedPanelOpen = $('placeAdvancedPanel')?.open;
      const activeField = document.activeElement;
      const fieldFocus = activeField?.id && $('view').contains?.(activeField) && activeField.matches?.('input,textarea')
        ? { id:activeField.id, start:activeField.selectionStart, end:activeField.selectionEnd } : null;
      if (view !== 'map') disposeMap({ cancelData: Boolean($('travel-map')) });
      if (view !== 'home') disposeCompanion();
      if (view !== 'scene' || state.sceneData?.placeId !== state.scenePlaceId) stopSceneSound();
      if (view !== 'scene') releaseSceneFullscreen();
      const candidateChatInput = view === 'agent' ? $('chatText') : null;
      const chatInput = candidateChatInput && (candidateChatInput.dataset?.chatOwner === undefined || candidateChatInput.dataset.chatOwner === (state.principal?.principalId || '')) && (candidateChatInput.dataset?.chatConversation === undefined || candidateChatInput.dataset.chatConversation === (state.agentConversationId || '')) ? candidateChatInput : null;
      const chatDraft = chatInput ? { value:chatInput.value, focused:document.activeElement === chatInput, start:chatInput.selectionStart, end:chatInput.selectionEnd } : undefined;
      const searchId = {places:'placeSearch',community:'postSearch'}[view];
      const search = searchId && $(searchId);
      const searchDraft = search ? {value:search.value, focused:document.activeElement === search, start:search.selectionStart, end:search.selectionEnd} : null;
      const memoryDraft = view === 'memories' ? $('memoryText')?.value : undefined;
      const commentEditors = captureCommentEditors();
      $('pageTitle').textContent = navigationGroup(view)?.title || TITLES[view] || '伴途';
      // 顶栏只保留当前页面名称。页面说明放在内容卡片里，避免不同入口出现
      // 两套副标题，也避免把“方案候选”等功能误解成另一种旅行状态。
      $('pageSubtitle').textContent = '';
      document.querySelectorAll('[data-nav]').forEach((button) => {
        const selected = button.closest('.sidebar, .bottom-nav') ? button.dataset.nav === (navigationGroup(view)?.entry || view) : button.dataset.nav === view;
        button.classList.toggle('active', selected);
        if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      });
      // 侧栏与首页使用同一随行目标，跨日及下一站不另选一份计划。
      {
        const target = companionTarget(state.savedPlans || [], state.companionPlanId);
        const nearest = target.plan;
        const stop = target.next;
        const stopPlace = resolveStopPlace(stop);
        $('sidebarTrip').innerHTML = nearest && stop
          ? `<strong>${escapeHtml(stopPlace?.name || stop.stopId)}</strong><span class="stop-meta">${escapeHtml(monthDay(nearest.localDate))} · ${target.phase === 'travel' ? '正在前往' : target.phase === 'visit' ? '正在游览' : `计划 ${fmt(stop.startMinutes)}`}</span>`
          : '<strong>开始规划</strong>按日期排好每一天';
      }
      const renderers = {
        moderation: renderModeration, achievements: renderAchievements,
        map: renderMap, favorites: renderFavorites, community: renderCommunity, 'post-detail': renderPostDetail, 'plan-shares': renderPlanShares,
        home: renderHome, today: renderToday, 'plan-history': renderPlanHistory, plan: renderPlan, agent: renderAgent,
        places: renderPlaces, place: renderPlace, scene: renderScene, memories: renderMemories, mine: renderMine, profile: renderMine,
      };
      const errorKeys = {
        home: ['memories', 'plans'], achievements: ['achievements'],
        favorites: ['favorites'], plan: ['plans', 'places'], memories: ['memories'], today: ['plans'], map: ['places'],
        mine: ['favorites', 'plans', 'memories', 'community', 'achievements'], profile: ['favorites', 'plans', 'memories', 'community', 'achievements'],
        places: ['places', 'community'], place: ['places'], scene: ['places'], community: ['community'], 'plan-shares': ['community'],
        agent: ['messages'],
      }[view] || [];
      const content = renderers[view]();
      $('view').innerHTML = startupRecoveryBanner() + sectionNavigation(view) + sessionRecoveryBanner(state.sessionRecoveryNotice) + loadErrorBanner(errorKeys) + planDraftResumeNotice(content.includes('id="draftName"') || content.includes('data-action="resume-plan-draft"')) + content;
      restoreCommentEditors(commentEditors);
      if (progressOpen && $('trip-progress')) $('trip-progress').open = true;
      if (recordsOpen && $('progress-records')) $('progress-records').open = true;
      if (filterPanelOpen && $('placeFilterPanel')) $('placeFilterPanel').open = true;
      if (advancedPanelOpen && $('placeAdvancedPanel')) $('placeAdvancedPanel').open = true;
      refreshClockLabels();
      if (view === 'map') mountMap();
      if (view === 'home') mountCompanion();
      if (chatDraft !== undefined && $('chatText')) {
        if (chatDraft.focused) { $('chatText').focus({preventScroll:true}); $('chatText').setSelectionRange(chatDraft.start,chatDraft.end); }
      }
      mountChatComposer();
      mountAchievementCardMotion();
      if (memoryDraft !== undefined && $('memoryText')) $('memoryText').value = memoryDraft;
      if (searchDraft && $(searchId)) {
        $(searchId).value = searchDraft.value;
        if (searchDraft.focused) { $(searchId).focus({preventScroll:true}); $(searchId).setSelectionRange(searchDraft.start,searchDraft.end); }
      }
      if (view === 'agent') {
        const list = $('chatList');
        if (list) {
          if (state.chatScrollRestore) {
            list.scrollTop = state.chatScrollRestore.top + (list.scrollHeight - state.chatScrollRestore.height);
            state.chatScrollRestore = null;
          } else {
            list.scrollTop = list.scrollHeight;
          }
        }
      }
      enhancePickers(document);
      mountCardLayout($('view'));
      if (state.postFeedRestore && typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(restorePostFeedPosition);
      const restoredField = fieldFocus && $(fieldFocus.id);
      if (restoredField) {
        restoredField.focus({preventScroll:true});
        if (typeof fieldFocus.start === 'number' && typeof fieldFocus.end === 'number') restoredField.setSelectionRange(fieldFocus.start,fieldFocus.end);
      }
      focusAgentResultCard();
      mountSceneStoryMotion(state.currentView === 'scene' ? `${state.principal?.principalId || 'guest'}:${state.sceneSessionKey || state.scenePlaceId}` : '');
      mountSceneArtwork();
      renderAgentDock();
      if (typeof window !== 'undefined') window.__bantuUiReady = true;
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('bantu:rendered'));
      const bootRecovery = document.getElementById('boot-recovery');
      if (bootRecovery) bootRecovery.hidden = true;
    }
