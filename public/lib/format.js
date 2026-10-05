/**
 * 中文标签与格式化：前端的"人话层"。
 *
 * 主界面使用这里的中文标签；公开地点坐标编号可展示，内部枚举、UUID、版本号只进「设置 → 高级信息」。
 * 这条约束由 tests/product-ui.test.ts 守住——内部值回到界面即失败。
 *
 * 纯函数模块：不碰 DOM、不发请求，可以单独推理。
 */

import { state } from './store.js';

/** 公开地点编号直接使用已保存的坐标 ID；兼容旧 10 位，不用递增收录号或当前坐标重算。 */
export function placeIdLabel(place) {
  const id = place?.placeId;
  return typeof id === 'string' && /^(?:\d{14}|\d{10})$/.test(id) ? id : '';
}

/** 解释编号里的坐标网格；坐标更新不改变已有地点身份，网格不等于最新精确位置。 */
export function placeIdDescription(place) {
  const id = placeIdLabel(place);
  if (!id) return '';
  const digits = id.length === 14 ? 6 : 4;
  const precision = id.length === 14 ? 3 : 1;
  const scale = 10 ** precision;
  const decode = part => {
    const value = Number(part) / scale;
    return (value > 180 ? value - 360 : value).toFixed(precision);
  };
  return `经度网格 ${decode(id.slice(0, digits))}° · 纬度网格 ${decode(id.slice(digits, digits * 2))}° · 网格内序列号 ${id.slice(-2)}`;
}

export function placeIdHtml(place) {
  const id = placeIdLabel(place);
  if (!id) return '';
  const description = placeIdDescription(place);
  return `<span class="place-id" title="${escapeHtml(description)}" aria-label="地点编号 ${id}，${escapeHtml(description)}">${id}</span>`;
}

export const TITLES = {
  achievements: '旅行成就',
  moderation: '地点审核',
  map: '地图与路线', favorites: '我的收藏', community: '旅行帖子', 'post-detail': '帖子详情', 'plan-shares': '方案分享',
  home: '首页', companion: '伴途随行', today: '计划与进度', 'plan-history': '往日记录', plan: '方案候选', agent: '伴途 Agent', places: '地点目录', place: '地点详情', scene: '地点现场', memories: '旅行记忆', mine: '我的', profile: '我的',
};

export const STATUS_LABEL = { planned: '待出发', en_route: '在路上', visiting: '游览中', completed: '已完成', skipped: '已跳过' };

import { CITY_NAME } from './cities.js';
const CITY_LABEL = CITY_NAME;
export const LIFECYCLE_LABEL = { draft: '还没出发', active: '进行中', completed: '已结束', archived: '已归档' };
export const PLANNING_LABEL = { empty: '还没有安排', needs_review: '有改动待核对', validated: '已核对' };
export const PLANNING_CHIP = { empty: 'gray', needs_review: 'amber', validated: 'green' };
export const APPLICABILITY_LABEL = { applicable: '可以直接采用', needs_verification: '需要先核实' };
export const DATA_MODE_LABEL = { demo: '离线样例数据', online: '在线数据' };
const CATEGORY_LABELS = { landmark: '地标', culture: '文化', food: '餐饮', rest: '休息', unknown: '未分类' };
const FACILITY_LABELS = {
  toilet: '洗手间', elevator: '电梯', parking: '停车场', nursing_room: '母婴室', outdoor: '户外', indoor: '室内', walking: '需要步行', accessible: '无障碍',
  rest_area: '可以休息', seat: '有座位', drink: '有饮品', food: '有餐食',
  medical: '医疗点', shopping: '可购物', transit: '近公共交通',
};


export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function fmt(minutes) {
  if (minutes === null || minutes === undefined) return '--:--';
  const hour = Math.floor(minutes / 60) % 24, minute = Math.floor(minutes % 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function fmtWithDay(minutes) {
  if (minutes === null || minutes === undefined) return '--:--';
  const day = Math.floor(minutes / 1440);
  const time = fmt(minutes);
  if (day <= 0) return time;
  return `${day === 1 ? '次日' : `第${day + 1}日`} ${time}`;
}

export const formatTimeRange = (startMinutes, endMinutes) => `${fmtWithDay(startMinutes)} - ${fmtWithDay(endMinutes)}`;

export const cityName = (code) => CITY_LABEL[code] || '未命名目的地';

export const monthDay = (date) => {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return matched ? `${matched[1]}年${Number(matched[2])}月${Number(matched[3])}日` : (date || '日期未定');
};

/** 用指定时区生成 YYYY-MM-DD，避免“今天”随浏览器所在地偏移。 */
export function dateKeyInTimeZone(date = new Date(), timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** 旅行的显示名：用「城市 · 日期」代替 UUID 前缀。 */
export const tripTitle = (trip) => (trip ? `${cityName(trip.cityCode)} · ${monthDay(trip.localDate)}` : '还没有旅行');

export const categoryLabel = (value) => CATEGORY_LABELS[value] || '未分类';
export const facilityLabel = (value) => FACILITY_LABELS[value] || '设施待核实';
export const facilityList = (codes) => (codes || []).map(facilityLabel).join('、') || '未标注';

/** 时间戳显示日期与分钟；进度使用计划时区，其余默认设备时区。 */
export const clockText = (iso, timeZone) => {
  const parsed = Date.parse(String(iso || ''));
  if (Number.isNaN(parsed)) return '';
  const date = new Date(parsed);
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
      const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      return `${Number(values.month)}月${Number(values.day)}日 ${values.hour}:${values.minute}`;
    } catch { return ''; }
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
