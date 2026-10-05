/** Browser display preference; button actions and accessible names stay intact. */
const KEY = 'bantu-compact-mode';
const CLASS = 'compact-mode';
const records = new WeakMap();
let observer = null;
let scheduled = false;

export function compactModeEnabled() {
  return typeof document !== 'undefined' && document.body.classList.contains(CLASS);
}

function prepareButton(button) {
  const icons = [...button.querySelectorAll('svg.ui-icon')];
  const label = button.textContent.replace(/\s+/g, ' ').trim();
  let record = records.get(button);
  if (record?.autoAria && record.lastAria !== undefined && button.getAttribute('aria-label') !== record.lastAria) record.autoAria = false;
  if (!icons.length || !label || button.matches('[data-compact-keep-text], .nickname-display, .picker-option, [role="option"]')) {
    button.classList.remove('compactable-button');
    if (label && record?.autoAria) { button.setAttribute('aria-label', label); record.lastAria = label; }
    if (label && record?.autoTitle) button.setAttribute('title', button.getAttribute('aria-label') || label);
    return;
  }
  if (!record) {
    record = { autoAria: !button.hasAttribute('aria-label'), autoTitle: !button.hasAttribute('title') };
    records.set(button, record);
  }
  if (record.autoAria) { button.setAttribute('aria-label', label); record.lastAria = label; }
  if (record.autoTitle) button.setAttribute('title', button.getAttribute('aria-label') || label);
  button.classList.add('compactable-button');
  const primary = icons[0];
  primary.classList.remove('compact-copy');
  primary.classList.add('compact-main-icon');
  const mark = element => {
    for (const child of [...element.childNodes]) {
      if (child.nodeType === 3 && child.textContent.trim()) {
        const copy = document.createElement('span');
        copy.className = 'compact-copy';
        child.replaceWith(copy);
        copy.append(child);
      } else if (child.nodeType === 1) {
        if (child === primary) continue;
        if (child.contains(primary)) {
          child.classList.remove('compact-copy');
          child.classList.add('compact-icon-holder');
          mark(child);
        } else child.classList.add('compact-copy');
      }
    }
  };
  mark(button);
}

export function syncCompactMode(root = document) {
  if (compactModeEnabled()) {
    if (root.matches?.('button')) prepareButton(root);
    root.querySelectorAll('button').forEach(prepareButton);
  }
  document.querySelectorAll('[data-action="compact-toggle"]').forEach(button => {
    const enabled = compactModeEnabled();
    button.setAttribute('aria-pressed', String(enabled));
    const copy = enabled ? '已开启' : '未开启';
    if (button.textContent !== copy) button.textContent = copy;
  });
}

export function setCompactMode(enabled, { persist = true } = {}) {
  document.body.classList.toggle(CLASS, Boolean(enabled));
  let saved = true;
  if (persist) {
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); }
    catch { saved = false; }
  }
  syncCompactMode();
  return saved;
}

export function restoreCompactMode() {
  let enabled = false;
  try { enabled = localStorage.getItem(KEY) === 'on'; } catch { /* Default remains readable. */ }
  setCompactMode(enabled, { persist: false });
  if (observer) return;
  observer = new MutationObserver(() => {
    if (scheduled || !compactModeEnabled()) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; syncCompactMode(); });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener('bantu:rendered', () => syncCompactMode());
}
