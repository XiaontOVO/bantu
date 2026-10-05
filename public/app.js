import { bindSceneHitInteraction } from './lib/scene-hit-interaction.js';
import { loadAchievements } from './lib/achievements.js';
import { restoredTripId } from './lib/trip-selection.js';
import { refreshAgentTaskStatus } from './lib/agent-task-status.js';
import { chooseAgentImages } from './lib/agent-images.js';
import { loadFavorites } from './lib/favorites.js';
import { loadMapData } from './lib/map.js';
import { refreshClockLabels } from './lib/trip-clock.js';
import { showStartupRecovery } from './lib/startup-recovery.js';
/**
 * 伴途前端入口（ES module）。
 *
 * 只做两件事：启动（bootstrap）与事件绑定。其余按层分文件：
 *   lib/format.js      中文标签与格式化（纯函数）
 *   lib/store.js       前端状态与 DOM 取用
 *   lib/api.js         HTTP 客户端
 *   lib/ui.js          toast 与底部面板
 *   lib/components.js  视图共用片段
 *   views/*.js         每个页面一个渲染函数（只产出 HTML）
 *   lib/loaders.js     数据加载（不负责重绘）
 *   lib/render.js      渲染与视图分发
 *   lib/commands.js    业务动作与面板
 *   lib/actions.js     data-action 动作表
 *
 * 依赖方向自上而下、无环：views → components → store/format；
 * commands → render/loaders；actions → commands。视图不回调 render()，
 * 所以这条链不会绕回来。
 *
 * 注意：本文件是 module，没有全局作用域——新增代码必须显式 import。
 */
import { TITLES, dateKeyInTimeZone, escapeHtml } from './lib/format.js';
import { $, state } from './lib/store.js';
import { api } from './lib/api.js';
import { closeSheet, dismissSheet, toast, handleSheetKeydown } from './lib/ui.js';
import { emptyState } from './lib/components.js';
import { navigate, render, returnFromPost } from './lib/render.js';
import { loadTracked } from './lib/load-state.js';
import { loadPlaceDetail, syncPlaceDetailNavigation } from './lib/place-detail.js';
import { loadTrips, loadPlaces, loadAllMemories, loadGeneralMessages, loadReady, loadCommunity, loadPlaceCommunity, loadPostDetail } from './lib/loaders.js';
import { loadPlans, migrateLegacyTripToPlans, requestDraftDayCountChange, syncPlanDraftInput } from './lib/plan-library.js';
import { restorePlanDraft } from './lib/plan-draft-storage.js';
import { sendChat, stopAgentTask, resumeAgentTask } from './lib/commands.js';
import { captureChatComposer } from './lib/chat-composer.js';
import { handleAction } from './lib/actions.js';
import { openPostDetail } from './lib/community.js';
import { loadPlanHistory, openPlanHistory } from './lib/plan-history.js';
import { openPersonalAgentResult } from './lib/agent-result-navigation.js';
import { restoreTheme, toggleLargeText, toggleTheme } from './lib/preferences.js';
import { submitAccount, saveNickname } from './lib/account.js';
import { SESSION_NOTICE_KEY } from './lib/account-retention.js';
import { startLocation } from './lib/location.js';
import { isUnmodifiedPrimaryClick } from './lib/link-click.js';
import { canonicalView } from './lib/navigation.js';
import { uiIcon } from './lib/icons.js';
import { syncCommentDraft } from './lib/comment-drafts.js';
import { observeAccountContext, announceAccountChange } from './lib/account-context.js';
import { startSceneArrivalWatch, syncSceneDepartureWatch, syncSceneTimingWatch, onSceneVisibilityChange, suspendPlaceScene, loadDeepLinkedScene, leavePlaceScene } from './lib/place-scene.js';
import { closeAgentDock, renderAgentDock } from './lib/agent-dock.js';
import { initSmartCompanion } from './lib/smart-companion.js';
import { initAgentSpeech } from './lib/agent-speech.js';
import { initNativeShell, createNativeBackHandler } from './lib/native-shell.js';

initNativeShell({
  handleBack:createNativeBackHandler({ state, sheetOpen:() => Boolean($('sheetBackdrop') && !$('sheetBackdrop').hidden),
    dismissSheet, leaveScene:leavePlaceScene, closeDock:closeAgentDock, navigate }),
  onBackground:suspendPlaceScene,
  onForeground:onSceneVisibilityChange,
});
initAgentSpeech();
initSmartCompanion();

let renderedLocationLabel = '';
window.addEventListener('bantu:location-updated', () => {
  // The location label is part of the home journey heading and the memory
  // editor fallback. Re-render those views after reverse geocoding; otherwise
  // the app bar updates while the page keeps showing the previous city.
  const label = state.geoLabel || state.geoAppbarText || '';
  if (label === renderedLocationLabel) return;
  renderedLocationLabel = label;
  if (state.currentView === 'home' || state.currentView === 'memories') render();
});
window.addEventListener('bantu:rendered', () => { void startSceneArrivalWatch(); syncSceneDepartureWatch(); syncSceneTimingWatch(); });
window.addEventListener('bantu:agent-dock-closed', syncSceneDepartureWatch);
document.addEventListener('visibilitychange', onSceneVisibilityChange);
document.addEventListener('bantu:account-context-paused', suspendPlaceScene);
document.addEventListener('bantu:account-context-paused', syncPlaceDetailNavigation);
document.addEventListener('bantu:account-context-resumed', () => {
  if (state.currentView === 'place') { void loadPlaceDetail().then(render); render(); }
});
document.addEventListener('bantu:account-context-resumed', onSceneVisibilityChange);
window.matchMedia('(max-width:620px)').addEventListener('change', renderAgentDock);
bindSceneHitInteraction();

function parseHashRoute(hash) {
  const raw = (hash || '#/home').replace('#/', '') || 'home';
  const route = (prefix, view) => {
    try { return { view, id: decodeURIComponent(raw.slice(prefix.length)) }; }
    catch { return { view, id: '' }; }
  };
  if (raw.startsWith('place/')) return route('place/', 'place');
  if (raw.startsWith('scene/')) return route('scene/', 'scene');
  if (raw.startsWith('post/')) return route('post/', 'post-detail');
  if (raw.startsWith('history/')) return route('history/', 'plan-history');
  return { view: canonicalView(raw), id: '' };
}

    document.addEventListener('click', async (event) => {
      const resumeButton = event.target.closest('[data-resume-agent]');
      if (resumeButton) { try { await resumeAgentTask(resumeButton.dataset.resumeAgent); } catch (error) { toast(error.message, 'error'); } return; }
      const resultLink = event.target.closest('[data-agent-result-view]');
      if (resultLink && ['home','today', 'plan', 'places', 'favorites', 'memories', 'community'].includes(resultLink.dataset.agentResultView)) {
        if (resultLink.dataset.resultId) {
          try { await openPersonalAgentResult(resultLink.dataset.agentResultView, resultLink.dataset.resultId); } catch (error) { toast(error.message, 'error'); }
          return;
        }
        if (resultLink.dataset.agentResultView === 'community' && resultLink.dataset.postId) { openPostDetail(resultLink.dataset.postId); return; }
        if (resultLink.dataset.agentResultView === 'today' && /^\d{4}-\d{2}-\d{2}$/.test(resultLink.dataset.date || '')) state.planViewDate = resultLink.dataset.date;
        navigate(resultLink.dataset.agentResultView); return;
      }
      if (event.target.closest('[data-stop-agent]')) { try { await stopAgentTask(); } catch (error) { toast(error.message, 'error'); } return; }
      if (event.target.closest('[data-select-agent-images]')) {
        if (!state.chatPending && !state.chatImagesBusy) $('agentImageInput')?.click();
        return;
      }
      if (event.target.closest('[data-clear-agent-images]')) { if (!state.chatPending) { state.chatImages = []; render(); } return; }
      // 点击遮罩空白处关闭面板：面板此前只能靠内部按钮关闭。
      if (event.target === $('sheetBackdrop')) { dismissSheet(); return; }
      const navButton = event.target.closest('[data-nav]');
      if (navButton) {
        closeSheet();
        if (navButton.dataset.nav === 'plan-history') openPlanHistory();
        else navigate(navButton.dataset.nav);
        return;
      }
      const actionButton = event.target.closest('[data-action]');
      if (!actionButton) return;
      if (actionButton.matches('button[type="submit"]') && actionButton.closest('[data-search-form]')) return;
      // 评论按钮是表单提交入口，统一由 submit 事件处理，避免点击时重复发送。
      if (['submit-comment', 'authorize-moderation'].includes(actionButton.dataset.action)) return;
      if (actionButton.matches('a[href]')) {
        if (!isUnmodifiedPrimaryClick(event)) return;
        event.preventDefault();
      }
      try { await handleAction(actionButton.dataset.action, actionButton); }
      catch (error) { toast(error.message, 'error'); }
    });
    document.addEventListener('input', (event) => {
      const input = event.target;
      if (input.id === 'chatText') captureChatComposer();
      syncPlanDraftInput(input);
      if (input.matches?.('[data-comment-draft]')) syncCommentDraft(input);
    });
    document.addEventListener('toggle', event => {
      if (event.target.matches?.('.post-comment-reply')) {
        const input = event.target.querySelector('[data-comment-draft]');
        if (input) syncCommentDraft(input, { feedback: false });
      }
    }, true);
    document.addEventListener('change', (event) => {
      if (event.target.matches?.('[name="modelServiceChoice"]')) {
        handleAction('choose-model-service', event.target).catch(error => toast(error.message, 'error'));
      }
      const input = event.target;
      if (input instanceof HTMLInputElement && input.id === 'agentImageInput') { void chooseAgentImages(input); return; }
      if (!(input instanceof HTMLInputElement) || input.id !== 'draftDayCount') return;
      try {
        const shouldRender = requestDraftDayCountChange(input.value);
        if (shouldRender) render();
        else input.value = String(state.planDraft?.days.length || 1);
      } catch (error) {
        input.value = String(state.planDraft?.days.length || 1);
        toast(error.message, 'error');
      }
    });
    document.addEventListener('keydown', handleSheetKeydown);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !state.agentDockOpen) return;
      event.preventDefault();
      closeAgentDock();
    });
    document.addEventListener('submit', async (event) => {
      if (!(event.target instanceof HTMLFormElement)) return;
      if (event.target.matches('[data-moderation-auth]')) {
        event.preventDefault();
        const button = event.target.querySelector('[data-action="authorize-moderation"]');
        if (button) await handleAction('authorize-moderation', button);
        return;
      }
      if (event.target.matches('[data-comment-form]')) {
        event.preventDefault();
        const button = event.target.querySelector('[data-action="submit-comment"]');
        if (!button) return;
        try { await handleAction('submit-comment', button); } catch (error) { toast(error.message, 'error'); }
        return;
      }
      if (event.target.matches('[data-nickname-form]')) {
        event.preventDefault();
        const button = event.submitter instanceof HTMLButtonElement
          ? event.submitter
          : event.target.querySelector('button[type="submit"]');
        try { await saveNickname(button); } catch (error) { toast(error.message || '保存昵称失败', 'error'); }
        return;
      }
      if (event.target.matches('[data-account-form]')) {
        event.preventDefault();
        const mode = event.submitter?.value === 'register' ? 'register' : 'login';
        const button = event.submitter instanceof HTMLButtonElement
          ? event.submitter
          : event.target.querySelector(`button[type="submit"][value="${mode}"]`);
        try { await submitAccount(mode, button); } catch (error) { toast(error.message, 'error'); }
        return;
      }
      if (event.target.matches('[data-search-form]')) {
        event.preventDefault();
        const action = event.target.dataset.searchForm;
        const button = event.target.querySelector('[data-action]');
        try { await handleAction(action, button); } catch(error) { toast(error.message, 'error'); }
        return;
      }
      if (!event.target.matches('[data-chat-form]')) return;
      event.preventDefault();
      const input = $('chatText');
      const text = input?.value || '';
      if (state.chatPending || state.chatImagesBusy) return;
      if (!text.trim() && !(state.chatImages || []).length) { toast('先输入一条消息或选择照片再发送。', 'error'); input?.focus(); return; }
      try { await sendChat(text); } catch (error) { toast(error.message, 'error'); }
    });
    $('fontToggle')?.addEventListener('click', toggleLargeText);
    window.addEventListener('pagehide', () => captureChatComposer());
    $('themeToggle')?.addEventListener('click', toggleTheme);
    window.addEventListener('hashchange', () => {
      // 浏览器返回或深链接切页时，清理旧面板和背景 inert，避免大图留在新页面上。
      closeSheet();
      const { view, id } = parseHashRoute(location.hash);
      const samePost = view === 'post-detail' && state.postDetailId === id;
      const samePlace = view === 'place' && state.placeDetailId === id;
      const sameHistory = view === 'plan-history' && state.planHistoryId === id;
      const sameScene = view === 'scene' && state.scenePlaceId === id;
      if (view === 'place') state.placeDetailId = id;
      if (view === 'scene') state.scenePlaceId = id;
      if (view === 'post-detail') state.postDetailId = id;
      if (view === 'plan-history') { state.planHistoryId = id; if (!sameHistory) state.planHistoryDetail = null; }
      if (state.currentView === 'post-detail' && view !== 'post-detail') { returnFromPost(view); return; }
      if (view !== state.currentView || (view === 'place' && !samePlace) || (view === 'scene' && !sameScene) || (view === 'post-detail' && !samePost) || (view === 'plan-history' && !sameHistory)) navigate(view, { preserveScroll: true });
      else if (view === 'place') render();
    });

    async function bootstrap(force = false) {
      restoreTheme();
      let sessionRecovery = null;
      if (!state.principal || force) {
        // Reset obsolete session state before loading. A user may start editing
        // on another page while these requests are still pending.
        state.trip = null; state.proposal = null; state.actionRequests = [];
        state.messages = []; state.memoryCursor = null; state.memoriesScope = '';
        state.agentConversationId = ''; state.agentConversationOwner = ''; state.agentConversations = []; state.agentConversationLoading = false;
        state.routePreview = null; state.planEdit = null; state.lastMutation = null;
        state.principal = null;
        state.achievements = null; state.achievementsOwner = ''; state.achievementSelected = ''; state.achievementFilter = 'all';
        state.accountContextChanged = false;
        sessionRecovery = await api('/api/v1/session/guest', { method: 'POST' });
        state.principal = await api('/api/v1/me');
        observeAccountContext();
        if (!sessionRecovery?.restored) announceAccountChange();
        // 旧旅行列表只用于迁移历史记录；它不可再成为应用启动的硬依赖。
        await loadTracked('trips', loadTrips);
        const legacyTripId = restoredTripId();
        let tripMigrationFailed = false;
        if (legacyTripId) {
          try { await migrateLegacyTripToPlans(legacyTripId); }
          catch (error) {
            tripMigrationFailed = true;
            console.warn('[bantu] 旧旅行进度迁移失败；已保留服务器原记录。', error);
          }
        }
        await loadTracked('favorites', loadFavorites);
        await loadTracked('plans', loadPlans);
        restorePlanDraft();
        await loadReady().catch(() => {});
        // 地点目录属于应用本身，不再依赖是否存在旧 Trip。
        // 旧旅行只用于一次性迁移记录；没有旅行实例时也必须能找地点、建计划和打开地图。
        await loadTracked('places', loadPlaces);
        state.legacyTripMigrationFailed = tripMigrationFailed;
      }
      startLocation();
      // Resolve the latest route after loading, including any navigation made
      // during startup. Never restore the URL captured before the requests.
      const bootRoute = parseHashRoute(location.hash);
      state.currentView = bootRoute.view;
      if (state.currentView === 'place') state.placeDetailId = bootRoute.id;
      if (state.currentView === 'scene') state.scenePlaceId = bootRoute.id;
      if (state.currentView === 'post-detail') state.postDetailId = bootRoute.id;
      if (state.currentView === 'plan-history') state.planHistoryId = bootRoute.id;
      if (!TITLES[state.currentView]) state.currentView = 'home';
      if (['achievements', 'mine', 'profile'].includes(state.currentView)) await loadTracked('achievements', loadAchievements);
      if (state.currentView === 'community' || state.currentView === 'plan-shares') await loadTracked('community', loadCommunity);
      if (state.currentView === 'post-detail') await loadTracked('post-detail', () => loadPostDetail(state.postDetailId));
      if (state.currentView === 'map') await loadTracked('places', loadMapData);
      // 地点目录与社区审核数据是两个独立来源；任一来源暂时不可用时，不能把整个页面变成启动失败。
      if (state.currentView === 'places') await Promise.allSettled([loadTracked('places', loadPlaces), loadTracked('community', loadPlaceCommunity)]);
      if (state.currentView === 'place') { const request = loadPlaceDetail(); render(); await request; }
      if (state.currentView === 'scene') await loadDeepLinkedScene();
      if (state.currentView === 'plan') await loadTracked('places', loadPlaces);
      if (state.currentView === 'mine' || state.currentView === 'profile') await Promise.all([
        loadTracked('community', loadCommunity),
      ]);
      if (state.currentView === 'today') await loadTracked('plans', () => import('./lib/plan-library.js').then(m => m.ensureNearestPlanSession()));
      if (state.currentView === 'plan-history') await loadTracked('plan-history', loadPlanHistory);
      if (state.currentView === 'home') await loadTracked('plans', () => import('./lib/companion.js').then(m => m.loadCompanion()));
      if (location.hash === '#/companion') history.replaceState(null, '', '#/home');
      if (state.currentView === 'home' || state.currentView === 'memories' || state.currentView === 'mine' || state.currentView === 'profile') await loadTracked('memories', loadAllMemories);
      if (state.currentView === 'agent') await loadTracked('messages', loadGeneralMessages);
      const intentionalAccountSwitch = sessionStorage.getItem('bantu:intentional-account-switch') === '1';
      sessionStorage.removeItem('bantu:intentional-account-switch');
      const previousSessionInvalid = !intentionalAccountSwitch && (sessionRecovery?.previousSessionInvalid || sessionStorage.getItem('bantu:session-invalid') === '1');
      if (intentionalAccountSwitch) {
        sessionStorage.removeItem('bantu:session-invalid');
        sessionStorage.removeItem('bantu:session-recovered');
        sessionStorage.removeItem(SESSION_NOTICE_KEY);
      }
      state.sessionRecoveryNotice = state.principal?.kind !== 'account' && (previousSessionInvalid || sessionStorage.getItem(SESSION_NOTICE_KEY) === '1');
      if (state.sessionRecoveryNotice) sessionStorage.setItem(SESSION_NOTICE_KEY, '1');
      else sessionStorage.removeItem(SESSION_NOTICE_KEY);
      state.startupError = '';
      render();
      if (state.legacyTripMigrationFailed) toast('旧旅行中的进度暂时没能迁入日计划；原记录仍保存在账号里。', 'error');
      if (previousSessionInvalid) {
        sessionStorage.removeItem('bantu:session-invalid');
        sessionStorage.removeItem('bantu:session-recovered');
      } else if (sessionStorage.getItem('bantu:session-recovered') === '1') {
        sessionStorage.removeItem('bantu:session-recovered');
        toast('服务连接已恢复；刚才的操作请重试');
      }
      // 兜底标记：应用成功启动后，index.html 的启动恢复界面不再出现（含慢启动时主动收回）。
      window.__bantuBooted = true;
      const bootRecovery = document.getElementById('boot-recovery');
      if (bootRecovery) bootRecovery.hidden = true;
    }

    /** 服务连不上或长时间无响应时，给出可操作的恢复界面，而不是永远卡在骨架屏。 */
    function showRecoveryScreen(reason) {
      const detail = reason === 'Failed to fetch'
        ? '无法连接到伴途服务，请检查服务和网络后重试。'
        : reason;
      if (window.__bantuUiReady) {
        showStartupRecovery(detail);
        return;
      }
      window.__bantuRecoveryShown = true;
      const bootRecovery = document.getElementById('boot-recovery');
      if (bootRecovery) bootRecovery.hidden = true;
      $('view').innerHTML = `<div class="card empty-state"><div><div class="empty-state-icon" aria-hidden="true">${uiIcon('repair', { size: 28 })}</div><h3>伴途暂未加载完成</h3><p>${escapeHtml(detail)}</p>
        <p class="stop-meta">如果服务已停止，请双击项目目录里的「启动伴途.cmd」；本地缓存冲突时用下面的修复按钮。</p>
        <div class="stop-actions"><button class="btn-primary" data-action="retry-bootstrap">重试连接</button><button class="btn-ghost" data-action="repair-app">清除缓存并刷新</button></div></div></div>`;
    }

    async function repairApp() {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const registration of regs) await registration.unregister();
        const keys = await caches.keys();
        for (const key of keys) await caches.delete(key);
      } catch { /* 清理失败也直接刷新 */ }
      window.location.reload();
    }

    async function runBootstrap() {
      let timer;
      try {
        await Promise.race([bootstrap(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('启动等待时间较长，部分内容仍在加载。')), 10000); })]);
      } finally { clearTimeout(timer); }
    }

    runBootstrap().catch((error) => {
      showRecoveryScreen(error && error.message ? error.message : '连接服务时出现问题。');
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

let observedPlanExpiryState = null;
let rolloverRefreshPending = false;

function planExpiryState() {
  const now = new Date();
  return (state.savedPlans || [])
    .filter(plan => plan.kind !== 'scheme' && plan.localDate)
    .map(plan => `${plan.id}:${plan.localDate < dateKeyInTimeZone(now, plan.timezone || 'Asia/Shanghai') ? 'expired' : 'active'}`)
    .sort()
    .join('|');
}

async function refreshAfterTripDateChanges() {
  refreshClockLabels();
  const expiryState = planExpiryState();
  const planExpiryChanged = observedPlanExpiryState !== null && expiryState !== observedPlanExpiryState;
  if (observedPlanExpiryState === null) observedPlanExpiryState = expiryState;
  if (!planExpiryChanged || rolloverRefreshPending) return;

  rolloverRefreshPending = true;
  try {
    await Promise.all([loadPlans(), loadAllMemories()]);
    observedPlanExpiryState = planExpiryState();
    render();
  } catch {
    // Keep the old observed date so the next timer tick retries the server refresh.
  } finally {
    rolloverRefreshPending = false;
  }
}

setInterval(refreshAfterTripDateChanges, 15000);
setInterval(refreshAgentTaskStatus, 1500);
