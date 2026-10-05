/**
 * 地点 ID 统一格式：14 位十进制 = 经度 6 位 + 纬度 6 位 + 格子内序列号 2 位。
 *
 * 经度/纬度均按模 360 归一化后，以 0.001° 网格编码（×1000 后四舍五入）。
 * 各占 6 位；负坐标解码时减 360，末尾 00–99 区分同网格地点。
 */

const lngPart = (lng: number): string => {
  const normalized = ((lng % 360) + 360) % 360;
  return String(Math.min(359999, Math.round(normalized * 1000))).padStart(6, '0');
};

const latPart = (lat: number): string => {
  const normalized = ((lat % 360) + 360) % 360;
  return String(Math.min(359999, Math.round(normalized * 1000))).padStart(6, '0');
};

export const placeCellKey = (lng: number, lat: number): string => `${lngPart(lng)}${latPart(lat)}`;

/** 由坐标与格子内序列号生成 14 位十进制地点 ID；同一格最多支持 100 个地点。 */
export function coordinatePlaceId(lng: number, lat: number, serial: number): string {
  if (!Number.isInteger(serial) || serial < 0 || serial > 99) {
    throw new RangeError('同一坐标网格内的地点编号已用尽。');
  }
  return `${placeCellKey(lng, lat)}${String(serial).padStart(2, '0')}`;
}

/** 是否符合 14 位十进制地点 ID 格式。 */
export const isCoordinatePlaceId = (placeId: string): boolean => /^\d{14}$/.test(placeId);
