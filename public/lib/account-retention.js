import { clockText, escapeHtml } from './format.js';
import { uiIcon } from './icons.js';

export const SESSION_NOTICE_KEY = 'bantu:guest-session-replaced';

export function guestRetentionNotice(principal, withAction = true) {
  if (!principal || principal.kind === 'account') return '';
  const expiry = Number.isFinite(Date.parse(principal.expiresAt)) ? clockText(principal.expiresAt) : '';
  return `<section class="account-retention-note"><span class="account-retention-icon" aria-hidden="true">${uiIcon('archive', { size: 21 })}</span><div><strong>游客记录尚未绑定账号</strong><p>注册新账号可保留当前计划、往日记录、笔记和收藏。清除站点数据、会话过期或登录其他账号后，无法自动恢复原游客入口。</p>${expiry ? `<small>当前游客会话有效至 ${escapeHtml(expiry)}</small>` : ''}</div>${withAction ? '<button class="btn-soft" data-action="account-panel">注册并保留记录</button>' : ''}</section>`;
}

export function sessionRecoveryBanner(visible) {
  if (!visible) return '';
  return `<section class="account-recovery-banner" role="status"><div><strong>当前已切换为游客</strong><p>之前的会话已失效。原账号记录仍属于原账号，登录后可继续；未注册的游客资料无法自动找回。</p></div><div class="stop-actions"><button class="btn-primary" data-action="account-panel">登录原账号</button><button class="btn-ghost" data-action="dismiss-session-notice">知道了</button></div></section>`;
}
