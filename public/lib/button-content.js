import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';

/** 图标辅助识别，文字说明动作；共用布局保证两者作为整体居中。 */
export function buttonContent(icon, label) {
  return `<span class="button-content">${uiIcon(icon, { size: 18, className: 'button-icon' })}<span class="button-label">${escapeHtml(label)}</span></span>`;
}
