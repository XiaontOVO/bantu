import { clampDockPosition } from './agent-dock-position.js';

// Positions belong to this visit and identity, not to a globally stored account.
let storyMotionKey = '';
let storyPosition = null;
const storyVisitPositions = new Map();
let storyDrag = null;
let storyMotionBound = false;
let storySuppressClickUntil = 0;

function storyViewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const bounds = { left:left + 10, top:top + 10,
    right:left + (viewport?.width || innerWidth) - 10,
    bottom:top + (viewport?.height || innerHeight) - 10 };
  const header = document.querySelector('.scene-header');
  if (header?.getClientRects().length) bounds.top = Math.max(bounds.top, header.getBoundingClientRect().bottom + 8);
  return bounds;
}

function positionStoryWindow(point) {
  const story = document.querySelector('.scene-floating-story');
  if (!story || !point) return;
  // Measure the responsive default before detaching; reserve its portrait space.
  story.classList.remove('is-detached');
  for (const property of ['left','top','right','bottom','width','max-height']) story.style.removeProperty(property);
  const rect = story.getBoundingClientRect();
  const anchor = story.closest('.scene-story-anchor');
  if (anchor) anchor.style.height = getComputedStyle(story).position === 'relative' ? `${rect.height}px` : '';
  const bounds = storyViewportBounds();
  story.classList.add('is-detached');
  story.style.width = `${Math.min(rect.width, Math.max(0, bounds.right - bounds.left))}px`;
  story.style.maxHeight = `${Math.max(44, bounds.bottom - bounds.top)}px`;
  const placed = clampDockPosition(point, bounds, story.getBoundingClientRect());
  story.style.left = `${placed.x}px`; story.style.top = `${placed.y}px`;
  story.style.right = 'auto'; story.style.bottom = 'auto';
  storyPosition = placed;
  window.dispatchEvent(new Event('bantu:scene-story-moved'));
}

function finishStoryDrag(event) {
  if (!storyDrag || event && event.pointerId !== storyDrag.id) return;
  const finished = storyDrag;
  storyDrag = null;
  if (finished.moved) storySuppressClickUntil = performance.now() + 500;
  finished.element.classList.remove('is-dragging');
  if (finished.element.hasPointerCapture(finished.id)) finished.element.releasePointerCapture(finished.id);
}

export function mountSceneStoryMotion(key) {
  if (key !== storyMotionKey) {
    finishStoryDrag();
    if (storyMotionKey && storyPosition) {
      storyVisitPositions.set(storyMotionKey, storyPosition);
      if (storyVisitPositions.size > 12) storyVisitPositions.delete(storyVisitPositions.keys().next().value);
    }
    storyMotionKey = key; storyPosition = storyVisitPositions.get(key) || null;
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!key) return;
  if (storyPosition) positionStoryWindow(storyPosition);
  if (storyMotionBound) return;
  storyMotionBound = true;
  document.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const handle = event.target.closest('[data-scene-story-drag]');
    const story = handle?.closest('.scene-floating-story');
    if (!story || story.closest('[inert]') || event.target.closest('button,a,input,textarea,select')) return;
    const rect = story.getBoundingClientRect();
    storyDrag = {id:event.pointerId, element:story, startX:event.clientX, startY:event.clientY,
      x:rect.left, y:rect.top, moved:false};
    story.setPointerCapture(event.pointerId);
  });
  document.addEventListener('pointermove', event => {
    if (!storyDrag || storyDrag.id !== event.pointerId) return;
    const dx = event.clientX - storyDrag.startX, dy = event.clientY - storyDrag.startY;
    if (!storyDrag.moved && Math.hypot(dx,dy) < 6) return;
    storyDrag.moved = true;
    event.preventDefault();
    positionStoryWindow({x:storyDrag.x + dx, y:storyDrag.y + dy});
    storyDrag.element.classList.add('is-dragging');
  }, {passive:false});
  document.addEventListener('pointerup', finishStoryDrag);
  document.addEventListener('pointercancel', finishStoryDrag);
  window.addEventListener('blur', () => finishStoryDrag());
  document.addEventListener('click', event => {
    if (performance.now() < storySuppressClickUntil && event.target.closest('[data-scene-story-drag]')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (!event.target.matches('[data-scene-story-drag]') || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const rect = event.target.closest('.scene-floating-story').getBoundingClientRect(), step = event.shiftKey ? 40 : 16;
    positionStoryWindow({x:rect.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      y:rect.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0)});
  });
  const reposition = () => { if (storyPosition) positionStoryWindow(storyPosition); };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, {passive:true});
  window.visualViewport?.addEventListener('resize', reposition);
  window.visualViewport?.addEventListener('scroll', reposition);
}
