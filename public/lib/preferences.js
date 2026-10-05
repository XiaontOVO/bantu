/**
 * 本地显示偏好：大字模式、深浅色与简约模式。
 *
 * 显示设置不走服务端，顶栏与「我的」页按钮共用同一函数——
 * 早先这两处各写了一份逻辑，改一处容易漏另一处。
 */
import { toast, openSheet } from './ui.js';
import { uiIcon } from './icons.js';
import { compactModeEnabled, setCompactMode, restoreCompactMode } from './compact-mode.js';

const THEME_KEY = 'bantu-theme';
const LARGE_TEXT_CLASS = 'large-text';

function syncDisplayPreferences() {
  const large = document.body.classList.contains(LARGE_TEXT_CLASS);
  const dark = document.documentElement.dataset.theme === 'dark';
  for (const [key, active, label] of [['large', large, large ? '已开启' : '未开启'], ['theme', dark, dark ? '深色' : '浅色']]) {
    document.querySelectorAll(`[data-display-preference="${key}"]`).forEach(button => {
      button.setAttribute('aria-pressed', String(active));
      button.textContent = label;
    });
  }
}

export function openDisplayPreferences() {
  openSheet(`<section class="display-preferences-panel"><div class="row-between row-center"><h3>显示设置</h3><button class="action-icon" data-action="close-sheet" aria-label="关闭显示设置">${uiIcon('close', { size:20 })}</button></div>
    <p class="stop-meta">按你的阅读习惯调整，当前页面会即时更新。</p>
    <div class="profile-row"><div><strong>大字模式</strong><span>户外阅读更清楚</span></div><button class="btn-small" data-action="font-toggle" data-display-preference="large" aria-label="切换大字模式"></button></div>
    <div class="profile-row"><div><strong>深浅色</strong><span>选择舒适的页面底色</span></div><button class="btn-small" data-action="theme-toggle" data-display-preference="theme" aria-label="切换深浅色"></button></div>
    <div class="profile-row"><div><strong>简约模式</strong><span>图文操作只显示图标</span></div><button class="btn-small" data-action="compact-toggle" aria-label="切换简约模式" aria-pressed="${compactModeEnabled()}">${compactModeEnabled() ? '已开启' : '未开启'}</button></div></section>`);
  syncDisplayPreferences();
}

export function toggleLargeText() {
  document.body.classList.toggle(LARGE_TEXT_CLASS);
  syncDisplayPreferences();
  toast(
    document.body.classList.contains(LARGE_TEXT_CLASS) ? '已切换大字模式' : '已恢复标准字号',
  );
}

export function toggleCompactMode() {
  const enabled = !compactModeEnabled();
  const saved = setCompactMode(enabled);
  toast(saved ? (enabled ? '已开启简约模式' : '已恢复图标与文字') : '显示已切换，但当前浏览器无法记住设置。', saved ? 'info' : 'error');
}

/** 深浅色跟随本地记录；首次访问用 <html data-theme> 的默认值。 */
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  syncDisplayPreferences();
  toast(next === 'dark' ? '已切换深色模式' : '已切换浅色模式');
}

/** 启动时恢复上次选择；没有记录就保持 HTML 上的默认值。 */
export function restoreTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
  restoreCompactMode();
}
