import { clampDockPosition, validDockPositions, avoidDockOverlaps } from './agent-dock-position.js';

const KEY = 'bantu-agent-dock-positions';
let positions = {};
let loaded = false;
let drag = null;
let suppressUntil = 0;
let boundHost = null;

function dockMotionMode(host) { return host.classList.contains('is-open') ? 'panel' : 'launcher'; }
function bounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const box = { left:left + 10, top:top + 10, right:left + (viewport?.width || innerWidth) - 10,
    bottom:top + (viewport?.height || innerHeight) - 10 };
  const appbar = document.querySelector('.appbar');
  const header = appbar?.getClientRects().length ? appbar : document.querySelector('.scene-header');
  if (header?.getClientRects().length) box.top = Math.max(box.top, header.getBoundingClientRect().bottom + 8);
  for (const selector of ['.bottom-nav', '.place-detail-actions']) {
    const control = document.querySelector(selector);
    if (!control?.getClientRects().length || getComputedStyle(control).position !== 'fixed') continue;
    const rect = control.getBoundingClientRect();
    if (rect.top > box.top && rect.top < box.bottom) box.bottom = rect.top - 8;
  }
  return box;
}
function remember() {
  try { localStorage.setItem(KEY, JSON.stringify(positions)); } catch { /* Movement still works. */ }
}
export function positionAgentDock(host = boundHost) {
  if (!host || host.hidden || !host.getClientRects().length) return;
  if (!loaded) {
    loaded = true;
    try { positions = validDockPositions(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { }
  }
  const box = bounds();
  host.classList.toggle('is-short', box.bottom - box.top < 240);
  host.style.setProperty('--agent-available-height', `${Math.max(120, box.bottom - box.top)}px`);
  const rect = host.getBoundingClientRect();
  const initial = clampDockPosition(drag?.point || positions[dockMotionMode(host)], box, rect);
  const obstacles = [...document.querySelectorAll('.scene-floating-story,.scene-cues,.scene-text-topics,.scene-artwork-recovery,.scene-artwork-copy')]
    .filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect()).filter(r=>r.width && r.height);
  const point = avoidDockOverlaps(initial,box,rect,obstacles);
  host.style.left = `${point.x}px`; host.style.top = `${point.y}px`;
  host.style.right = 'auto'; host.style.bottom = 'auto';
}
export function bindAgentDockMotion(host) {
  if (boundHost === host) return;
  boundHost = host;
  host.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const handle = event.target.closest('[data-agent-drag-handle]');
    if (!handle || handle !== event.target.closest('button,input,textarea,a,select,[data-agent-drag-handle]')) return;
    const rect = host.getBoundingClientRect();
    drag = { id:event.pointerId, startX:event.clientX, startY:event.clientY, x:rect.left, y:rect.top, moved:false, mode:dockMotionMode(host) };
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) { drag.moved = true; host.setPointerCapture(event.pointerId); }
    event.preventDefault();
    drag.point = clampDockPosition({ x:drag.x + dx, y:drag.y + dy }, bounds(), host.getBoundingClientRect());
    positionAgentDock(host);
  }, { passive:false });
  const finish = event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moved) {
      positions[drag.mode] = drag.point;
      remember(); suppressUntil = performance.now() + 500;
    }
    drag = null;
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  host.addEventListener('click', event => {
    if (performance.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  host.addEventListener('keydown', event => {
    if (!event.target.matches('[data-agent-drag-handle]') || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const rect = host.getBoundingClientRect(), step = event.shiftKey ? 40 : 16;
    positions[dockMotionMode(host)] = clampDockPosition({ x:rect.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      y:rect.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }, bounds(), rect);
    remember(); positionAgentDock(host);
  });
  window.addEventListener('resize', () => positionAgentDock());
  window.addEventListener('bantu:scene-story-moved', () => positionAgentDock());
  window.addEventListener('bantu:scene-artwork-layout', () => positionAgentDock());
  window.addEventListener('scroll', () => { if (!drag) positionAgentDock(); }, { passive:true });
  window.visualViewport?.addEventListener('resize', () => positionAgentDock());
  window.visualViewport?.addEventListener('scroll', () => positionAgentDock());
}
