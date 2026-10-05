/**
 * 统一选择器：把原生 select / date / time 的系统弹出框替换为与主题一致的自绘面板。
 *
 * 用法：给控件加 data-ui="picker"，每次渲染后调用 enhancePickers(document)。
 * 原生控件被包进 .picker-host 并关闭指针事件（系统弹框不会再出现），
 * 点击打开自绘面板；选择结果写回控件原值并派发 change 事件，现有读取 .value 的逻辑不受影响。
 */

import { dateKeyInTimeZone } from './format.js';
import { uiIcon } from './icons.js';


let cleanup = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function closePicker() {
  if (cleanup) { cleanup(); cleanup = null; }
}

function openPopover(anchor, html, { restoreFocus, transport = false } = {}) {
  closePicker();
  const pop = document.createElement('div');
  pop.className = `picker-pop${transport ? ' transport-picker-pop' : ''}`;
  pop.innerHTML = html;
  document.body.appendChild(pop);
  if (restoreFocus) anchor.setAttribute('aria-expanded', 'true');
  // 弹层锚定在触发按钮旁；页面滚动或视口变化时重新计算位置，避免脱离按钮。
  const position = () => {
    if (!pop.isConnected) return;
    const margin = 8;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) {
      closePicker();
      return;
    }

    const width = Math.min(Math.max(260, Math.round(rect.width)), Math.max(120, viewportWidth - margin * 2));
    pop.style.position = 'fixed';
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${Math.max(120, viewportHeight - margin * 2)}px`;
    let height = pop.offsetHeight;
    const below = viewportHeight - margin - rect.bottom - 6;
    const above = rect.top - margin - 6;
    const placeBelow = height <= below || (height > above && below >= above);

    if (height > Math.max(above, below)) {
      pop.style.maxHeight = `${Math.max(120, Math.min(viewportHeight - margin * 2, Math.max(above, below)))}px`;
      height = pop.offsetHeight;
    }

    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
    const preferredTop = placeBelow ? rect.bottom + 6 : rect.top - height - 6;
    const top = Math.max(margin, Math.min(preferredTop, viewportHeight - margin - height));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  };
  position();
  // Capture the outside click before app-level delegated handlers see it. If the
  // popover were removed on mousedown, that same click could activate a nav
  // button underneath it and unexpectedly switch pages.
  const onOutside = (event) => {
    if (pop.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    closePicker();
  };
  const onKey = (event) => { if (event.key === 'Escape') closePicker(); };
  const onScroll = (event) => {
    // 弹层内的列表/滚轮由自身滚动；页面或容器滚动时则跟随触发按钮。
    if (pop.contains(event.target)) return;
    position();
  };
  setTimeout(() => {
    if (!pop.isConnected) return;
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onKey);
  }, 0);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', position, { passive: true });
  window.visualViewport?.addEventListener('scroll', position, { passive: true });
  window.visualViewport?.addEventListener('resize', position, { passive: true });
  cleanup = () => {
    pop.remove();
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', position);
    window.visualViewport?.removeEventListener('scroll', position);
    window.visualViewport?.removeEventListener('resize', position);
    if (restoreFocus) {
      anchor.setAttribute('aria-expanded', 'false');
      restoreFocus();
    }
  };
  return pop;
}

/** 通用选项面板：options=[{value,label}]，选中后回调 onPick(value)。 */
export function openOptionPickerPanel(anchor, options, current, onPick, settings = {}) {
  return optionListPopover(anchor, options, current, onPick, settings);
}

function optionListPopover(anchor, options, current, onPick, settings = {}) {
  // 选项较多时提供搜索：按名称或 ID 过滤（不区分大小写）。
  const search = options.length > 6
    ? `<input type="text" class="picker-search" placeholder="${esc(settings.searchPlaceholder || '搜索名称或编号')}" aria-label="${esc(settings.searchPlaceholder || '搜索地点')}">`
    : '';
  const pop = openPopover(anchor, `${settings.transport ? `<p class="transport-picker-heading">${esc(settings.label)}</p>` : ''}${search}<div class="picker-list" ${settings.transport ? `role="listbox" aria-label="${esc(settings.label)}"` : ''}>${options.map((option) =>
    `<button type="button" class="picker-option${settings.transport ? ' transport-option' : ''}${option.value === current ? ' active' : ''}" ${settings.transport ? `role="option" aria-selected="${option.value === current}" tabindex="-1"` : ''} data-value="${esc(option.value)}" data-hay="${esc(`${option.label} ${option.value} ${option.description || ''}`.toLowerCase())}">${settings.transport ? `${uiIcon(option.icon || 'compass', { size: 18 })}<span class="transport-option-copy"><strong>${esc(option.label)}</strong><small>${esc(option.description || '')}</small></span><span class="transport-option-check" aria-hidden="true"></span>` : esc(option.label)}</button>`).join('') || `<p class="picker-empty">${esc(settings.emptyLabel || '无匹配地点')}</p>`}</div>`, settings);
  if (settings.transport) pop.classList.add('transport-picker-pop');
  const searchInput = pop.querySelector('.picker-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      let visible = 0;
      pop.querySelectorAll('.picker-option').forEach((btn) => {
        const show = !q || (btn.dataset.hay || '').includes(q);
        btn.hidden = !show;
        if (show) visible += 1;
      });
      let emptyNote = pop.querySelector('.picker-empty-note');
      if (!visible && !emptyNote) {
        emptyNote = document.createElement('p');
        emptyNote.className = 'picker-empty-note';
        emptyNote.textContent = settings.emptyLabel || '没有匹配的地点';
        pop.appendChild(emptyNote);
      } else if (emptyNote) {
        emptyNote.hidden = visible > 0;
      }
    });
    setTimeout(() => { if (pop.isConnected) searchInput.focus(); }, 60);
  }
  pop.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-value]');
    if (!btn || btn.hidden) return;
    closePicker();
    onPick(btn.dataset.value);
    // onPick may replace the trigger as it refreshes the home or plan view.
    settings.restoreFocus?.();
  });
  if (settings.transport) {
    const focusOption = button => {
      pop.querySelectorAll('.picker-option').forEach(item => { item.tabIndex = item === button ? 0 : -1; });
      button?.focus({ preventScroll: true });
      if (!button) return;
      const list = pop.querySelector('.picker-list'), itemBox = button.getBoundingClientRect(), listBox = list.getBoundingClientRect();
      if (itemBox.top < listBox.top) list.scrollTop -= listBox.top - itemBox.top;
      else if (itemBox.bottom > listBox.bottom) list.scrollTop += itemBox.bottom - listBox.bottom;
    };
    const selected = pop.querySelector('.picker-option.active') || pop.querySelector('.picker-option');
    if (selected) selected.tabIndex = 0;
    if (!searchInput) setTimeout(() => { if (pop.isConnected) focusOption(selected); }, 0);
    pop.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closePicker(); return;
      }
      const option = event.target.closest('.transport-option');
      if ((event.key === 'Enter' || event.key === ' ') && option && !option.hidden) {
        event.preventDefault(); option.click(); return;
      }
      const choices = [...pop.querySelectorAll('.picker-option')].filter(button => !button.hidden);
      const index = choices.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = choices[(index + 1) % choices.length];
      else if (event.key === 'ArrowUp') next = choices[(index < 0 ? choices.length : index + choices.length - 1) % choices.length];
      else if (event.key === 'Home' && event.target !== searchInput) next = choices[0];
      else if (event.key === 'End' && event.target !== searchInput) next = choices.at(-1);
      else if (event.key === 'Tab') {
        if (event.target === searchInput && !event.shiftKey && choices.length) next = choices[0];
        else { closePicker(); return; }
      }
      else return;
      event.preventDefault();
      if (next) focusOption(next);
    });
  }
  return pop;
}

function optionPicker(anchor, control) {
  const options = [...control.options].filter((option) => !option.disabled)
    .map((option) => ({ value: option.value, label: option.label || option.value }));
  optionListPopover(anchor, options, control.value, (value) => {
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const pad2 = (value) => String(value).padStart(2, '0');

/** 供任意元素使用的日历面板：选好日期后回调 onPick('YYYY-MM-DD')。 */
export function openDatePickerPanel(anchor, value, onPick, options = {}) {
  const control = { value: value || '' };
  datePopover(anchor, control, (picked) => { control.value = picked; onPick(picked); }, options);
}

function datePopover(anchor, control, onPicked, options = {}) {
  const apply = onPicked ?? ((picked) => { control.value = picked; control.dispatchEvent(new Event('change', { bubbles: true })); });
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(control.value || '');
  const todayKey = dateKeyInTimeZone();
  const minDate = options.minDate || '';
  const initialDate = parsed && (!minDate || control.value >= minDate) ? parsed : null;
  const [todayYear, todayMonth] = todayKey.split('-').map(Number);
  let year = initialDate ? Number(initialDate[1]) : todayYear;
  let month = initialDate ? Number(initialDate[2]) - 1 : todayMonth - 1;
  let selectedDay = initialDate ? Number(initialDate[3]) : null;
  const pop = openPopover(anchor, '<div class="picker-date" id="pickerDateBody"></div>');
  const redraw = () => {
    const body = pop.querySelector('#pickerDateBody');
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const lead = first.getDay();
    const selectedKey = selectedDay ? `${year}-${pad2(month + 1)}-${pad2(selectedDay)}` : '';
    let cells = '';
    for (let i = 0; i < lead; i += 1) cells += '<span></span>';
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${year}-${pad2(month + 1)}-${pad2(day)}`;
      const cls = ['picker-day'];
      const disabled = Boolean(minDate && key < minDate);
      if (key === todayKey) cls.push('today');
      if (key === selectedKey) cls.push('selected');
      if (disabled) cls.push('disabled');
      cells += `<button type="button" class="${cls.join(' ')}" data-day="${day}"${disabled ? ' disabled aria-disabled="true"' : ''}>${day}</button>`;
    }
    body.innerHTML = `<div class="picker-date-head">
        <button type="button" class="picker-nav" data-picker-month="-1" aria-label="上个月">‹</button>
        <strong>${year}年${month + 1}月</strong>
        <button type="button" class="picker-nav" data-picker-month="1" aria-label="下个月">›</button>
        <button type="button" class="picker-today" data-today>今天</button>
      </div>
      <div class="picker-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
      <div class="picker-grid">${cells}</div>
      <div class="picker-date-actions"><button type="button" class="picker-option" data-clear>清除日期</button></div>`;
  };
  redraw();
  pop.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-picker-month]');
    if (nav) {
      month += Number(nav.dataset.pickerMonth);
      if (month < 0) { month = 11; year -= 1; }
      if (month > 11) { month = 0; year += 1; }
      selectedDay = null;
      redraw();
      return;
    }
    const clear = event.target.closest('[data-clear]');
    if (clear) { apply(''); closePicker(); return; }
    const todayBtn = event.target.closest('[data-today]');
    if (todayBtn) {
      apply(todayKey); closePicker(); return;
    }
    const day = event.target.closest('[data-day]');
    if (day && !day.disabled) {
      apply(`${year}-${pad2(month + 1)}-${pad2(Number(day.dataset.day))}`); closePicker();
    }
  });
}

/** 供任意元素使用的时间面板：确认后回调 onPick('HH:MM')。 */
export function openTimePickerPanel(anchor, value, onPick) {
  const control = { value: value || '' };
  timePopover(anchor, control, (picked) => { control.value = picked; onPick(picked); });
}

/** Scroll-wheel picker for planned visit length, in 15-minute increments. */
export function openDurationPickerPanel(anchor, currentMinutes, onPick) {
  const ITEM = 38;
  const options = Array.from({ length: 32 }, (_, index) => (index + 1) * 15);
  const current = Math.max(15, Math.min(480, Math.round(Number(currentMinutes) / 15) * 15 || 60));
  let selected = current;
  const label = (minutes) => {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (hours && remainder) return `${hours} 小时 ${remainder} 分钟`;
    if (hours) return `${hours} 小时`;
    return `${remainder} 分钟`;
  };
  const pop = openPopover(anchor, `<div class="picker-time duration-picker">
      <div class="picker-wheel duration-picker-wheel"><div class="picker-wheel-band"></div><div class="picker-wheel-col" role="listbox" tabindex="0" aria-label="停留时长">${'<div class="picker-wheel-spacer"></div>'}${options.map(minutes => `<div class="picker-wheel-item${minutes === selected ? ' on' : ''}" data-duration="${minutes}" role="option" aria-selected="${minutes === selected ? 'true' : 'false'}">${label(minutes)}</div>`).join('')}${'<div class="picker-wheel-spacer"></div>'}</div></div>
      <div class="picker-date-actions"><button type="button" class="picker-option" data-cancel>取消</button><button type="button" class="picker-option primary" data-ok>确定 ${label(selected)}</button></div>
    </div>`);
  const column = pop.querySelector('.picker-wheel-col');
  const confirmLabel = () => {
    const button = pop.querySelector('[data-ok]');
    if (button) button.textContent = `确定 ${label(selected)}`;
    column.querySelectorAll('[data-duration]').forEach(item => {
      const active = Number(item.dataset.duration) === selected;
      item.classList.toggle('on', active);
      item.setAttribute('aria-selected', String(active));
    });
  };
  const syncFromScroll = () => {
    const index = Math.max(0, Math.min(options.length - 1, Math.round(column.scrollTop / ITEM)));
    selected = options[index];
    confirmLabel();
  };
  column.scrollTop = options.indexOf(selected) * ITEM;
  column.focus({ preventScroll: true });
  let scrollTimer;
  column.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(syncFromScroll, 120);
  });
  column.addEventListener('keydown', (event) => {
    const index = options.indexOf(selected);
    const next = event.key === 'ArrowDown' ? Math.min(options.length - 1, index + 1)
      : event.key === 'ArrowUp' ? Math.max(0, index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    selected = options[next];
    column.scrollTo({ top: next * ITEM, behavior: 'smooth' });
    confirmLabel();
  });
  column.addEventListener('click', (event) => {
    const item = event.target.closest('[data-duration]');
    if (!item) return;
    selected = Number(item.dataset.duration);
    column.scrollTo({ top: options.indexOf(selected) * ITEM, behavior: 'smooth' });
    confirmLabel();
  });
  pop.addEventListener('click', (event) => {
    if (event.target.closest('[data-cancel]')) closePicker();
    if (event.target.closest('[data-ok]')) { onPick(selected); closePicker(); }
  });
}

function timePopover(anchor, control, onPicked) {
  const apply = onPicked ?? ((picked) => { control.value = picked; control.dispatchEvent(new Event('change', { bubbles: true })); });
  const parsed = /^(\d{1,2}):(\d{2})/.exec(control.value || '');
  let hour = parsed ? Number(parsed[1]) : 9;
  let minute = parsed ? Number(parsed[2]) : 0;
  const ITEM = 38;
  const pop = openPopover(anchor, `<div class="picker-time">
      <div class="picker-wheel"><div class="picker-wheel-band"></div></div>
      <div class="picker-date-actions"><button type="button" class="picker-option" data-cancel>取消</button><button type="button" class="picker-option primary" data-ok>确定</button></div>
    </div>`);
  const wheel = pop.querySelector('.picker-wheel');
  const buildColumn = (kind, count, current, step = 1) => {
    const label = kind === 'hour' ? '小时' : '分钟';
    let col = `<div class="picker-wheel-col" data-col="${kind}" role="listbox" tabindex="0" aria-label="${label}"><div class="picker-wheel-spacer"></div>`;
    for (let value = 0; value < count; value += step) {
      col += `<div class="picker-wheel-item${value === current ? ' on' : ''}" data-${kind}="${value}" role="option" aria-selected="${value === current ? 'true' : 'false'}">${pad2(value)}</div>`;
    }
    return col + '<div class="picker-wheel-spacer"></div></div>';
  };
  const confirmLabel = () => { const btn = pop.querySelector('[data-ok]'); if (btn) btn.textContent = `确定 ${pad2(hour)}:${pad2(minute)}`; };
  const markItems = () => {
    wheel.querySelectorAll('[data-hour]').forEach((item) => {
      const selected = Number(item.dataset.hour) === hour;
      item.classList.toggle('on', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    wheel.querySelectorAll('[data-minute]').forEach((item) => {
      const selected = Number(item.dataset.minute) === minute;
      item.classList.toggle('on', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    confirmLabel();
  };
  wheel.insertAdjacentHTML('afterbegin', buildColumn('hour', 24, hour));
  wheel.insertAdjacentHTML('beforeend', buildColumn('minute', 60, minute));
  const cols = { hour: wheel.querySelector('[data-col="hour"]'), minute: wheel.querySelector('[data-col="minute"]') };
  const syncFromScroll = () => {
    const hourIndex = Math.min(23, Math.max(0, Math.round(cols.hour.scrollTop / ITEM)));
    const minuteIndex = Math.min(59, Math.max(0, Math.round(cols.minute.scrollTop / ITEM)));
    if (hourIndex !== hour || minuteIndex !== minute) {
      hour = hourIndex;
      minute = minuteIndex;
    }
    markItems();
    confirmLabel();
  };
  cols.hour.scrollTop = hour * ITEM;
  cols.minute.scrollTop = minute * ITEM;
  cols.hour.focus({ preventScroll: true });
  const onScrollEnd = (col) => {
    clearTimeout(col._wheelTimer);
    col._wheelTimer = setTimeout(syncFromScroll, 120);
  };
  Object.entries(cols).forEach(([kind, col]) => {
    col.addEventListener('scroll', () => onScrollEnd(col));
    col.addEventListener('keydown', (event) => {
      const limit = kind === 'hour' ? 23 : 59;
      const current = kind === 'hour' ? hour : minute;
      let next = current;
      if (event.key === 'ArrowDown') next = Math.min(limit, current + 1);
      else if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = limit;
      else return;
      event.preventDefault();
      if (kind === 'hour') hour = next; else minute = next;
      col.scrollTo({ top: next * ITEM, behavior: 'smooth' });
      markItems();
    });
    col.addEventListener('click', (event) => {
      const item = event.target.closest(`[data-${kind}]`);
      if (!item) return;
      const value = Number(item.dataset[kind]);
      col.scrollTo({ top: value * ITEM, behavior: 'smooth' });
      if (kind === 'hour') hour = value; else minute = value;
      markItems();
      confirmLabel();
    });
  });
  pop.addEventListener('click', (event) => {
    if (event.target.closest('[data-cancel]')) closePicker();
    if (event.target.closest('[data-ok]')) {
      apply(`${pad2(hour)}:${pad2(minute)}`);
      closePicker();
    }
  });
}

/** 渲染后调用：把标记了 data-ui="picker" 的原生控件接入自绘面板。 */
export function enhancePickers(root = document) {
  for (const control of root.querySelectorAll('select[data-ui="picker"], input[type="date"][data-ui="picker"], input[type="time"][data-ui="picker"]')) {
    if (control.dataset.uiWrapped === 'true') continue;
    control.dataset.uiWrapped = 'true';
    const host = document.createElement('div');
    host.className = 'picker-host';
    control.parentNode.insertBefore(host, control);
    host.appendChild(control);
    control.classList.add('ui-picker-native');
    host.addEventListener('click', () => {
      if (control.disabled) return;
      if (control.tagName === 'SELECT') optionPicker(control, control);
      else if (control.type === 'date') datePopover(control, control, null);
      else timePopover(control, control);
    });
  }
}
