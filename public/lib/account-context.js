import { state } from './store.js';
import { escapeHtml } from './format.js';
import { retainPlanDraft } from './plan-draft-storage.js';
import { requestDeadline } from './http-request.js';

const CHANGE_KEY = 'bantu:account-context-change';
const samePrincipal = (a, b) => a?.principalId === b?.principalId && a?.kind === b?.kind;
let checking;
let observing = false;
let contextEpoch = 0;
export const accountContextEpoch = () => contextEpoch;

/** Broadcast only a change signal, never cookies, credentials or account data. */
export function announceAccountChange() {
  try { localStorage.setItem(CHANGE_KEY, `${Date.now()}:${Math.random()}`); } catch {}
}

export function pauseAccountContext() {
  const wasPaused = state.accountContextChanged;
  state.accountContextChanged = true;
  if (!wasPaused) contextEpoch += 1;
  if (!wasPaused && typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') document.dispatchEvent(new Event('bantu:account-context-paused'));
  if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function' || document.getElementById('accountContextNotice')) return;
  const notice = document.createElement('div');
  notice.id = 'accountContextNotice';
  notice.className = 'account-context-backdrop';
  notice.setAttribute('role', 'alertdialog');
  notice.setAttribute('aria-modal', 'true');
  notice.setAttribute('aria-labelledby', 'accountContextTitle');
  const nickname = state.principal?.nickname || state.principal?.username || '游客';
  const draftRetained = state.planDraft && retainPlanDraft();
  notice.innerHTML = `<section class="account-context-card"><p class="companion-kicker">保护当前编辑</p><h2 id="accountContextTitle">账号已在其他页面切换</h2><p>此页仍属于「${escapeHtml(nickname)}」，读写已暂停。</p><p>输入保留在本页。在账号页切回原账号后，可回到这里继续；也可以刷新，使用当前账号。</p>${state.planDraft ? (draftRetained ? '<p class="account-context-warning">计划草稿已在本标签页按原账号暂存。切回原账号后可继续，不会显示在当前账号下。</p>' : '<p class="account-context-warning">最新计划修改无法暂存，刷新可能丢失；请先切回原账号保存。</p>') : ''}<div class="stop-actions"><a class="btn-soft" href="/#/mine" target="_blank" rel="noopener">打开账号页</a><button class="btn-primary" data-sync-account-context>刷新到当前账号</button></div><button class="btn-ghost" data-check-account-context>已切回原账号，重新核对</button><p data-account-context-status aria-live="polite"></p></section>`;
  const background = [...document.querySelectorAll('.app, .bottom-nav, #sheetBackdrop, #agentDock, #smartCompanion')].map(element => ({ element, inert: element.inert }));
  background.forEach(({ element }) => { element.inert = true; });
  notice.__background = background;
  notice.__trigger = document.activeElement;
  notice.querySelector('[data-sync-account-context]').addEventListener('click', () => location.reload());
  notice.querySelector('[data-check-account-context]').addEventListener('click', () => { void checkAccountContext({ feedback: true }); });
  notice.addEventListener('keydown', event => {
    // The underlying sheet also has a document-level keyboard trap.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...notice.querySelectorAll('button, a[href]')];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  document.body.append(notice);
  notice.querySelector('[data-check-account-context]').focus({ preventScroll: true });
}

/** A delayed sheet teardown cannot release a separate account lock. Keep its
 * desired post-sheet state for restoration after the original owner returns. */
export function restoreBackgroundInert(element, inert) {
  if (state.accountContextChanged) {
    const notice = document.getElementById('accountContextNotice');
    const saved = notice?.__background?.find(item => item.element === element);
    if (saved) saved.inert = inert;
    element.inert = true;
  } else element.inert = inert;
}

function resumeAccountContext() {
  const wasPaused = state.accountContextChanged;
  state.accountContextChanged = false;
  if (wasPaused) contextEpoch += 1;
  if (typeof document === 'undefined') return;
  const notice = document.getElementById('accountContextNotice');
  if (!notice) return;
  for (const { element, inert } of notice.__background) if (element.isConnected) element.inert = inert;
  const trigger = notice.__trigger;
  notice.remove();
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  if (wasPaused) document.dispatchEvent(new Event('bantu:account-context-resumed'));
}

/** Check the cookie's actual profile without accepting it into this page's state. */
export async function checkAccountContext({ feedback = false, timeoutMs = 15000 } = {}) {
  if (!state.principal?.principalId) return false;
  // A new focus/storage/user check observes a newer cookie. It must not reuse
  // a response that the server produced before that account-change signal.
  const previous = checking;
  const active = { controller:new AbortController() };
  checking = active;
  previous?.controller.abort(new DOMException('账号核对已由新请求接替','AbortError'));
  const principal = state.principal, epoch = accountContextEpoch();
  const expected = { ...state.principal };
  const isCurrent = () => checking === active && state.principal === principal && accountContextEpoch() === epoch && samePrincipal(state.principal, expected);
  const request = (async () => {
    let message = '';
    const deadline = requestDeadline({timeoutMs,signal:active.controller.signal});
    try {
      const response = await deadline.wait(fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store', signal:deadline.signal }));
      const body = await deadline.wait(response.json());
      if (!isCurrent()) return false;
      if (response.ok && samePrincipal(expected, body?.data)) { resumeAccountContext(); return true; }
      if (response.ok || response.status === 401) { pauseAccountContext(); message = '仍未切回原账号，当前输入继续保留。'; }
      else message = '暂时无法核对账号，请检查连接后重试。';
    } catch { if (!isCurrent()) return false; message = '暂时无法核对账号，请检查连接后重试。'; }
    finally { deadline.dispose(); }
    if (feedback && checking === active && state.principal === principal && typeof document !== 'undefined') {
      const status = document.querySelector('[data-account-context-status]');
      if (status) status.textContent = message;
    }
    return false;
  })();
  try { return await request; } finally { if (checking === active) checking = null; }
}

export function observeAccountContext() {
  if (observing) return;
  observing = true;
  window.addEventListener('storage', event => { if (event.key === CHANGE_KEY) void checkAccountContext(); });
  window.addEventListener('focus', () => { void checkAccountContext(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkAccountContext(); });
}
