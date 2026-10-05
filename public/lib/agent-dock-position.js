/** Keep the movable widget inside the usable viewport; stored data is optional. */
export function clampDockPosition(position, bounds, size) {
  const maxX = Math.max(bounds.left, bounds.right - size.width);
  const maxY = Math.max(bounds.top, bounds.bottom - size.height);
  return {
    x: Math.min(maxX, Math.max(bounds.left, Number.isFinite(position?.x) ? position.x : maxX)),
    y: Math.min(maxY, Math.max(bounds.top, Number.isFinite(position?.y) ? position.y : maxY)),
  };
}

/** Prefer the nearest free position when a scene caption occupies the corner. */
export function avoidDockOverlaps(position, bounds, size, obstacles) {
  const overlaps = (point, rect) => point.x < rect.right + 8 && point.x + size.width > rect.left - 8 &&
    point.y < rect.bottom + 8 && point.y + size.height > rect.top - 8;
  if (!obstacles.some(rect => overlaps(position, rect))) return position;
  const candidates = obstacles.flatMap(rect => [
    {x:rect.left - size.width - 8,y:position.y},
    {x:rect.right + 8,y:position.y},
    {x:position.x,y:rect.top - size.height - 8},
    {x:position.x,y:rect.bottom + 8},
  ]).map(point => clampDockPosition(point,bounds,size));
  return candidates.filter(point => !obstacles.some(rect => overlaps(point,rect)))
    .sort((a,b) => Math.hypot(a.x-position.x,a.y-position.y)-Math.hypot(b.x-position.x,b.y-position.y))[0] || position;
}

export function validDockPositions(value) {
  const positions = {};
  for (const key of ['launcher', 'panel']) {
    const dockSavedPoint = value?.[key];
    if (Number.isFinite(dockSavedPoint?.x) && Number.isFinite(dockSavedPoint?.y)) positions[key] = { x:dockSavedPoint.x, y:dockSavedPoint.y };
  }
  return positions;
}
