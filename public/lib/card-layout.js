/** Pack variable-height content cards without changing their DOM or tab order. */
let observer;
let frame;

export function mountCardLayout(root) {
  observer?.disconnect();
  if (frame) cancelAnimationFrame(frame);
  frame = null;
  if (typeof ResizeObserver === 'undefined' || !root?.querySelectorAll) return;

  const grids = [...root.querySelectorAll('.content-card-grid, .scheme-card-grid, .history-grid, .place-review-grid')];
  if (!grids.length) return;
  const layout = () => {
    frame = null;
    for (const grid of grids) {
      if (!grid.isConnected) continue;
      const cards = [...grid.children];
      // Empty states and an open planner remain ordinary full-width sections.
      const pack = cards.length > 1 && cards.every(card => card.matches('.memory-card, .candidate, .history-day, .review-item')) &&
        getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length > 1;
      grid.classList.toggle('has-compact-cards', pack);
      for (const card of cards) {
        const span = pack ? `span ${Math.ceil(card.getBoundingClientRect().height + 14)}` : '';
        if (card.style.gridRowEnd !== span) card.style.gridRowEnd = span;
      }
    }
  };
  observer = new ResizeObserver(() => {
    if (!frame) frame = requestAnimationFrame(layout);
  });
  for (const grid of grids) {
    observer.observe(grid, { box: 'border-box' });
    for (const card of grid.children) observer.observe(card, { box: 'border-box' });
  }
  layout();
}
