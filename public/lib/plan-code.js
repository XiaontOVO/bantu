/**
 * 方案码：把一套行程方案序列化成自包含、可离线导入的短码。
 *
 * 格式：`BT1-<分段 base64>-<校验位>`；payload 为 JSON（UTF-8）。
 * 正文用标准 base64（含 + /），分段分隔符用 -，两者字母表不相交，解码无歧义。
 * 校验位为 body 字符码之和对 36^2 取模的两位 base36 大写。
 * v1＝单日计划（顶层 stops）；v2＝多天方案（days，每天一份 stops）。
 * 编解码为纯函数，浏览器与 Node 测试通用。
 */

import { newClientId } from './client-id.js';

const PREFIX = 'BT1';
const MAX_PLAN_DAYS = 31;
const MAX_PLAN_STOPS = 200;
const MAX_PLAN_CODE_LENGTH = 60_000;

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/=+$/, '');
}

function fromBase64(text) {
  let normalized = text;
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function checksum(body) {
  let sum = 0;
  for (const char of body) sum += char.charCodeAt(0);
  return (sum % 1296).toString(36).toUpperCase().padStart(2, '0');
}

function chunk(text, size) {
  const groups = [];
  for (let i = 0; i < text.length; i += size) groups.push(text.slice(i, i + size));
  return groups;
}

const encodeStops = (stops) => (stops || []).map(stop => {
  const durationMinutes = Number(stop.durationMinutes || 60);
  if (!Number.isFinite(durationMinutes)) throw new Error('地点游览时长无效，请调整后再分享。');
  if (durationMinutes > 1440) throw new Error('单个地点的游览时长不能超过 24 小时，请调整后再分享。');
  return {
    n: stop.name,
    ...(typeof stop.placeId === 'string' && stop.placeId.trim() ? { p: stop.placeId.trim().slice(0, 120) } : {}),
    la: Math.round(stop.coordinates.lat * 1e5) / 1e5,
    ln: Math.round(stop.coordinates.lng * 1e5) / 1e5,
    crs: stop.coordinates.source === 'amap' ? 'GCJ02' : 'WGS84',
    ...( /^\d{6}$/.test(String(stop.cityCode || '')) && stop.cityCode !== '000000' ? { cc: String(stop.cityCode) } : {}),
    m: Math.max(15, Math.round(durationMinutes)),
    ...(Number.isInteger(stop.startMinutes) ? { a: stop.startMinutes } : {}),
  };
});

/** plan: { name, cityCode, cityLabel, localDate?, totalFeeMinor?, stops? } 或 { days: [{ stops }] }（多天方案） */
import { cityNameOf } from './cities.js';

export function encodePlanCode(plan) {
  const sourceDays = Array.isArray(plan.days) ? plan.days : [];
  if (sourceDays.length > MAX_PLAN_DAYS) throw new Error(`方案最多分享 ${MAX_PLAN_DAYS} 天。`);
  const sourceStopCount = sourceDays.reduce((sum, day) => sum + (Array.isArray(day.stops) ? day.stops.length : 0), 0);
  if (sourceStopCount > MAX_PLAN_STOPS || (Array.isArray(plan.stops) && plan.stops.length > MAX_PLAN_STOPS)) {
    throw new Error(`方案最多分享 ${MAX_PLAN_STOPS} 个地点。`);
  }
  const hasDatedStops = sourceDays.some(day => Array.isArray(day.stops) && day.stops.length > 0);
  const days = hasDatedStops ? sourceDays.map(day => ({ s: encodeStops(day.stops) })) : [];
  let payload;
  if (days.length) {
    payload = { v: 3, n: plan.name, c: plan.cityCode, cn: plan.cityLabel || '', ...(plan.localDate ? { d: plan.localDate } : {}), days };
  } else {
    const stops = encodeStops(plan.stops);
    if (!stops.length) throw new Error('方案里还没有地点，先添加地点再分享。');
    payload = { v: 3, n: plan.name, c: plan.cityCode, cn: plan.cityLabel || '', d: plan.localDate, f: Math.round(plan.totalFeeMinor || 0), s: stops };
  }
  const body = toBase64(JSON.stringify(payload));
  const code = [PREFIX, ...chunk(body, 8), checksum(body)].join('-');
  if (code.length > MAX_PLAN_CODE_LENGTH) throw new Error('方案内容过长，请减少地点后再分享。');
  return code;
}

/** 每次导入都分配独立命名空间，避免不同方案中相同序号的地点共用 stopId/placeId。 */
export function createImportedStopIdFactory() {
  const namespace = newClientId();
  return (index, dayIndex) => {
    const suffix = dayIndex === undefined ? String(index) : `${dayIndex}_${index}`;
    return {
      stopId: `imported_${namespace}_${suffix}`,
      placeId: `shared_${namespace}_${suffix}`,
    };
  };
}

const decodeStopList = (list) => {
  if (!Array.isArray(list)) throw new Error('方案码中的地点信息不完整，无法导入。');
  return list.map(stop => {
    if (typeof stop.n !== 'string' || !stop.n.trim() || !Number.isFinite(stop.la) || !Number.isFinite(stop.ln) ||
      (stop.cc !== undefined && (typeof stop.cc !== 'string' || !/^\d{6}$/.test(stop.cc))) ||
      (stop.a !== undefined && (!Number.isInteger(stop.a) || stop.a < 0 || stop.a > 2879)) ||
      stop.la < -90 || stop.la > 90 || stop.ln < -180 || stop.ln > 180) {
      throw new Error('方案码中的地点信息不完整，无法导入。');
    }
    return {
      ...(typeof stop.p === 'string' && stop.p.trim() && stop.p.length <= 120 ? { placeId: stop.p.trim() } : {}),
      name: stop.n,
      coordinates: { lat: stop.la, lng: stop.ln, source: stop.crs === 'GCJ02' ? 'amap' : 'demo' },
      ...(typeof stop.cc === 'string' && /^\d{6}$/.test(stop.cc) && stop.cc !== '000000' ? { cityCode: stop.cc } : {}),
      durationMinutes: stop.m || 60,
      ...(stop.a !== undefined ? { startMinutes: stop.a } : {}),
    };
  });
};

function decodeLocalDate(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new Error('方案码中的出行日期无效。');
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error('方案码中的出行日期无效。');
  }
  return value;
}

/** 解析并校验方案码；任何一步失败都抛出中文错误，绝不返回半成品。 */
export function decodePlanCode(code) {
  // 容忍粘贴变体：丢失/多出连字符、大小写、首尾空白都能解码；防篡改交给校验位。
  const rawCode = String(code || '');
  if (rawCode.length > MAX_PLAN_CODE_LENGTH) throw new Error('方案码过长，无法导入。');
  const joined = rawCode.split(/\s+|-/).filter(Boolean).join('');
  if (joined.slice(0, 3).toUpperCase() !== PREFIX) throw new Error('这不是伴途方案码，应以 BT1- 开头。');
  if (joined.length < PREFIX.length + 2) throw new Error('方案码不完整，请检查是否复制完整。');
  const body = joined.slice(PREFIX.length, -2);
  const check = joined.slice(-2);
  if (checksum(body) !== check) throw new Error('方案码校验失败，可能有字符输错，请重新粘贴。');
  let payload;
  try { payload = JSON.parse(fromBase64(body)); } catch { throw new Error('方案码内容无法解析，请确认来源。'); }
  if (payload.v !== 1 && payload.v !== 2 && payload.v !== 3) throw new Error('方案码版本过新或已损坏，请升级伴途后再试。');
  const common = {
    name: typeof payload.n === 'string' && payload.n ? payload.n : '导入的方案',
    cityCode: /^\d{6}$/.test(String(payload.c)) ? payload.c : '000000',
    cityLabel: typeof payload.cn === 'string' ? payload.cn : '',
  };
  const localDate = decodeLocalDate(payload.d);
  if (payload.v === 2 || (payload.v === 3 && Array.isArray(payload.days))) {
    if (!Array.isArray(payload.days) || !payload.days.length) throw new Error('方案码里没有天计划，无法导入。');
    if (payload.days.length > MAX_PLAN_DAYS) throw new Error(`方案码最多支持 ${MAX_PLAN_DAYS} 天。`);
    const days = payload.days.map(day => ({ stops: decodeStopList(day.s) }));
    if (days.reduce((sum, day) => sum + day.stops.length, 0) > MAX_PLAN_STOPS) throw new Error(`方案码最多支持 ${MAX_PLAN_STOPS} 个地点。`);
    if (!days.some(day => day.stops.length)) throw new Error('方案码里没有地点，无法导入。');
    return deriveShareCity({ ...common, ...(localDate ? { localDate } : {}), days });
  }
  if (!Array.isArray(payload.s) || !payload.s.length) throw new Error('方案码里没有地点，无法导入。');
  if (payload.s.length > MAX_PLAN_STOPS) throw new Error(`方案码最多支持 ${MAX_PLAN_STOPS} 个地点。`);
  return deriveShareCity({
    ...common,
    localDate,
    totalFeeMinor: Number(payload.f) || 0,
    stops: decodeStopList(payload.s),
  });
}

function deriveShareCity(plan) {
  const stops = plan.days ? plan.days.flatMap(day => day.stops || []) : (plan.stops || []);
  const codes = [...new Set(stops.map(stop => stop.cityCode).filter(code => /^\d{6}$/.test(String(code || ''))))];
  if (codes.length === 1) {
    const cityCode = codes[0];
    return { ...plan, cityCode, cityLabel: cityCode === plan.cityCode ? plan.cityLabel : (cityNameOf(cityCode) || '城市待核实') };
  }
  if (codes.length > 1) return { ...plan, cityCode: codes[0], cityLabel: '多地' };
  return plan;
}
