import { state } from './store.js';
import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';
import { renderAgent } from '../views/agent.js';
import { loadGeneralMessages } from './loaders.js';
import { companionTarget } from './day-plan-selection.js';
import { resolveStopPlace } from './components.js';
import { bindAgentDockMotion, positionAgentDock } from './agent-dock-motion.js';
import { captureChatComposer, chatComposerDraft, mountChatComposer, offerChatPrompt } from './chat-composer.js';
import { stopSceneSpeech } from './scene-sound.js';

const PAGE_LABELS = { achievements: '旅行成就', home: '首页随行', places: '地点目录', place: '地点详情', scene: '地点现场', today: '计划与进度', plan: '方案候选', map: '地图与路线', memories: '旅行记忆', favorites: '我的收藏', community: '社区', 'post-detail': '帖子详情' };

function contextLabel() {
  if (state.currentView === 'scene' && state.sceneData?.placeId === state.scenePlaceId) {
    const hotspot = state.sceneData.hotspots.find(item => item.id === state.sceneSelectedHotspotId);
    return `${state.sceneData.placeName}${hotspot ? ` · 正在查看${hotspot.title}` : ' · 地点现场'}`;
  }
  if (state.currentView === 'place') {
    const place = state.places.find(item => item.placeId === state.placeDetailId);
    return place ? `地点详情 · ${place.name}` : '地点详情';
  }
  if (state.currentView === 'post-detail') {
    const post = state.postDetail?.id === state.postDetailId ? state.postDetail : null;
    return post ? `帖子详情 · ${post.nickname}` : '帖子详情';
  }
  if (state.currentView === 'home' || state.currentView === 'today') {
    const target = companionTarget(state.savedPlans || [], state.companionPlanId);
    const place = resolveStopPlace(target.next);
    if (place?.name) return `${PAGE_LABELS[state.currentView]} · ${place.name}`;
  }
  return PAGE_LABELS[state.currentView] || '当前页面';
}

const VISIBILITY_KEY = 'bantu-agent-dock-visible';
let visibilityOverride;

export function agentDockVisible() {
  if (typeof visibilityOverride === 'boolean') return visibilityOverride;
  try { return localStorage.getItem(VISIBILITY_KEY) !== 'off'; } catch { return true; }
}
export function toggleAgentDockVisibility() {
  const enabled = !agentDockVisible();
  visibilityOverride = enabled;
  try { localStorage.setItem(VISIBILITY_KEY, enabled ? 'on' : 'off'); } catch { /* Keep the current-page choice usable. */ }
  if (!enabled) state.agentDockOpen = false;
  renderAgentDock();
  if (!enabled) stopDockSpeech();
}
export function dismissAgentDock() {
  visibilityOverride = false;
  try { localStorage.setItem(VISIBILITY_KEY, 'off'); } catch { }
  state.agentDockOpen = false;
  renderAgentDock();
  stopDockSpeech();
}
export function takeAgentDockDraft() {
  stopSceneSpeech({source:'agent'});
  captureChatComposer(document.getElementById('agentDock'));
  return chatComposerDraft().text;
}

/** A movable, non-modal window outside #view; the page remains interactive. */
export function renderAgentDock() {
  const host = typeof document !== 'undefined' ? document.getElementById('agentDock') : null;
  if (!host) return;
  captureChatComposer(host);
  const navEntry = document.querySelector('.bottom-nav [data-nav="agent"]');
  if (navEntry) {
    navEntry.setAttribute('aria-label', '伴途 Agent');
    navEntry.removeAttribute('aria-expanded'); navEntry.removeAttribute('aria-controls');
  }
  document.querySelectorAll('[data-action="toggle-agent-dock-visibility"]').forEach(button => {
    button.setAttribute('aria-pressed', String(agentDockVisible()));
    button.textContent = agentDockVisible() ? '已开启' : '未开启';
  });
  if (state.currentView === 'agent' || !agentDockVisible()) {
    state.agentDockOpen = false;
    document.body.classList.remove('agent-dock-open');
    host.hidden = true; host.innerHTML = '';
    return;
  }
  const input = host.querySelector('#chatText');
  const draft = input ? { focused:document.activeElement === input, start:input.selectionStart, end:input.selectionEnd } : null;
  const list = host.querySelector('#chatList');
  const oldScroll = list ? { bottom:list.scrollHeight - list.scrollTop - list.clientHeight } : null;
  host.hidden = false;
  host.classList.toggle('is-open', Boolean(state.agentDockOpen));
  document.body.classList.toggle('agent-dock-open', Boolean(state.agentDockOpen));
  const contextIncluded = state.agentContextExcludedRevision !== state.navigationRevision;
  host.innerHTML = state.agentDockOpen
    ? `<section class="agent-dock-panel" aria-label="伴途 Agent 小窗"><header class="agent-dock-head"><div class="agent-dock-title" data-agent-drag-handle tabindex="0" role="button" aria-label="移动伴途小窗：拖动或使用方向键"><span class="agent-dock-avatar">${uiIcon('agent', { size:22 })}</span><div class="agent-dock-title-copy"><strong>伴途</strong><span>陪你慢慢看</span></div><span class="agent-drag-grip" aria-hidden="true"></span></div><div class="agent-dock-tools"><button type="button" class="agent-dock-full-short" data-action="open-full-agent" aria-label="打开完整对话" title="完整对话">${uiIcon('expand', { size:18 })}</button><button type="button" class="agent-dock-close" data-action="close-agent-dock" aria-label="收起伴途小窗" title="收起">${uiIcon('chevron-down', { size:18 })}</button><button type="button" class="agent-dock-close" data-action="dismiss-agent-dock" aria-label="关闭伴途悬浮窗，可在我的设置重新开启" title="关闭">${uiIcon('close', { size:18 })}</button></div></header><div class="agent-dock-context-row"><button type="button" class="agent-dock-context" data-action="toggle-agent-context" aria-pressed="${contextIncluded}" title="${contextIncluded ? '点击后，本页内容将不随下一条消息发送' : '点击后，下一条消息将附带当前页面信息'}" ${state.chatPending ? 'disabled' : ''}><span class="agent-context-indicator" aria-hidden="true"></span><span>${escapeHtml(contextIncluded ? `附带本页 · ${contextLabel()}` : '不附当前页面 · 点此恢复')}</span></button></div>${renderAgent({compact:true})}</section>`
    : `<div class="agent-dock-bubble"><button type="button" class="agent-dock-launcher" data-agent-drag-handle data-action="toggle-agent-dock" aria-label="打开伴途对话；长按拖动可移动" aria-expanded="false">${uiIcon('agent', { size:25 })}<span>问伴途</span></button><button type="button" class="agent-dock-dismiss" data-action="dismiss-agent-dock" aria-label="关闭伴途悬浮窗，可在我的设置重新开启">${uiIcon('close', { size:16 })}</button></div>`;
  const newInput = host.querySelector('#chatText');
  if (newInput) {
    if (draft?.focused) {
      newInput.focus({ preventScroll:true });
      if (Number.isFinite(draft.start) && Number.isFinite(draft.end)) newInput.setSelectionRange(draft.start, draft.end);
    }
  }
  const newList = host.querySelector('#chatList');
  if (newList) newList.scrollTop = oldScroll && oldScroll.bottom > 35 ? newList.scrollHeight - newList.clientHeight - oldScroll.bottom : newList.scrollHeight;
  bindAgentDockMotion(host);
  positionAgentDock(host);
  mountChatComposer(host);
}

export function toggleAgentDockContext() {
  if (state.chatPending || !state.agentDockOpen) return;
  state.agentContextExcludedRevision = state.agentContextExcludedRevision === state.navigationRevision
    ? -1 : state.navigationRevision;
  renderAgentDock();
  document.querySelector('#agentDock .agent-dock-context')?.focus({ preventScroll: true });
}

export async function openAgentDock({ prefill = '' } = {}) {
  const owner = state.principal?.principalId;
  if (prefill) offerChatPrompt(prefill);
  if (state.currentView === 'agent') {
    if (prefill) {
      const agentUi = await import('./render.js');
      if (state.principal?.principalId !== owner || state.currentView !== 'agent') return;
      agentUi.render();
    }
    const input = document.getElementById('chatText');
    input?.focus();
    return;
  }
  visibilityOverride = true;
  try { localStorage.setItem(VISIBILITY_KEY, 'on'); } catch { }
  state.agentDockOpen = true;
  renderAgentDock();
  const immediateInput = document.querySelector('#agentDock #chatText');
  immediateInput?.focus();
  await loadGeneralMessages().catch(() => {});
  if (state.principal?.principalId !== owner || !state.agentDockOpen || state.currentView === 'agent') return;
  renderAgentDock();
}

export function closeAgentDock() {
  state.agentDockOpen = false;
  renderAgentDock();
  const sceneButton = document.querySelector('.place-scene .scene-agent-button');
  const launcher = document.querySelector('#agentDock .agent-dock-launcher');
  (sceneButton?.getClientRects().length ? sceneButton : launcher?.getClientRects().length ? launcher
    : document.querySelector('.bottom-nav [data-nav="agent"]'))?.focus({ preventScroll: true });
  stopDockSpeech();
}

function stopDockSpeech() {
  stopSceneSpeech({source:'agent'});
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('bantu:agent-dock-closed'));
}
