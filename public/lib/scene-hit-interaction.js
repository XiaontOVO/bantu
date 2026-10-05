import { selectSceneHotspot } from './place-scene.js';
import { dismissSceneStory } from './scene-presentation.js';
/** Touch target adjustment can choose a neighbouring clipped button. Use the
 * actual artwork point, and leave pan/cancel gestures and keyboard clicks alone. */
export function bindSceneHitInteraction() {
  let pressed = null, ignoreClickUntil = 0;
  document.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const element = document.elementFromPoint(event.clientX,event.clientY)?.closest('.scene-hotspot');
    if (!element || element.disabled) return;
    pressed = {pointerId:event.pointerId,id:element.dataset.hotspot,x:event.clientX,y:event.clientY};
    event.preventDefault();
  }, {capture:true,passive:false});
  document.addEventListener('pointercancel', event => { if (pressed?.pointerId === event.pointerId) pressed = null; }, true);
  document.addEventListener('pointerup', event => {
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    const touch = pressed; pressed = null;
    if (Math.hypot(event.clientX-touch.x,event.clientY-touch.y)>10) return;
    const element = document.elementFromPoint(event.clientX,event.clientY)?.closest('.scene-hotspot');
    if (element?.dataset.hotspot !== touch.id || element.disabled) return;
    ignoreClickUntil = performance.now()+600;
    event.preventDefault();
    selectSceneHotspot(touch.id);
  }, {capture:true,passive:false});
  document.addEventListener('click', event => {
    if (event.detail && performance.now()<ignoreClickUntil && event.target.closest('.scene-hotspot')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
    if (matchMedia('(max-width:980px) and (orientation:landscape)').matches &&
        event.target.closest('.scene-canvas-shell') &&
        !event.target.closest('.scene-floating-story,button') && document.querySelector('.scene-floating-story')) {
      dismissSceneStory();
    }
  }, true);
}
