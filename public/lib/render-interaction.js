/** Keep a pressed control connected until its native click can be dispatched. */
let renderInteractionDocument;
let renderPressedPointers = new Set();
let renderAfterPress = null;

export function deferRenderDuringPress(callback) {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return false;
  if (renderInteractionDocument !== document) {
    renderInteractionDocument = document;
    renderPressedPointers = new Set();
    renderAfterPress = null;
    const owner = document;
    const flushAfterPress = () => {
      if (owner !== renderInteractionDocument || renderPressedPointers.size || !renderAfterPress) return;
      const flush = () => {
        if (owner !== renderInteractionDocument || renderPressedPointers.size) return;
        const work = renderAfterPress;
        renderAfterPress = null;
        work?.();
      };
      // pointerup precedes click/submit; leave the control in place through both.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else queueMicrotask(flush);
    };
    document.addEventListener('pointerdown', event => {
      if (owner === renderInteractionDocument && (event.button === 0 || event.pointerType === 'touch')) renderPressedPointers.add(event.pointerId);
    }, true);
    const release = event => {
      if (owner !== renderInteractionDocument) return;
      renderPressedPointers.delete(event.pointerId);
      flushAfterPress();
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('blur', () => {
      if (owner !== renderInteractionDocument) return;
      renderPressedPointers.clear();
      flushAfterPress();
    });
  }
  if (!renderPressedPointers.size) return false;
  renderAfterPress = callback;
  return true;
}
