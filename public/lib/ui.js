import { stopSceneSpeech } from './scene-sound.js';
import { restoreBackgroundInert } from './account-context.js';
import { enhancePickers } from './ui-picker.js';
/**
 * 界面反馈：轻提示（toast）与底部面板（sheet）。
 *
 * 面板的易用性规则：
 * - 只在**首次**打开时记录触发元素，重开（例如锁定后刷新编辑面板）不覆盖它；
 * - 关闭后把焦点还给触发元素，键盘用户不会掉回页面顶部。
 * - 大图作为子面板打开，用户关闭时恢复原面板；业务关闭则清理所有层。
 *
 * 配套的样式规则（`[hidden]` 强制隐藏、标题栏吸顶）见 styles.css。
 */
import { $, state } from './store.js';

export function toast(message, type = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

let lastSheetTrigger = null;
let previousOverflow = '';
let backgroundElements = [];
let sheetViewportBound = false;
function announceSheetChange() {
  if(typeof window!=='undefined' && typeof window.dispatchEvent==='function' && typeof Event!=='undefined') window.dispatchEvent(new Event('bantu:sheet-changed'));
}
const parentSheets = [];
const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function sheetControls() {
  return [...$('sheet').querySelectorAll(focusableSelector)].filter(el => !el.closest('[hidden], [inert]') && el.getClientRects().length);
}

// Android's keyboard shrinks the visual viewport while 100dvh can remain full
// height. Keep the panel and its focused field inside the actually visible area.
function syncSheetViewport() {
  const backdrop = $('sheetBackdrop'), sheet = $('sheet');
  if (!backdrop || backdrop.hidden) return;
  const viewport = globalThis.window?.visualViewport;
  if (!viewport) return;
  backdrop.style.setProperty('--sheet-viewport-height', `${viewport?.height || innerHeight}px`);
  backdrop.style.setProperty('--sheet-viewport-top', `${viewport?.offsetTop || 0}px`);
  const field = document.activeElement;
  if (!field || !sheet.contains(field) || !field.matches('input, textarea, select')) return;
  const rect = field.getBoundingClientRect(), panel = sheet.getBoundingClientRect();
  const header = sheet.querySelector('.sheet-head')?.getBoundingClientRect();
  const top = Math.max(panel.top, header?.bottom || panel.top) + 12;
  const bottom = Math.min(panel.bottom, (viewport?.offsetTop || 0) + (viewport?.height || innerHeight)) - 12;
  if (rect.bottom > bottom) sheet.scrollTop += rect.bottom - bottom;
  else if (rect.top < top) sheet.scrollTop -= top - rect.top;
}

function bindSheetViewport() {
  if (sheetViewportBound || !globalThis.window?.visualViewport) return;
  sheetViewportBound = true;
  window.visualViewport?.addEventListener('resize', syncSheetViewport);
  window.visualViewport?.addEventListener('scroll', syncSheetViewport);
  window.addEventListener('resize', syncSheetViewport);
  $('sheet').addEventListener('focusin', () => window.requestAnimationFrame(syncSheetViewport));
}

export function openSheet(html, { nested = false, replace = false, trigger = document.activeElement } = {}) {
  const sheet = $('sheet');
  if (sheet.querySelector('.scene-settings-panel')) stopSceneSpeech({source:'preview'});
  if (nested && !$('sheetBackdrop').hidden) {
    parentSheets.push({
      nodes: [...sheet.childNodes],
      scrollTop: sheet.scrollTop,
      trigger,
      labels: ['aria-labelledby', 'aria-label'].map(name => [name, sheet.getAttribute(name)]),
    });
  } else if (!replace || $('sheetBackdrop').hidden) {
    parentSheets.length = 0;
  }
  if ($('sheetBackdrop').hidden) {
    lastSheetTrigger = document.activeElement;
    previousOverflow = document.body.style.overflow;
    backgroundElements = [...document.querySelectorAll('.app, .bottom-nav, #agentDock, #smartCompanion')].map(el => ({el, inert:el.inert}));
    backgroundElements.forEach(({el}) => { el.inert = true; });
    document.body.style.overflow = 'hidden';
  }
  sheet.innerHTML = html;
  enhancePickers(sheet);
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.tabIndex = -1;
  const title = sheet.querySelector('h3, h2');
  if (title) {
    title.id = 'sheetDialogTitle';
    sheet.setAttribute('aria-labelledby', title.id);
    sheet.removeAttribute('aria-label');
  } else {
    sheet.removeAttribute('aria-labelledby');
    sheet.setAttribute('aria-label', '操作面板');
  }
  $('sheetBackdrop').hidden = false;
  bindSheetViewport();
  syncSheetViewport();
  sheet.scrollTop = 0;
  const controls = sheetControls();
  const field = controls.find(el => el.matches('input, textarea, select'));
  (field || controls[0] || sheet).focus({preventScroll:true});
  globalThis.window?.requestAnimationFrame?.(syncSheetViewport);
  announceSheetChange();
}

export function closeSheet() {
  state.planSharePreview = null;
  parentSheets.length = 0;
  if ($('sheetBackdrop').hidden) return;
  if ($('sheet').querySelector('.scene-settings-panel')) stopSceneSpeech({source:'preview'});
  $('sheetBackdrop').hidden = true;
  $('sheet').innerHTML = '';
  document.body.style.overflow = previousOverflow;
  backgroundElements.forEach(({el, inert}) => { restoreBackgroundInert(el, inert); });
  backgroundElements = [];
  if (!state.accountContextChanged && lastSheetTrigger && document.contains(lastSheetTrigger)) lastSheetTrigger.focus();
  lastSheetTrigger = null;
  announceSheetChange();
}

/** User dismissal returns from an enlarged image to its existing floor panel. */
export function dismissSheet() {
  const parent = parentSheets.pop();
  if (!parent) { closeSheet(); return; }
  const sheet = $('sheet');
  sheet.replaceChildren(...parent.nodes);
  for (const [name, value] of parent.labels) {
    if (value === null) sheet.removeAttribute(name);
    else sheet.setAttribute(name, value);
  }
  sheet.scrollTop = parent.scrollTop;
  if (parent.trigger && sheet.contains(parent.trigger)) parent.trigger.focus({ preventScroll: true });
  else (sheetControls()[0] || sheet).focus({ preventScroll: true });
}

export function handleSheetKeydown(event) {
  if ($('sheetBackdrop').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); dismissSheet(); return; }
  if (event.key !== 'Tab') return;
  const controls = sheetControls();
  const first = controls[0], last = controls.at(-1);
  if (!first) { event.preventDefault(); $('sheet').focus(); return; }
  if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}
