/** GPS/catalog coordinates are WGS84; AMap tiles and AMap geometry are GCJ02. */
export function validMapPoint(point) {
  return Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90 &&
    Number.isFinite(point?.lng) && Math.abs(point.lng) <= 180;
}

export function mapCoordinateCrs(point, crs) {
  return crs || point?.coordinateCrs || point?.crs || (point?.source === 'amap' ? 'GCJ02' : 'WGS84');
}

export function baseMapPoint(point, crs) {
  if (!validMapPoint(point)) throw new Error('位置坐标无效。');
  const system = mapCoordinateCrs(point, crs);
  if (!['WGS84', 'GCJ02'].includes(system)) throw new Error('位置坐标系尚未确认。');
  const pair = [point.lng, point.lat];
  const converted = system === 'GCJ02' ? pair : window.gcoord.transform(pair, window.gcoord.WGS84, window.gcoord.GCJ02);
  return [converted[1], converted[0]];
}

export function mapDistanceMeters(a, b) {
  if (!validMapPoint(a) || !validMapPoint(b)) return Infinity;
  const radians = n => n * Math.PI / 180;
  const h = Math.sin(radians(b.lat - a.lat) / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lng - a.lng) / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
