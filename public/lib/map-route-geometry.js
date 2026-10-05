import { baseMapPoint, validMapPoint } from './map-coordinates.js';

/** Missing road geometry must never be replaced by a line between endpoints. */
export function roadRoutePath(result) {
  const leg = result?.leg;
  if (result?.error || !leg || (result.departureSupport || leg.departureSupport) === 'demo' ||
      !['WGS84', 'GCJ02'].includes(leg.geometryCrs) || !Array.isArray(leg.geometry) ||
      leg.geometry.length < 2 || !leg.geometry.every(validMapPoint)) return null;
  return leg.geometry.map(point => baseMapPoint(point, leg.geometryCrs));
}
