// North-up local projection. Geographic facts are retained; drawing style is authored locally.
export function projectionFor(center, bounds) {
  const cosine = Math.cos(center.lat * Math.PI / 180);
  const meters = ([lng, lat]) => [(lng - center.lng) * 111320 * cosine, (center.lat - lat) * 111320];
  const corners = bounds.map(meters);
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min(552 / (maxX - minX), 372 / (maxY - minY));
  const project = point => { const [x, y] = meters(point); return [300 + (x - (minX + maxX) / 2) * scale, 210 + (y - (minY + maxY) / 2) * scale]; };
  return { project, metersPerPixel: 1 / scale, cosine };
}

export function containsPoint(rings, point) {
  const inside = ring => {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, y] = ring[i], [px, py] = ring[j];
      if ((y > point[1]) !== (py > point[1]) && point[0] < (px - x) * (point[1] - y) / (py - y) + x) result = !result;
    }
    return result;
  };
  return rings.reduce((result, ring) => result !== inside(ring), false);
}

export function geometryPath(rings, project, closed = true) {
  return rings.map(ring => ring.map((p, i) => `${i ? 'L' : 'M'}${project(p).map(v => Number(v.toFixed(2))).join(' ')}`).join('') + (closed ? 'Z' : '')).join('');
}

export function geometryCenter(rings, project) {
  const points = rings[0].slice(0, -1).map(project);
  return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
}

const textWidth = (text, size) => [...text].reduce((n, c) => n + (/[^\u0000-\u007f]/.test(c) ? size : size * .62), 0);
export function placeLabels(candidates, markers = []) {
  const occupied = [{ x: 561, y: 54, w: 46, h: 80 }, { x: 100, y: 394, w: 164, h: 32 }, ...markers.map(([x,y])=>({x,y,w:26,h:26}))];
  const labels = [];
  for (const candidate of candidates) {
    const size = candidate.kind === 'road' ? 11 : 12;
    const text = candidate.text.length > 17 ? `${candidate.text.slice(0, 16)}…` : candidate.text;
    const w = textWidth(text, size) + 10, h = size + 10;
    const [originalX, originalY] = candidate.anchor;
    const options = [[0, 0], [0, -22], [0, 22], [-30, -28], [30, 28], [-30, 28], [30, -28]];
    for (let radius = 45; radius <= 180; radius += 22) for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,1],[-1,1],[1,-1]]) options.push([dx * radius, dy * radius]);
    for (const [dx, dy] of options) {
      const x = Math.max(14 + w / 2, Math.min(586 - w / 2, originalX + dx));
      const y = Math.max(14 + h / 2, Math.min(406 - h / 2, originalY + dy));
      if (occupied.some(b => Math.abs(x - b.x) < (w + b.w) / 2 && Math.abs(y - b.y) < (h + b.h) / 2)) continue;
      occupied.push({ x, y, w, h });
      labels.push({ text, fullText: candidate.text, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), kind: candidate.kind, fontSize: size,
        ...(['building','landmark'].includes(candidate.kind) && Math.hypot(x-originalX,y-originalY)>18 ? { leader: [candidate.anchor.map(v=>Number(v.toFixed(2))), [Number(x.toFixed(2)), Number((y + (y < originalY ? 7 : -7)).toFixed(2))]] } : {}) });
      break;
    }
  }
  return labels;
}
