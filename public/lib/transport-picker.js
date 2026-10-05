import { escapeHtml } from './format.js';
import { uiIcon } from './icons.js';
import { openOptionPickerPanel } from './ui-picker.js';
import { TRANSPORT_MODES, transportModeInfo } from './transport-modes.js';

function transportPickerContent(mode, compact) {
  const info = transportModeInfo(mode) || { label: '方式待确认' };
  return `${uiIcon(info.icon || 'compass', { size: 18, className: 'transport-picker-icon' })}<span class="transport-picker-copy">${compact ? '' : '<small>交通方式</small>'}<strong>${escapeHtml(info.label)}</strong></span><span class="transport-picker-change" aria-hidden="true">${compact ? '' : '切换'}<span class="transport-picker-caret"></span></span>`;
}

export function transportPickerHtml(mode, { action, id, data = {}, disabled = false, compact = false, label = '选择交通方式' } = {}) {
  const attributes = Object.entries(data).filter(([key]) => /^[a-z][a-z0-9-]*$/.test(key))
    .map(([key, value]) => `data-${key}="${escapeHtml(String(value ?? ''))}"`).join(' ');
  return `<button type="button"${id ? ` id="${escapeHtml(id)}"` : ''} class="transport-picker${compact ? ' is-compact' : ''}" data-action="${escapeHtml(action)}" data-mode="${escapeHtml(mode)}" ${attributes} aria-label="${escapeHtml(label)}，当前：${escapeHtml(transportModeInfo(mode)?.label || '待确认')}" aria-haspopup="listbox" aria-expanded="false" ${disabled ? 'disabled' : ''}>${transportPickerContent(mode, compact)}</button>`;
}

/** Synchronize the map trigger without replacing Leaflet or the native route control. */
export function syncTransportPicker(button, mode) {
  if (!button) return;
  button.dataset.mode = mode;
  button.setAttribute('aria-label', `选择交通方式，当前：${transportModeInfo(mode)?.label || '待确认'}`);
  button.innerHTML = transportPickerContent(mode, button.classList.contains('is-compact'));
}

export function openTransportPicker(anchor, mode, onPick, { modes = TRANSPORT_MODES, routeModes } = {}) {
  if (anchor.disabled) return;
  const options = modes.map(option => ({ ...option,
    description: Array.isArray(routeModes) && !routeModes.includes(option.value)
      ? `${option.description} · 时间待估` : option.description,
  }));
  return openOptionPickerPanel(anchor, options, mode, onPick, {
    transport: true, label: '选择交通方式', searchPlaceholder: '搜索交通方式', emptyLabel: '没有匹配的交通方式',
    restoreFocus: () => {
      const replacement = [...document.querySelectorAll('.transport-picker')].find(button =>
        ['action', 'plan', 'stop', 'day'].every(key => button.dataset[key] === anchor.dataset[key]));
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    },
  });
}
