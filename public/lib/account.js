import { api } from './api.js';
import { $, state } from './store.js';
import { escapeHtml } from './format.js';
import { openSheet, toast } from './ui.js';
import { render } from './render.js';
import { guestRetentionNotice } from './account-retention.js';
import { announceAccountChange } from './account-context.js';
let busy = false;
export function openAccount(notice = '') {
 if (busy) { toast('账号操作处理中，请稍候'); return; }
 const heading = '<div class="sheet-head"><h3>我的账号</h3><button data-action="close-sheet" aria-label="关闭">✕</button></div>';
 const note = notice ? `<p class="stop-meta">${escapeHtml(notice)}</p>` : '';
 if (state.principal?.kind === 'account') {
  openSheet(`${heading}${note}<p>已登录：${escapeHtml(state.principal.username)}</p><p>计划、笔记与收藏保存在此账号下，退出后可重新登录找回。社区昵称在「我的」页修改。</p><button class="btn-soft" data-action="account-logout">退出登录 / 切换账号</button>`); return;
 }
 openSheet(`${heading}${note}${guestRetentionNotice(state.principal, false)}<p class="account-switch-note">登录已有账号会切换到该账号资料，并撤销当前游客会话，原游客资料不会合并。希望保留，请先注册新账号。</p>
 <form data-account-form><label for="accountUsername">账号</label><input id="accountUsername" autocomplete="username" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" required placeholder="例如 bantu_xiaoai"><p class="account-username-hint">3–24 位英文、数字或下划线，不区分大小写。</p>
 <label for="accountPassword">密码</label><input id="accountPassword" type="password" autocomplete="current-password" minlength="8" maxlength="128" required placeholder="至少 8 位"><p class="account-password-hint">当前没有密码找回功能，请妥善保存账号和密码。</p>
 <p id="accountStatus" role="status"></p><div class="stop-actions account-auth-actions"><button class="btn-soft" type="submit" value="login">登录</button><button class="btn-primary" type="submit" value="register">注册并保留当前数据</button></div></form>`);
}
export async function submitAccount(mode, button) {
 if (busy) return;
 const username = $('accountUsername'), password = $('accountPassword'), status = $('accountStatus');
 if (!username || !password || !status || !button) return;
 const controls = [username, password, ...document.querySelectorAll('[data-account-form] button')];
 busy = true; controls.forEach(control => { control.disabled = true; });
 try {
  status.textContent = mode === 'register' ? '正在注册并保留当前记录…' : '正在登录…';
  await api(`/api/v1/account/${mode}`, {method:'POST',body:JSON.stringify({username:username.value,password:password.value})});
  announceAccountChange();
  try { sessionStorage.setItem('bantu:intentional-account-switch', '1'); } catch { /* Storage is optional. */ }
  // 整页重载，清除前一个身份的旅行、草稿和待授权动作。
  location.replace('/#/mine'); location.reload();
 } catch(error) { if (status.isConnected) status.textContent = error.message; else toast(error.message, 'error'); }
 finally {busy = false; controls.forEach(control => { control.disabled = false; });}
}
export async function logoutAccount() {
 if (busy) return;
 busy = true;
 try {
  await api('/api/v1/session', {method:'DELETE'});
  announceAccountChange();
  try { sessionStorage.setItem('bantu:intentional-account-switch', '1'); } catch { /* Storage is optional. */ }
  location.replace('/#/home'); location.reload();
 } finally { busy = false; }
}
export function editCommunityNickname() {
 if (state.principal?.kind !== 'account') return;
 state.editingCommunityNickname = true;
 render();
 const input = $('communityNickInput');
 input?.focus();
 input?.select();
}
export function cancelCommunityNicknameEdit() {
 state.editingCommunityNickname = false;
 render();
 document.querySelector('.nickname-display')?.focus();
}
export async function saveNickname(button) {
 if (busy) return;
 busy = true; if (button) button.disabled = true;
 try {
  const result = await api('/api/v1/me', {method:'PATCH', body:JSON.stringify({nickname:$('communityNickInput')?.value})});
  if (state.principal) state.principal.nickname = result.nickname;
  state.editingCommunityNickname = false;
  render();
  toast('社区昵称已更新，发帖与评论将自动使用');
 } catch (error) { toast(error.message, 'error'); }
 finally { busy = false; if (button) button.disabled = false; }
}
