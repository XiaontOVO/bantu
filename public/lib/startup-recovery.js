import { state } from './store.js';
import { escapeHtml } from './format.js';

let returnFocus;

export function startupRecoveryBanner() {
  if (!state.startupError) return '';
  return `<section class="card startup-recovery" role="status"><div><strong>启动还未完成</strong><p>${escapeHtml(state.startupError)}</p><p class="stop-meta">当前页面和输入已保留，可以继续等待。重新加载会丢失未保存的输入。</p></div><div class="stop-actions"><button class="btn-soft" data-action="dismiss-startup-error">继续使用</button><button class="btn-ghost" data-action="retry-bootstrap">重新加载</button></div></section>`;
}

/** Add feedback without replacing an editor, map or focused input. */
export function showStartupRecovery(detail) {
  state.startupError = detail;
  const view = document.getElementById('view');
  if (view?.contains(document.activeElement)) returnFocus = document.activeElement;
  const existing = view?.querySelector('.startup-recovery');
  if (existing) existing.outerHTML = startupRecoveryBanner();
  else view?.insertAdjacentHTML('afterbegin', startupRecoveryBanner());
}

export function dismissStartupRecovery() {
  state.startupError = '';
  document.querySelector('.startup-recovery')?.remove();
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll:true });
  returnFocus = null;
}
