import { randomUUID } from 'node:crypto';
import type { ExecutionEvent, PlanStop, PlaceRef } from '../domain/types.js';
import type { PlaceProvider, RouteProvider } from '../providers/travel.js';
import type { FavoritesService } from './favorites-service.js';
import type { PlanLibraryService, SavedPlan } from './plan-library.js';
import type { PersonalMemoriesService } from './personal-memories-service.js';
import type { CommunityService } from './community-service.js';

/**
 * 无旅行实例的 Agent 命令层。
 *
 * 这里故意使用一组可解释的中文意图，而不是让模型“猜测”是否已经完成了
 * 写操作。模型可以负责闲聊和建议，计划/方案/进度等持久化动作必须经过这个
 * 确定性入口，才能保证一句话真的会改变数据，并且可以安全重放。
 */
export interface StandaloneAgentResult {
  handled: boolean;
  reply: string;
  refresh?: Array<'plans' | 'favorites' | 'memories' | 'community'>;
  date?: string;
  destructive?: boolean;
}

const TIMEZONE = 'Asia/Shanghai';
const CITY_CODE = '310100';
const DISTRICT_CODE = '310104';
const DEFAULT_START = 9 * 60;
const DEFAULT_DURATION = 60;
const DEFAULT_TRAVEL_BUFFER = 20;

function dateKey(value: Date, timezone = TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const get = (type: string) => parts.find(item => item.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function cleanText(text: string): string {
  return text.replace(/[“”"「」『』]/g, '').replace(/[。！!？?；;]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseInteger(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.startsWith('十')) {
    const tail = digits[value.slice(1)];
    return tail === undefined ? null : 10 + tail;
  }
  const ten = value.indexOf('十');
  if (ten > 0 && ten < value.length) {
    const head = digits[value.slice(0, ten)];
    const tail = value.slice(ten + 1) ? digits[value.slice(ten + 1)] : 0;
    return head === undefined || tail === undefined ? null : head * 10 + tail;
  }
  return value.length === 1 ? (digits[value] ?? null) : null;
}

function parseDate(text: string, now: string): string | null {
  const today = dateKey(new Date(now));
  const explicit = text.match(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})[日号]?/);
  if (explicit) {
    const result = `${explicit[1]}-${String(Number(explicit[2])).padStart(2, '0')}-${String(Number(explicit[3])).padStart(2, '0')}`;
    return validDate(result) ? result : null;
  }
  const monthDay = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (monthDay) {
    const year = Number(today.slice(0, 4));
    let result = `${year}-${String(Number(monthDay[1])).padStart(2, '0')}-${String(Number(monthDay[2])).padStart(2, '0')}`;
    if (validDate(result) && result < today) result = `${year + 1}-${result.slice(5)}`;
    return validDate(result) ? result : null;
  }
  if (/后天/.test(text)) return addDays(today, 2);
  if (/明天|明日/.test(text)) return addDays(today, 1);
  if (/今天|今日|当天|本日/.test(text)) return today;
  if (/下周末/.test(text)) {
    const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    return addDays(today, 7 - (weekday + 6) % 7 + 5);
  }
  if (/本周末|这周末|周末/.test(text)) {
    const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    const daysUntilSaturday = (6 - weekday + 7) % 7;
    // 周六说“周末”就是今天；周日则指下一个周六。旧逻辑把周六
    // 无条件推到下周，用户会看到计划日期凭空错开七天。
    return addDays(today, daysUntilSaturday);
  }
  const nextWeekday = text.match(/下周([一二三四五六日天])/);
  if (nextWeekday) {
    const target = ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 } as Record<string, number>)[nextWeekday[1]];
    const current = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    return addDays(today, 7 - (current + 6) % 7 + (target + 6) % 7);
  }
  const weekday = text.match(/(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const target = ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 } as Record<string, number>)[weekday[1]];
    const current = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    const offset = (target - current + 7) % 7;
    return addDays(today, offset);
  }
  return null;
}

function parseTime(text: string): number | null {
  const hourToken = '(?:\\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})';
  const colon = text.match(new RegExp(`(?:下午|晚上|上午|早上|中午)?\\s*(${hourToken})[:：](\\d{2})`));
  const hourMinute = text.match(new RegExp(`(下午|晚上|上午|早上|中午)?\\s*(${hourToken})\\s*点(?:\\s*(半|一刻|三刻|${hourToken})\\s*分?)?`));
  if (!colon && !hourMinute) return null;
  const period = colon ? colon[0] : hourMinute![1] || '';
  let hour = parseInteger(colon ? colon[1] : hourMinute![2]);
  const minuteText = hourMinute?.[3];
  const minute = Number(colon ? colon[2] : minuteText === '半' ? 30 : minuteText === '一刻' ? 15 : minuteText === '三刻' ? 45 : minuteText ? parseInteger(minuteText) : 0);
  if (hour === null) return null;
  if (period && /下午|晚上/.test(period) && hour < 12) hour += 12;
  if (period && /中午/.test(period) && hour < 11) hour += 12;
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null;
}

/** 返回用户明确说出的停留时长；没有说时长时交给地点资料决定。 */
function parseRequestedDuration(text: string): number | null {
  const hour = text.match(/(\d+(?:\.\d+)?|[零〇一二两俩三四五六七八九十]{1,3})\s*个?\s*(半)?\s*小时/);
  const minute = text.match(/(\d+|[零〇一二两俩三四五六七八九十]{1,3})\s*分钟?/);
  if (hour) {
    const value = hour[1].includes('.') ? Number(hour[1]) : parseInteger(hour[1]);
    const extra = minute ? parseInteger(minute[1]) || 0 : 0;
    if (value !== null && value !== undefined) return Math.max(15, Math.round((value + (hour[2] ? .5 : 0)) * 60) + extra);
  }
  if (/半小时/.test(text)) return 30;
  if (minute) {
    const value = parseInteger(minute[1]);
    if (value !== null) return Math.max(15, value);
  }
  return null;
}

function parseDayCount(text: string): number {
  const numeric = text.match(/(\d+)\s*天/);
  if (numeric) return Number(numeric[1]);
  const chinese = text.match(/([一二三四五六七八九十两俩])\s*天/);
  const values: Record<string, number> = { 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return chinese ? (values[chinese[1]] || 1) : 1;
}

function parseDayNumber(value: string): number | null {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  const values: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  return values[value] || null;
}

/**
 * 将用户口语里的“半日游 / 适合老人 / 不太累”归一化为可执行的规划意图。
 * 这些词不能继续落入目录搜索，否则 Agent 会把整句话当成地点名称，最后只
 * 返回示例用法。轻松偏好只限制宽泛区域推荐的数量；用户明确列出地点时仍
 * 保留用户指定的全部地点。
 */
function planningPace(text: string): 'compact' | 'relaxed' | null {
  if (/(?:半日|半天|半日游|半天游)/.test(text)) return 'compact';
  if (/(?:适合老人|适合长辈|老人友好|不太累|轻松|悠闲|慢节奏)/.test(text)) return 'relaxed';
  return null;
}

function broadAreaHint(text: string): string | null {
  const match = text.match(/(?:上海市?\s*)?(徐汇(?:区)?)/);
  return match?.[1] || null;
}

function looksLikeExplicitPlaceList(text: string): boolean {
  return /(?:和|、|，|,|以及|还有)/.test(text) || /(?:武康大楼|龙华寺|徐家汇书院|上海图书馆)/.test(text);
}

function stripPlanningClock(text: string): string {
  // 时间是计划参数，不是地点名称的一部分。把它从目录检索词中移除，
  // 这样“明天上午十点去武康大楼”不会把“十点”一起拿去搜地点。
  return text
    .replace(/(?:上午|下午|晚上|早上|中午)?\s*(?:\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})(?:[:：]\d{2}|点(?:\s*(?:半|一刻|三刻|\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})\s*分?)?)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract explicitly assigned days from phrases such as
 * “第一天去武康大楼，第二天去龙华寺”。The generic planner still uses
 * round-robin distribution when no day marker is present, so this only changes
 * the unambiguous form and keeps ordinary one-sentence requests backward
 * compatible.
 */
function explicitDayGroups(text: string): Array<{ dayIndex: number; text: string }> {
  const matches = [...text.matchAll(/第\s*(\d+|[一二三四五六七八九十两俩])\s*[天日]\s*(?:去|游览|参观|打卡)?\s*[:：]?\s*([\s\S]*?)(?=第\s*(?:\d+|[一二三四五六七八九十两俩])\s*[天日]|$)/g)];
  return matches
    .map(match => ({ dayIndex: (parseDayNumber(match[1]) || 1) - 1, text: match[2].trim() }))
    .filter(item => item.text.length > 0);
}

function displayTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function localMinutes(value: string, timezone = TIMEZONE): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const hour = Number(parts.find(item => item.type === 'hour')?.value);
  const minute = Number(parts.find(item => item.type === 'minute')?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0;
}

function dateAndMinute(value: string, timezone = TIMEZONE): { date: string; minute: number } | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find(item => item.type === type)?.value || '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(minute) ? { date, minute } : null;
}

function placeRef(place: Awaited<ReturnType<PlaceProvider['detail']>>): PlaceRef | null {
  if (!place) return null;
  return {
    placeId: place.placeId, name: place.name,
    coordinates: place.coordinates ? { ...place.coordinates } : null,
    facilityCodes: [...place.facilityCodes],
    ...(place.provider ? { provider: place.provider } : {}),
    ...(place.providerPlaceId ? { providerPlaceId: place.providerPlaceId } : {}),
    ...(place.cityCode ? { cityCode: place.cityCode } : {}),
    ...(place.districtAdcode ? { districtAdcode: place.districtAdcode } : {}),
    ...(place.dataMode ? { dataMode: place.dataMode } : {}),
    ...(place.evidenceIds ? { evidenceIds: [...place.evidenceIds] } : {}),
  };
}

function stopFor(place: NonNullable<Awaited<ReturnType<PlaceProvider['detail']>>>, start: number, duration: number): PlanStop {
  const ref = placeRef(place)!;
  const end = start + duration;
  return {
    stopId: `agent_stop_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    placeId: ref.placeId, place: ref,
    plannedArrivalMinutes: start, startMinutes: start,
    endMinutes: end, departureMinutes: end,
    minDurationMinutes: duration, plannedDurationMinutes: duration,
    openingIntervals: place.openingIntervals ? structuredClone(place.openingIntervals) : undefined,
    status: 'planned',
  };
}

function encodeShareCode(plan: SavedPlan): { code: string; stopCount: number } {
  const days = plan.kind === 'scheme' && Array.isArray(plan.days)
    ? plan.days.map(day => ({ s: day.stops || [] }))
    : [];
  const allStops = days.length ? days.flatMap(day => day.s) : (plan.stops || []);
  if (!allStops.length) throw new Error('方案里还没有地点，先添加地点再分享。');
  if (allStops.length > 200 || days.length > 31) throw new Error('方案超过分享上限，请减少天数或地点。');
  const encodeStop = (stop: unknown) => {
    if (!stop || typeof stop !== 'object' || Array.isArray(stop)) throw new Error('方案中有无效地点，暂时不能分享。');
    const item = stop as PlanStop;
    const place = item.place;
    const coordinates = place?.coordinates;
    if (!place?.name || !coordinates || !Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lng)) {
      throw new Error(`「${place?.name || item.placeId || '未知地点'}」缺少坐标，暂时不能分享。`);
    }
    const duration = Number(item.plannedDurationMinutes || item.minDurationMinutes || DEFAULT_DURATION);
    return {
      n: place.name,
      ...(place.placeId ? { p: place.placeId.slice(0, 120) } : {}),
      la: Math.round(coordinates.lat * 1e5) / 1e5,
      ln: Math.round(coordinates.lng * 1e5) / 1e5,
      crs: coordinates.source === 'amap' ? 'GCJ02' : 'WGS84',
      ...(place.cityCode && /^\d{6}$/.test(place.cityCode) && place.cityCode !== '000000' ? { cc: place.cityCode } : {}),
      m: Math.max(15, Math.min(1440, Math.round(duration))),
      ...(Number.isInteger(item.startMinutes ?? item.plannedArrivalMinutes) ? { a: item.startMinutes ?? item.plannedArrivalMinutes } : {}),
    };
  };
  const payload = days.length
    ? { v: 3, n: plan.name, c: CITY_CODE, cn: '上海', ...(plan.localDate ? { d: plan.localDate } : {}), days: days.map(day => ({ s: day.s.map(encodeStop) })) }
    : { v: 3, n: plan.name, c: CITY_CODE, cn: '上海', ...(plan.localDate ? { d: plan.localDate } : {}), s: allStops.map(encodeStop) };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64').replace(/=+$/, '');
  let sum = 0;
  for (const char of body) sum += char.charCodeAt(0);
  const check = (sum % 1296).toString(36).toUpperCase().padStart(2, '0');
  const chunks: string[] = [];
  for (let index = 0; index < body.length; index += 8) chunks.push(body.slice(index, index + 8));
  return { code: ['BT1', ...chunks, check].join('-'), stopCount: allStops.length };
}

function stopName(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const stop = value as Record<string, unknown>;
  if (stop.place && typeof stop.place === 'object' && !Array.isArray(stop.place)) {
    const name = (stop.place as Record<string, unknown>).name;
    if (typeof name === 'string') return name;
  }
  return typeof stop.placeId === 'string' ? stop.placeId : '';
}

function planDate(plan: SavedPlan): string {
  return plan.localDate || '';
}

export class StandaloneAgentService {
  /**
   * A natural-language confirmation is a second HTTP request, so keep the
   * server-issued plan-load token between the two turns.  Without this small
   * bridge a user could say “确认载入…” forever and the API would correctly
   * reject the request as an unconfirmed (or stale) load.
   */
  private readonly pendingLoads = new Map<string, { schemeId: string; startDate: string; token: string }>();

  constructor(
    private readonly plans: PlanLibraryService,
    private readonly favorites: FavoritesService,
    private readonly memories: PersonalMemoriesService,
    private readonly places: PlaceProvider,
    private readonly routes: RouteProvider,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly community?: CommunityService,
    private readonly nicknameOf: (actorId: string) => string = () => '',
    private readonly isAccount: (actorId: string) => boolean = () => true,
  ) {}

  private pendingLoadKey(actorId: string, schemeId: string, startDate: string) {
    return `${actorId}:${schemeId}:${startDate}`;
  }

  /** Existing execution facts are a separate queue from the planned stops. */
  private progressStops(actorId: string): PlanStop[] {
    const now = this.now();
    return this.plans.list(actorId).flatMap(plan => {
      if (plan.kind !== 'plan' || !plan.localDate) return [];
      const timezone = plan.timezone || TIMEZONE;
      const events = Array.isArray(plan.executionEvents) ? plan.executionEvents : [];
      const corrected = new Set(events.flatMap(event => event.correctsEventId ? [event.correctsEventId] : []));
      const latest = new Map<string, ExecutionEvent>();
      for (const event of [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))) {
        if (!corrected.has(event.executionEventId)) latest.set(event.stopId, event);
      }
      const nowStamp = dateAndMinute(now, timezone);
      return (plan.stops || []).flatMap(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const stop = value as PlanStop;
        if (!stop.status || stop.status === 'planned') return [];
        const active = stop.status === 'en_route' || stop.status === 'visiting';
        const eventStamp = latest.get(stop.stopId) ? dateAndMinute(latest.get(stop.stopId)!.occurredAt, timezone) : null;
        const progressEndMinutes = active
          ? (nowStamp?.date === plan.localDate ? nowStamp?.minute : undefined)
          : eventStamp?.minute;
        return [{
          ...stop,
          date: active && nowStamp?.date ? nowStamp.date : plan.localDate,
          ...(typeof progressEndMinutes === 'number' ? { progressEndMinutes } : {}),
        }];
      });
    });
  }

  async handle(actorId: string, rawText: string): Promise<StandaloneAgentResult> {
    let text = cleanText(rawText).replace(/^(?:请帮我|我想要?|我要|想要?|准备|打算|帮我|请|给我|替我|计划一下|安排一下|规划一下)\s*/, '');
    // 口语里的节奏偏好先作为规划提示移除；当前目录规划会自动按地点
    // 时长与交通顺排，不能因为“轻松一点”被误当成地点名称。
    text = text.replace(/[，,]?\s*安排得?(?:轻松|悠闲|慢节奏|紧凑)(?:一点|一些)?(?:吧|呢)?$/, '').trim();
    // 接住更自然的“半日游 / 适合老人 / 不太累”表达。没有这一步时，
    // 它们会被当作地点关键词，Agent 只能返回示例提示而不会真正创建计划。
    const pace = planningPace(text);
    const areaHint = broadAreaHint(text);
    // 已明确说出“两天/三天”等天数时，保留原有多日方案语义；只有没有
    // 天数的半日或轻松请求才走单日自动收敛。
    const hasExplicitDayCount = /(?:\d|[一二三四五六七八九十两俩])\s*天/.test(text);
    if (pace && areaHint && !hasExplicitDayCount && !looksLikeExplicitPlaceList(text)) {
      if (/(?:路线|路线规划|怎么走|如何走)/.test(text) && pace !== 'compact') {
        text = `安排今天去${areaHint}`;
      } else {
        text = `生成1天方案：${areaHint}`;
      }
    }
    // 让自然说法和结构化命令走同一条确定性路径：
    // “我想要一个三天旅行：……”在去掉礼貌前缀后没有“生成/规划”动词，
    // 因此在这里补上隐含意图；“三天旅行”也统一成可复用方案。
    if (/^(?:一个)?\s*(?:\d+|[一二三四五六七八九十两俩])\s*天\s*(?:的\s*)?(?:旅行|旅游|行程|攻略)(?:\s*[:：]|$)/.test(text)) {
      text = `生成${text}`;
    }
    text = text.replace(/^(生成|创建|规划|安排|做|制定|设计)(一个)?\s*((?:\d+|[一二三四五六七八九十两俩])\s*天)(?:的\s*)?(?:旅行|旅游|行程|攻略)(?=\s*[:：]|$)/, '$1$2$3方案');
    // “给我一份两天徐汇攻略”“我要三天行程”没有显式写“方案”，
    // 但意图仍然是生成可复用的多天方案。把地点描述保留给目录解析。
    const guideWithDetails = text.match(/^(?:一份|一个)?\s*((?:\d+|[一二三四五六七八九十两俩])\s*天)\s*(?:的\s*)?(.+?)攻略(?:\s*[:：]\s*(.+))?$/);
    if (guideWithDetails) text = `生成${guideWithDetails[1]}方案：${guideWithDetails[3] || guideWithDetails[2]}`;
    // “安排一个轻松的两天徐汇行程”把偏好和地点描述夹在天数前后，
    // 归一化为标准多日方案命令；地点描述仍交给目录搜索处理。
    text = text.replace(/^(生成|创建|规划|安排|做|制定|设计)(一个|一份)?\s*(?:轻松|悠闲|慢节奏|紧凑|亲子|美食|文化|徒步)的?\s*((?:\d+|[一二三四五六七八九十两俩])\s*天)\s*(.+?)\s*(?:方案|行程|攻略)(?:\s*[:：]\s*(.*))?$/,
      (_, verb, article = '', days, area, details = '') => `${verb}${article}${days}方案：${details || area}`);
    // “徐汇一日游”“我想去徐汇两日游” are common requests but do not
    // contain the word “方案”. Normalize them to the same deterministic
    // scheme path before the command matchers run.
    // A place or preference may appear between the day count and “行程/方案”:
    // “安排一个三天的徐汇行程，第一天去武康大楼……” remains a reusable
    // multi-day scheme instead of becoming today’s plan.
    text = text.replace(/^(生成|创建|规划|安排|做|制定|设计)(一个|一份)?\s*((?:\d+|[一二三四五六七八九十两俩])\s*天)(?:的)?\s*(.+?)\s*(?:方案|行程|攻略)(?:\s*[:：，,]\s*(.*))?$/,
      (_, verb, article = '', days, area, details = '') => `${verb}${article}${days}方案：${details || area}`);
    // “做周末方案” is a two-day reusable scheme request.
    text = text.replace(/^(生成|创建|规划|安排|做|制定|设计)(一个|一份|个)?\s*周末(?:旅行|旅游|行程|攻略|方案)?$/, '$1$2两天方案：徐汇');
    // “帮我安排一个轻松的周末徐汇行程”同样是可复用的两日方案，
    // 不应退化成把整句话当作一个地点名称。
    const weekendTrip = text.match(/^(?:安排|规划|制定|生成|创建|做|设计)(一个|一份|个)?\s*(?:(轻松|悠闲|慢节奏|紧凑)的?\s*)?周末(?:去|到|逛|游览)?\s*(.+?)\s*(旅行|旅游|行程|攻略|方案)?$/);
    if (weekendTrip && weekendTrip[3] && (weekendTrip[1] || weekendTrip[4])) {
      const preference = weekendTrip[2] ? `${weekendTrip[2]} ` : '';
      const destination = weekendTrip[3].trim();
      text = `生成两天方案：${preference}${destination}`;
    }
    const dayTrip = text.match(/((?:\d+|[一二三四五六七八九十两俩])\s*[日天]游)/);
    if (dayTrip && !/方案|行程/.test(text)) {
      const count = parseDayNumber(dayTrip[1].replace(/[日天]游/, '').trim()) || 1;
      text = `生成${count}天方案：${text.replace(dayTrip[0], ' ')}`.replace(/\s+/g, ' ').trim();
    }
    // “我想去徐汇玩两天”没有“一日游”字样，但仍明确要求多日方案。
    const playfulTrip = text.match(/^(?:去|逛|游览)?\s*(.+?)\s*(?:玩|游玩|逛)\s*((?:\d+|[一二三四五六七八九十两俩])\s*天)$/);
    if (playfulTrip) text = `生成${playfulTrip[2]}方案：${playfulTrip[1]}`;
    // “做个三天行程” is semantically identical to “做一个三天行程”.
    text = text.replace(/^(做|制定|设计|规划)个\s*/, '$1一个 ');
    if (!text) return { handled: false, reply: '' };
    // 口语里日期、动作和“计划”经常以不同顺序出现：
    // “今天帮我安排武康大楼”“制定今天的计划：武康大楼”“给我做个明天行程”。
    // 先把它们统一成已有的“安排日期去地点”命令，避免把“计划”误传给地点搜索。
    const naturalPlanDate = '(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\\d{1,2}月\\d{1,2}[日号]|20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2})';
    const dateFirstPlan = text.match(new RegExp(`^${naturalPlanDate}(?:\\u7684)?(?:\\u5e2e\\u6211)?(?:\\u5b89\\u6392|\\u8ba1\\u5212|\\u89c4\\u5212|\\u5236\\u5b9a|\\u505a|\\u53bb|\\u6e38\\u89c8|\\u53c2\\u89c2|\\u6253\\u5361)\\s*(.+)$`));
    if (dateFirstPlan && !/^(?:\u4ec0\u4e48|\u54ea\u4e9b|\u6709|\u4e86\u4ec0\u4e48|\u6709\u4ec0\u4e48|\u589e\u52a0|\u6dfb\u52a0|\u52a0\u5165|\u653e\u5165|\u4fdd\u5b58|\u5b58\u5165|\u8f7d\u5165|\u5bfc\u5165|\u5220\u9664|\u79fb\u9664|\u53d6\u6d88|\u6e05\u9664|\u6e05\u7a7a|\u67e5\u770b|\u770b\u770b|\u8def\u7ebf)/.test(dateFirstPlan[2])) {
      const destination = dateFirstPlan[2].trim();
      if (destination) text = `安排${dateFirstPlan[1]}去${destination}`;
    }
    const planLabel = text.match(new RegExp(`^(?:\\u7ed9\\u6211|\\u5e2e\\u6211)?\\s*(?:\\u5b89\\u6392|\\u8ba1\\u5212|\\u89c4\\u5212|\\u5236\\u5b9a|\\u521b\\u5efa|\\u751f\\u6210|\\u505a|\\u8bbe\\u8ba1)?\\s*(?:\\u4e00\\u4e2a|\\u4e00\\u4efd|\\u4e2a)?\\s*${naturalPlanDate}(?:\\u7684)?(?:\\u65e5\\u8ba1\\u5212|\\u8ba1\\u5212|\\u884c\\u7a0b|\\u5b89\\u6392)\\s*[:\uFF1A,\uFF0C]?\\s*(.+)$`));
    if (planLabel?.[2] && !/^(?:\u4ec0\u4e48|\u54ea\u4e9b|\u6709|\u4e86\u4ec0\u4e48|\u6709\u4ec0\u4e48|\u589e\u52a0|\u6dfb\u52a0|\u52a0\u5165|\u653e\u5165|\u4fdd\u5b58|\u5b58\u5165|\u8f7d\u5165|\u5bfc\u5165|\u5220\u9664|\u79fb\u9664|\u53d6\u6d88|\u6e05\u9664|\u6e05\u7a7a|\u67e5\u770b|\u770b\u770b|\u8def\u7ebf)/.test(planLabel[2])) text = `\u5b89\u6392${planLabel[1]}\u53bb${planLabel[2]}`;
    const actionFirstPlan = text.match(new RegExp(`^(?:\\u7ed9\\u6211|\\u5e2e\\u6211)?\\s*(?:\\u5b89\\u6392|\\u8ba1\\u5212|\\u89c4\\u5212|\\u5236\\u5b9a|\\u521b\\u5efa|\\u751f\\u6210|\\u505a|\\u8bbe\\u8ba1)\\s*(?:\\u4e00\\u4e2a|\\u4e00\\u4efd|\\u4e2a)?\\s*${naturalPlanDate}?(?:\\u7684)?(?:\\u65e5\\u8ba1\\u5212|\\u8ba1\\u5212|\\u884c\\u7a0b|\\u5b89\\u6392)\\s*[:\uFF1A,\uFF0C]?\\s*(.+)$`));
    if (actionFirstPlan?.[1] && !/^(?:\u4ec0\u4e48|\u54ea\u4e9b|\u6709|\u4e86\u4ec0\u4e48|\u6709\u4ec0\u4e48|\u589e\u52a0|\u6dfb\u52a0|\u52a0\u5165|\u653e\u5165|\u4fdd\u5b58|\u5b58\u5165|\u8f7d\u5165|\u5bfc\u5165|\u5220\u9664|\u79fb\u9664|\u53d6\u6d88|\u6e05\u9664|\u6e05\u7a7a|\u67e5\u770b|\u770b\u770b|\u8def\u7ebf)/.test(actionFirstPlan[2])) {
      const dateWord = actionFirstPlan[1] || '今天';
      text = `安排${dateWord}去${actionFirstPlan[2]}`;
    }
    // Normalize common “add this place to tomorrow's plan” wording into the
    // same append-and-reschedule path as an explicit arrange command.
    const addToPlan = text.match(/^(?:把|将)\s*(.+?)\s*(?:加入|添加到|放入|放进|加到|安排到|排到|排进|放在|放到)\s*(?:(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})(?:的)?(?:计划|行程|安排)?|(?:计划|行程|安排))$/)
      || text.match(/^(?:新增|添加|加入)\s*(.+?)\s*(?:到|进)?\s*(?:(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})(?:的)?(?:计划|行程|安排)|(?:计划|行程|安排))$/);
    const inlinePlanAdd = text.match(/^(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})(?:的)?(?:计划|安排)\s*(?:增加|添加|加入|放入)\s*(.+)$/);
    if (inlinePlanAdd) text = `安排${inlinePlanAdd[1]}去${inlinePlanAdd[2]}`;
    // 把用户常说的“删除今天的武康大楼”统一成日期计划中的地点删除，
    // 避免必须补上“计划”或“安排”这两个内部术语。
    const directPlaceDelete = text.match(/^(?:删除|移除|去掉)\s*(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})(?:的)?\s*(?!计划|方案)(.+)$/);
    if (directPlaceDelete) text = `删除${directPlaceDelete[1]}计划中的${directPlaceDelete[2]}`;
    // “把武康大楼的游览时间改成一小时”与“把武康大楼游览一小时”是同一动作。
    const naturalDurationEdit = text.match(/^(?:把|将)\s*(.+?)\s*(?:的)?(?:游览|停留)时间\s*(?:改为|改成|调整为|设为|设置为)\s*((?:\d+(?:\.\d+)?|[零〇一二两俩三四五六七八九十]{1,3})\s*(?:小时|分钟?))$/);
    if (naturalDurationEdit) text = `把${naturalDurationEdit[1]}游览${naturalDurationEdit[2]}`;
    if (addToPlan) text = `安排${addToPlan[2] || '今天'}去${addToPlan[1]}`;
    // “把龙华寺移到后天” moves an existing planned stop instead of
    // A user naturally starts with the intention rather than the operation:
    // “我想去武康大楼和龙华寺” / “周末想去徐家汇书院”。 Normalize these
    // forms before the deterministic arrange matcher so they create the same
    // dated plan as an explicit “安排” command.
    const datePhrase = '(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\\d{1,2}月\\d{1,2}[日号]|20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2})';
    // “安排明天上午去武康大楼”没有具体钟点，但仍然是明确的日期安排。
    // 给上午/下午/晚上采用稳定默认时刻，避免把“上午”拼进地点搜索词。
    const datePeriod = text.match(new RegExp(`^(?:安排|计划|规划)${datePhrase}(上午|下午|晚上|早上)(?:去|游览|参观|打卡)?\\s*(.+)$`));
    if (datePeriod && parseTime(datePeriod[3]) === null) {
      const defaultClock = datePeriod[2] === '上午' || datePeriod[2] === '早上' ? '09:00'
        : datePeriod[2] === '下午' ? '14:00' : '18:00';
      text = `安排${datePeriod[1]}去${datePeriod[3]} ${defaultClock}`;
    }
    // 时间放在地点前是更常见的口语顺序：“安排明天上午九点去武康大楼”。
    // 先把它换成既有的“日期 + 地点 + 时间”形态，地点解析不会把时刻当成 POI。
    const dateAtStart = text.match(new RegExp(`^${datePhrase}`));
    if (dateAtStart) {
      const remainder = text.slice(dateAtStart[0].length).trim().replace(/^(?:安排|计划|规划)\\s*/, '');
      const timedPrefix = remainder.match(/^(下午|晚上|上午|早上|中午)?\\s*(\\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})(?::(\\d{2})|点(?:\\s*(\\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})\\s*分?)?)?\\s*(?:去|逛|游览|参观|打卡)\\s*(.+)$/);
      if (timedPrefix) {
        const period = timedPrefix[1] || '';
        const hour = timedPrefix[2];
        const clock = timedPrefix[3] ? `${hour}:${timedPrefix[3]}` : `${hour}点${timedPrefix[4] ? `${timedPrefix[4]}分` : ''}`;
        text = `安排${dateAtStart[1]}去${timedPrefix[5]} ${period}${clock}`;
      }
    }
    const revisit = text.match(new RegExp(`^(?:我(?:想)?|请)?\\s*(?:${datePhrase}\\s*)?(?:再|再次|又)(?:去|逛|游览|参观)\\s*(.+)$`));
    if (revisit) text = `安排${revisit[1] || '今天'}去${revisit[2]}`;
    const conversationalTrip = text.match(new RegExp(`^(?:${datePhrase}\\s*)?(?:我\\s*)?(?:想去|想逛|想游览|准备去|打算去)\\s*(.+)$`));
    if (conversationalTrip) text = `安排${conversationalTrip[1] || '今天'}去${conversationalTrip[2]}`;
    // “周六去龙华寺”省略了“想”，仍然是明确的日期 + 地点安排。
    const datedDirectTrip = text.match(new RegExp(`^(?:${datePhrase})\\s*(?:去|游览|参观|打卡)\\s*(.+)$`));
    if (datedDirectTrip) text = `安排${datedDirectTrip[1]}去${datedDirectTrip[2]}`;
    // 也接受“我想明天去……”和“我想去……，明天安排”这两种更自然的语序。
    // 日期只作为计划日期，不应被当成地点名称传给地点目录搜索。
    const inlineDateTrip = text.match(new RegExp(`^(?:我\\s*)?(?:想|准备|打算)\\s*(?:${datePhrase}\\s*)?(?:去|逛|游览)\\s*(.+)$`));
    if (inlineDateTrip) {
      const inlineDate = inlineDateTrip[1] || '今天';
      text = `安排${inlineDate}去${inlineDateTrip[2]}`;
    } else {
      const suffixDateTrip = text.match(new RegExp(`^(?:我\\s*)?(?:想去|想逛|想游览|准备去|打算去)\\s*(.+?)\\s*(?:，|,|\\s)+(?:${datePhrase})\\s*(?:安排|去)?$`));
      if (suffixDateTrip) text = `安排${suffixDateTrip[2]}去${suffixDateTrip[1]}`;
    }
    // Also accept the natural reversed order: “安排武康大楼到后天”。
    const arrangePlaceToDate = text.match(/^(?:安排|计划|规划)\s*(.+?)\s*(?:到|放到|排到)\s*(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})(?:的)?(?:计划|行程|安排)?$/);
    if (arrangePlaceToDate) text = `安排${arrangePlaceToDate[2]}去${arrangePlaceToDate[1]}`;
    const date = parseDate(text, this.now()) || dateKey(new Date(this.now()));
    if (/^(?:安排|计划|规划|生成|创建|做|制定|设计|把|将|载入|导入|去|游览|参观|打卡)/.test(text)) {
      const explicitDate = text.match(/20\d{2}[年/-]\d{1,2}[月/-]\d{1,2}[日号]?|\d{1,2}月\d{1,2}[日号]?/);
      if (explicitDate && !parseDate(explicitDate[0], this.now())) return { handled: true, reply: '这个日期不存在，请提供有效的年月日。原安排未改动。' };
      const explicitClock = text.match(/(?:下午|晚上|上午|早上|中午)?\s*(?:\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})(?:[:：]\d{2}|点(?:\s*(?:半|一刻|三刻|\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})\s*分?)?)/);
      if (explicitClock && parseTime(explicitClock[0]) === null) return { handled: true, reply: '时间需在 00:00–23:59 之间，请核对后再安排。原安排未改动。' };
    }
    // “把龙华寺移到后天” moves an existing planned stop instead of
    // duplicating it in the destination day. Executed stops stay immutable.
    const movePlace = text.match(new RegExp(`^(?:把|将)\\s*(.+?)\\s*(?:移到|挪到|改到|调整到|移动到)\\s*(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|[0-9]{1,2}月[0-9]{1,2}[日号]|20[0-9]{2}[-/][0-9]{1,2}[-/][0-9]{1,2})(?:的)?(?:计划|行程|安排)?$`));
    if (movePlace) {
      const placeName = movePlace[1].trim();
      const targetDate = parseDate(movePlace[2], this.now()) || date;
      const planItems = this.plans.list(actorId).filter(item => item.kind === 'plan' && item.localDate) as SavedPlan[];
      const stopsOf = (item: SavedPlan) => (item.stops || []) as PlanStop[];
      const candidates = planItems
        .filter(item => stopsOf(item).some(stop => stopName(stop).includes(placeName)))
        .sort((left, right) => String(left.localDate).localeCompare(String(right.localDate)));
      const source = candidates.find(item => item.localDate !== targetDate) || candidates[0];
      if (!source) return { handled: true, reply: `没有找到包含「${placeName}」的日计划。` };
      if (source.localDate === targetDate) return { handled: true, reply: `「${placeName}」已经在${targetDate}的计划里。` };
      const moved = stopsOf(source).filter(stop => stopName(stop).includes(placeName));
      if (moved.some(stop => stop.status && stop.status !== 'planned')) return { handled: true, reply: `「${placeName}」已经有执行记录，不能移动；可以先纠正进度。` };
      const movedIds = new Set(moved.map(stop => stop.stopId));
      const sourceStops = stopsOf(source).filter(stop => !movedIds.has(stop.stopId));
      const sourceLegs = (source.routeLegs || []) as Array<{ fromStopId?: string; toStopId?: string }>;
      const nextSourceLegs = sourceLegs.filter(leg => !movedIds.has(leg.fromStopId || '') && !movedIds.has(leg.toStopId || ''));
      const destination = planItems.find(item => item.localDate === targetDate);
      const destinationStops = destination ? structuredClone(stopsOf(destination)) as PlanStop[] : [];
      let cursor = destinationStops.reduce((max, stop) => Math.max(max, Number(stop.departureMinutes || stop.endMinutes || DEFAULT_START)), DEFAULT_START - DEFAULT_TRAVEL_BUFFER);
      if (targetDate === dateKey(new Date(this.now()))) cursor = Math.max(cursor, localMinutes(this.now()) + 10 - DEFAULT_TRAVEL_BUFFER);
      const imported = moved.map(stop => {
        const duration = Number(stop.plannedDurationMinutes || stop.minDurationMinutes || DEFAULT_DURATION);
        const start = cursor + DEFAULT_TRAVEL_BUFFER;
        const next = { ...structuredClone(stop), date: targetDate, status: 'planned' as const, plannedArrivalMinutes: start, startMinutes: start, endMinutes: start + duration, departureMinutes: start + duration };
        cursor = start + duration;
        return next;
      });
      const nextDestinationStops = [...destinationStops, ...imported];
      try {
        this.plans.update(actorId, source.id, {
          name: source.name, localDate: source.localDate, timezone: source.timezone,
          snapshot: { stops: sourceStops, routeLegs: nextSourceLegs, plannedCharges: source.plannedCharges || [] },
        });
        if (destination) {
          this.plans.update(actorId, destination.id, {
            name: destination.name, localDate: destination.localDate, timezone: destination.timezone,
            snapshot: { stops: nextDestinationStops, routeLegs: await this.routeLegs(nextDestinationStops), plannedCharges: destination.plannedCharges || [] },
          });
        } else {
          this.plans.save(actorId, {
            name: `${targetDate} 日计划`, kind: 'plan', cityCode: CITY_CODE, timezone: TIMEZONE, localDate: targetDate,
            snapshot: { stops: nextDestinationStops, routeLegs: await this.routeLegs(nextDestinationStops), plannedCharges: [] },
          }, 'current');
        }
        return { handled: true, reply: `已将「${moved.map(stopName).join('、')}」从${source.localDate}移到${targetDate}，时间已自动顺排。`, refresh: ['plans'], date: targetDate };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '移动地点失败，请稍后再试。' };
      }
    }

    // 社区写操作也走同一个 Agent 入口，避免用户必须先找到对应的页面。
    // 游客可以使用计划、收藏地点和旅行记忆，但社区发帖/互动仍要求注册账号。
    const postTarget = (value: string) => {
      if (!this.community) return null;
      const query = value.trim().replace(/^[「“"']|[」”"']$/g, '');
      const posts = [...this.community.mine(actorId).posts, ...this.community.listPosts(actorId).filter(post => !post.mine)];
      return posts.find(post => post.id === query)
        || posts.find(post => post.nickname === query)
        || posts.find(post => String(post?.text ?? '').split(/\r?\n/)[0].trim() === query)
        || posts.find(post => String(post?.text ?? '').includes(query))
        || null;
    };
    const accountRequired = () => !this.community
      ? '社区服务暂不可用。'
      : !this.isAccount(actorId)
        ? '社区操作需要先注册账号，请到“我的”完成注册。'
        : '';

    const publishPost = text.match(/^(?:发帖|发(?:一个|一条)?(?:旅行)?帖子|发布(?:一个|一条)?(?:旅行)?帖子|写(?:一个)?帖子)\s*[:：]?\s*(.+)$/s);
    if (publishPost) {
      const blocked = accountRequired();
      if (blocked) return { handled: true, reply: blocked };
      const lines = publishPost[1].trim().split(/\r?\n/);
      const placeLine = lines.find(line => /^关联地点\s*[:：]/.test(line));
      const contentLines = placeLine ? lines.filter(line => line !== placeLine) : lines;
      const title = contentLines[0].trim();
      const body = contentLines.slice(1).join('\n').trim();
      let placeRefs: Array<{ placeId: string; name: string }> | undefined;
      if (placeLine) {
        const related = await this.resolvePlaces(placeLine.replace(/^关联地点\s*[:：]\s*/, ''));
        if (related.error || !related.places.length) return { handled: true, reply: related.error || '没有找到要关联的地点。' };
        placeRefs = related.places.map(place => ({ placeId: place.placeId, name: place.name }));
      }
      try {
        const created = this.community!.publishPost(actorId, {
          nickname: this.nicknameOf(actorId),
          text: body ? `${title}\n${body}` : title,
          ...(placeRefs ? { placeRefs } : {}),
        }, this.nicknameOf(actorId));
        return { handled: true, reply: `已发布帖子「${created.text.split(/\r?\n/)[0].slice(0, 60)}」。`, refresh: ['community'] };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '帖子发布失败，请稍后再试。' };
      }
    }

    const comment = text.match(/^(?:评论|回复)(?:帖子)?\s*([\s\S]*?)\s*[:：]\s*(.+)$/)
      || text.match(/^(?:给|对)(?:帖子)?\s*(.+?)\s*(?:评论|回复)\s*[:：]\s*(.+)$/);
    if (comment) {
      const blocked = accountRequired();
      if (blocked) return { handled: true, reply: blocked };
      const post = postTarget(comment[1]);
      if (!post) return { handled: true, reply: `没有找到帖子「${comment[1].trim()}」，可以使用帖子 ID 或标题。` };
      try {
        this.community!.addComment(actorId, post.id, { text: comment[2].trim(), nickname: this.nicknameOf(actorId) }, this.nicknameOf(actorId));
        return { handled: true, reply: `已在帖子「${post.text.split(/\r?\n/)[0].slice(0, 30)}」下发表评论。`, refresh: ['community'] };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '评论发布失败，请稍后再试。' };
      }
    }

    const like = text.match(/^(?:点赞(?:帖子)?|(?:给|为)(?:帖子)?(?:点个赞|点赞))\s*(.+)$/);
    if (like) {
      const blocked = accountRequired();
      if (blocked) return { handled: true, reply: blocked };
      const post = postTarget(like[1]);
      if (!post) return { handled: true, reply: `没有找到帖子「${like[1].trim()}」，可以使用帖子 ID 或标题。` };
      try {
        const result = this.community!.likePost(actorId, post.id);
        return { handled: true, reply: result.liked ? '已点赞。' : '已取消点赞。', refresh: ['community'] };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '点赞失败，请稍后再试。' };
      }
    }

    // 明确出现“帖子/文章”才进入帖子收藏，避免截住“收藏武康大楼”的地点收藏。
    const postFavorite = text.match(/^(收藏|取消收藏)(?:帖子|文章)\s*(.+)$/);
    if (postFavorite) {
      const blocked = accountRequired();
      if (blocked) return { handled: true, reply: blocked };
      const post = postTarget(postFavorite[2]);
      if (!post) return { handled: true, reply: `没有找到帖子「${postFavorite[2].trim()}」，可以使用帖子 ID 或标题。` };
      if (postFavorite[1] === '取消收藏') {
        this.favorites.removePost(actorId, post.id);
        return { handled: true, reply: '已取消收藏帖子。', refresh: ['favorites', 'community'] };
      }
      this.favorites.addPost(actorId, { postId: post.id, nickname: post.nickname, title: post.text.split(/\r?\n/)[0].slice(0, 60), body: post.text.split(/\r?\n/).slice(1).join('\n'), createdAt: post.createdAt, source: 'active' });
      return { handled: true, reply: '已收藏帖子。', refresh: ['favorites', 'community'] };
    }

    const recommendation = text.match(/^(?:找|推荐|看看|列出)\s*(.+)$/);
    if (recommendation && /附近|安静|文化|美食|公园|亲子|景点|地点/.test(recommendation[1])) {
      const found = await this.resolvePlaces(recommendation[1]);
      if (found.error || !found.places.length) return { handled: true, reply: found.error || '当前地点目录里还没有符合条件的地点。' };
      const names = found.places.slice(0, 8).map(place => `「${place.name}」`).join('、');
      return { handled: true, reply: `当前徐汇地点目录里可以先看看：${names}。你可以继续说“安排今天去其中几个”，我会按时间排好。` };
    }

    const routeQuery = text.match(/^(?:(?:帮我|请)?(?:规划|查询|查看|安排)\s*)?(?:从|由)\s*(.+?)\s*(?:到|去|前往)\s*(.+?)\s*(?:的)?(?:怎么走|如何走|路线怎么规划|规划路线|路线)$/);
    if (routeQuery) {
      const from = await this.resolvePlaces(routeQuery[1]);
      const to = await this.resolvePlaces(routeQuery[2]);
      if (from.error || !from.places.length) return { handled: true, reply: from.error || `没有找到出发地点「${routeQuery[1].trim()}」。` };
      if (to.error || !to.places.length) return { handled: true, reply: to.error || `没有找到目的地「${routeQuery[2].trim()}」。` };
      const origin = from.places[0];
      const destination = to.places[0];
      if (!origin.coordinates || !destination.coordinates) return { handled: true, reply: '这两个地点缺少坐标，暂时无法估算路线。' };
      const transportMode = /开车|驾车|驾驶/.test(text) ? 'driving' : /公交|地铁|公共交通/.test(text) ? 'transit' : 'walking';
      try {
        const dataMode = this.routes.providerName === 'demo_route_estimator' ? 'demo' : 'online';
        const result = await this.routes.plan({ origin: placeRef(origin)!, destination: placeRef(destination)!, transportMode, cityCode: CITY_CODE, dataMode });
        const leg = result.leg;
        const distance = typeof leg.distanceMeters === 'number' && Number.isFinite(leg.distanceMeters) ? `${(leg.distanceMeters / 1000).toFixed(1)} 公里` : '距离未知';
        const duration = typeof leg.durationMinutes === 'number' && Number.isFinite(leg.durationMinutes) ? `${leg.durationMinutes} 分钟` : '时长未知';
        return { handled: true, reply: `从「${origin.name}」到「${destination.name}」${transportMode === 'walking' ? '步行' : transportMode === 'transit' ? '公共交通' : '驾车'}约 ${duration}，${distance}。${dataMode === 'demo' ? '当前为估算路线。' : ''}` };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '路线暂时无法计算，请稍后再试。' };
      }
    }

    const plannedRouteQuery = text.match(/^(?:(?:查看|看看|打开|显示|告诉我)\s*)?(今天|明天|后天)?(?:的)?(?:全程)?路线(?:详情|怎么走)?$/);
    if (plannedRouteQuery) {
      const targetDate = plannedRouteQuery[1] ? (parseDate(plannedRouteQuery[1], this.now()) || date) : date;
      const plan = this.plans.list(actorId).find(item => item.kind === 'plan' && item.localDate === targetDate);
      const stops = (plan?.stops || []).filter(stop => stop && typeof stop === 'object' && stopName(stop).trim());
      if (!stops.length) return { handled: true, reply: `${targetDate}还没有可查看的路线。`, date: targetDate };
      const names = stops.map(stopName).join(' → ');
      const legs = (plan?.routeLegs || []).filter(value => value && typeof value === 'object') as Array<Record<string, unknown>>;
      const distance = legs.reduce((sum, leg) => sum + (typeof leg.distanceMeters === 'number' && Number.isFinite(leg.distanceMeters) ? leg.distanceMeters : 0), 0);
      const duration = legs.reduce((sum, leg) => sum + (typeof leg.durationMinutes === 'number' && Number.isFinite(leg.durationMinutes) ? leg.durationMinutes : 0), 0);
      const estimate = distance > 0 || duration > 0
        ? `，约${duration > 0 ? `${Math.round(duration)}分钟` : '未知时长'}${distance > 0 ? `、${(distance / 1000).toFixed(1)}公里` : ''}`
        : '';
      return { handled: true, reply: `${targetDate}路线：${names}${estimate}。`, refresh: ['plans'], date: targetDate };
    }

    const note = text.match(/^(?:记下|记录|写下|写(?:一条|一篇)(?:旅行)?记忆|帮我记住|保存笔记)\s*[:：]?\s*(.+)$/);
    if (note) {
      const saved = this.memories.create(actorId, { userText: note[1].trim(), localDate: date });
      return saved.ok
        ? { handled: true, reply: '已保存到旅行记忆。', refresh: ['memories'], date }
        : { handled: true, reply: saved.error.message };
    }

    const saveAsScheme = text.match(/^(?:把|将)?\s*(?:(今天|明天|后天|下周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})\s*)?(?:的\s*)?(?:日计划|计划|安排)\s*(?:保存|存|另存)(?:为|成)\s*(?:候选\s*)?方案(?:\s*[：:，,]?\s*(?:叫做|命名为|名称是|名字是)?\s*[「“]?(.+?)[」”]?)?$/)
      || text.match(/^(?:把|将)?\s*(?:(今天|明天|后天|下周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})\s*)?(?:的\s*)?(?:日计划|计划|安排)\s*(?:存入|加入)\s*(?:候选\s*)?方案(?:\s*[：:，,]?\s*(?:叫做|命名为|名称是|名字是)?\s*[「“]?(.+?)[」”]?)?$/);
    if (saveAsScheme) {
      const targetDate = saveAsScheme[1] ? (parseDate(saveAsScheme[1], this.now()) || date) : date;
      const source = this.plans.list(actorId).find(item => item.kind === 'plan' && item.localDate === targetDate);
      if (!source) return { handled: true, reply: `${targetDate}还没有可保存的日计划。` };
      const requestedName = saveAsScheme[2]
        ?.replace(/^[\s,，:：]+/, '')
        .replace(/^(?:叫做|命名为)\s*/, '')
        .trim();
      const baseName = requestedName || `${targetDate}旅行方案`;
      const existingNames = new Set(this.plans.list(actorId).map(item => item.name));
      let name = baseName;
      for (let suffix = 2; existingNames.has(name); suffix += 1) name = `${baseName} ${suffix}`;
      try {
        this.plans.save(actorId, {
          name, kind: 'scheme', cityCode: source.cityCode || CITY_CODE, timezone: source.timezone || TIMEZONE,
          days: [{ dayIndex: 0, stops: structuredClone(source.stops || []).map(value => ({ ...(value as Record<string, unknown>), status: 'planned' })), routeLegs: structuredClone(source.routeLegs || []), plannedCharges: structuredClone(source.plannedCharges || []) }],
        }, 'current');
        return { handled: true, reply: `已把${targetDate}的日计划保存为方案「${name}」。`, refresh: ['plans'], date: targetDate };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '保存方案失败，请稍后再试。' };
      }
    }

    // 名称是方案的可读入口；允许用户直接说“把周末方案改名为徐汇慢行”，
    // 不必为了改一个标题打开编辑器。更新时完整带回原内容，避免误删地点。
    const renamePlan = text.match(/^(?:把|将)?\s*(?:方案|计划)\s*[「“]?(.+?)[」”]?\s*(?:改名为|重命名为|更名为|改成)\s*[「“]?(.+?)[」”]?$/);
    if (renamePlan) {
      const oldName = renamePlan[1].trim();
      const nextName = renamePlan[2].trim();
      const target = this.plans.list(actorId).find(item => item.name === oldName || item.name.includes(oldName));
      if (!target) return { handled: true, reply: `没有找到名为「${oldName}」的方案。` };
      if (!nextName) return { handled: true, reply: '新方案名称不能为空。' };
      try {
        if (target.kind === 'scheme') {
          this.plans.update(actorId, target.id, {
            name: nextName, localDate: target.localDate, timezone: target.timezone,
            days: structuredClone(target.days || []), snapshot: { stops: [], routeLegs: [], plannedCharges: [] },
          });
        } else {
          this.plans.update(actorId, target.id, {
            name: nextName, localDate: target.localDate, timezone: target.timezone,
            snapshot: { stops: structuredClone(target.stops || []), routeLegs: structuredClone(target.routeLegs || []), plannedCharges: structuredClone(target.plannedCharges || []) },
          });
        }
        return { handled: true, reply: `已将「${oldName}」改名为「${nextName}」。`, refresh: ['plans'], date: target.localDate };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '方案改名失败，请换一个名称。' };
      }
    }

    // 方案分享也可以直接交给 Agent：只分享自己保存的方案，服务端仍会
    // 校验账号、城市和方案码，返回可贴进帖子的短分享码。
    const sharePlan = text.match(/^(?:分享|公开|发布)s*(?:(?:我的)?(?:候选)?方案|计划)?\s*[「“]?([^」”]*)[」”]?$/);
    if (sharePlan) {
      const blocked = accountRequired();
      if (blocked) return { handled: true, reply: blocked };
      if (!this.community) return { handled: true, reply: '社区服务暂不可用。' };
      const requestedName = sharePlan[1].trim();
      const candidates = this.plans.list(actorId).filter(item => item.kind === 'scheme');
      const target = requestedName
        ? candidates.find(item => item.name === requestedName || item.name.includes(requestedName))
        : candidates[0];
      if (!target) return { handled: true, reply: requestedName ? `没有找到名为「${requestedName}」的方案。` : '还没有可分享的方案，请先生成一套方案。' };
      try {
        const encoded = encodeShareCode(target);
        const share = this.community.publishPlanShare(actorId, {
          code: encoded.code, name: target.name, cityCode: CITY_CODE, cityLabel: '上海',
          ...(target.localDate ? { localDate: target.localDate } : {}), stopCount: encoded.stopCount,
          nickname: this.nicknameOf(actorId),
        }, { cityCode: CITY_CODE, cityLabel: '上海' });
        return { handled: true, reply: `已分享方案「${target.name}」，方案码是 ${share.shareCode}，可以直接贴到帖子里。`, refresh: ['community', 'plans'] };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '方案分享失败，请稍后再试。' };
      }
    }

    // “取消今天计划”是用户常用的整日清理动作。它必须先确认，避免把
    // 正在使用中的安排误删；确认后才删除对应日期的计划记录。
    const cancelPlan = text.match(/^(?:(确认|确定|直接)\s*)?(?:取消|清除|清空)\s*(今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})(?:的)?(?:计划|安排)$/);
    if (cancelPlan) {
      const targetDate = parseDate(cancelPlan[2], this.now()) || date;
      const target = this.plans.list(actorId).find(item => item.kind === 'plan' && item.localDate === targetDate);
      if (!target) return { handled: true, reply: `${targetDate}还没有可取消的计划。`, date: targetDate };
      if (!cancelPlan[1]) return { handled: true, reply: `确定取消${targetDate}的计划「${target.name}」吗？请回复“确认取消${targetDate}计划”。`, destructive: true, date: targetDate };
      this.plans.remove(actorId, target.id);
      return { handled: true, reply: `已取消${targetDate}的计划。`, refresh: ['plans'], date: targetDate };
    }

    const confirmedDelete = text.match(/^(?:确认|确定|直接)\s*(?:删除|移除)\s*[「“]?(.+?)[」”]?$/);
    if (confirmedDelete && !/中的|地点/.test(text)) {
      const requestedName = confirmedDelete[1].trim();
      const exactTarget = this.plans.list(actorId).find(item => item.name === requestedName);
      const target = exactTarget || this.findPlan(actorId, text, date);
      if (target) {
        this.plans.remove(actorId, target.id);
        return { handled: true, reply: `已删除「${target.name}」。`, refresh: ['plans'], date };
      }
    }

    if (/^(?:确认|确定)?\s*(?:删除|移除)/.test(text) && /方案|计划/.test(text) && !/中的|地点/.test(text)) {
      // cleanText removes decorative quotes, so also recover the plain name
      // from "删除方案 周末" / "删除方案「周末」" before falling back to the
      // date based day plan.
      const namedScheme = text.match(/^(?:确认|确定)?\s*(?:删除|移除)\s*方案\s*(.+)$/)?.[1]?.trim();
      const exactTarget = namedScheme
        ? this.plans.list(actorId).find(item => item.name === namedScheme)
        : null;
      const target = exactTarget || this.findPlan(actorId, text, date);
      if (!target) return { handled: true, reply: '请告诉我要删除的方案名称，或说“删除今天计划”。' };
      if (!/确认|确定|直接/.test(text)) {
        return { handled: true, reply: `确定删除「${target.name}」吗？请回复“确认删除${target.name}”。`, destructive: true };
      }
      this.plans.remove(actorId, target.id);
      return { handled: true, reply: `已删除「${target.name}」。`, refresh: ['plans'], date };
    }

    if (/^(?:我的)?收藏(?:列表)?$|^(?:查看|打开)我的收藏$/.test(text)) {
      const places = this.favorites.list(actorId).filter(item => item.kind === 'place');
      const posts = this.favorites.listPosts(actorId);
      const sections: string[] = [];
      if (places.length) sections.push(`地点 ${places.slice(0, 8).map(item => `「${item.place.name}」`).join('、')}${places.length > 8 ? `等${places.length}个` : ''}`);
      if (posts.length) sections.push(`帖子 ${posts.slice(0, 8).map(item => `「${item.post.title || item.post.nickname}」`).join('、')}${posts.length > 8 ? `等${posts.length}个` : ''}`);
      return { handled: true, reply: sections.length ? `已收藏：${sections.join('；')}。` : '还没有收藏地点或帖子。', refresh: ['favorites'] };
    }

    const placeFavorite = text.match(/^(收藏|取消收藏)\s*(?:地点)?\s*(.+)$/);
    if (placeFavorite && !/帖子|文章/.test(placeFavorite[2])) {
      const found = await this.resolvePlaces(placeFavorite[2]);
      if (found.error || !found.places.length) return { handled: true, reply: found.error || '请告诉我要收藏哪个地点。' };
      if (placeFavorite[1] === '取消收藏') {
        for (const place of found.places) this.favorites.remove(actorId, place.placeId);
        return { handled: true, reply: `已取消收藏${found.places.map(place => `「${place.name}」`).join('、')}。`, refresh: ['favorites'] };
      }
      for (const place of found.places) this.favorites.add(actorId, place);
      return { handled: true, reply: `已收藏${found.places.map(place => `「${place.name}」`).join('、')}。`, refresh: ['favorites'] };
    }

    const load = !/(?:生成|创建|规划)\S*方案/.test(text)
      ? text.match(/(?:(?:确认|确定)\s*)?(?:载入|加载|导入|加入|使用|套用)(?:方案)?\s*[「“]?(.+?)[」”]?(?:\s*(今天|明天|后天|下周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2}))?$/)
      : null;
    if (load) {
      const name = load[1].trim();
      const schemes = this.plans.list(actorId).filter(item => item.kind === 'scheme');
      const genericSchemeRequest = new Set(['方案', '我的方案', '方案候选', '我的方案候选', '旅行方案', '计划方案', '今天的方案', '明天的方案']).has(name);
      const scheme = genericSchemeRequest
        ? schemes[0]
        : schemes.find(item => item.name === name || item.name.includes(name));
      if (!scheme) return { handled: true, reply: `没有找到名为「${name}」的方案，请先说“我的方案”查看名称。` };
      try {
        const confirmed = /确认|确定/.test(text);
        // A confirmation usually omits the original date ("确认载入徐汇路线").
        // Recover that date from the pending conflict instead of silently
        // falling back to today and importing the scheme into the wrong day.
        const explicitDate = load[2] ? parseDate(load[2], this.now()) : null;
        const pendingForScheme = confirmed
          ? [...this.pendingLoads.entries()]
            .filter(([key, value]) => key.startsWith(`${actorId}:${scheme.id}:`) && value.schemeId === scheme.id)
            .at(-1)?.[1]
          : undefined;
        // The scheme name may itself contain date words such as “周末”。Only
        // an explicit trailing date in the load command controls placement;
        // otherwise loading always starts today as the UI does.
        const defaultLoadDate = dateKey(new Date(this.now()));
        const startDate = explicitDate || pendingForScheme?.startDate || defaultLoadDate;
        const key = this.pendingLoadKey(actorId, scheme.id, startDate);
        const pending = confirmed ? (this.pendingLoads.get(key) || pendingForScheme) : undefined;
        const progressStops = this.progressStops(actorId);
        let effectiveDate = startDate;
        let result = this.plans.loadAsPlans(actorId, scheme.id, startDate, false, {
          stops: progressStops,
          confirmed,
          ...(pending?.token ? { confirmationToken: pending.token } : {}),
        });
        // A confirmed natural-language import never replaces an existing day
        // plan. Move the whole scheme to the next free start date instead.
        if (confirmed && result.conflict) {
          for (let offset = 1; offset <= 60 && result.conflict; offset += 1) {
            const candidate = addDays(startDate, offset);
            let candidateResult = this.plans.loadAsPlans(actorId, scheme.id, candidate, false, { stops: progressStops });
            if (candidateResult.progressConflict && candidateResult.confirmationToken) {
              candidateResult = this.plans.loadAsPlans(actorId, scheme.id, candidate, false, {
                stops: progressStops, confirmed: true, confirmationToken: candidateResult.confirmationToken,
              });
            }
            result = candidateResult;
            effectiveDate = candidate;
          }
        }
        if (result.conflict || result.progressConflict) {
          if (result.confirmationToken) this.pendingLoads.set(this.pendingLoadKey(actorId, scheme.id, effectiveDate), {
            schemeId: scheme.id,
            startDate: effectiveDate,
            token: result.confirmationToken,
          });
          return { handled: true, reply: `「${scheme.name}」与现有安排有冲突。请明确说“确认载入${scheme.name}”，我会顺延到不冲突的日期。` };
        }
        this.pendingLoads.delete(key);
        this.pendingLoads.delete(this.pendingLoadKey(actorId, scheme.id, effectiveDate));
        const moved = effectiveDate !== startDate ? `，原日期已有安排，已顺延到${effectiveDate}` : '';
        return { handled: true, reply: `已把「${scheme.name}」载入${effectiveDate}起的计划${moved}。`, refresh: ['plans'], date: effectiveDate };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '方案载入失败，请稍后再试。' };
      }
    }

    const removePlace = text.match(/(?:从|在)?(?:今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})?(?:的)?(?:计划|安排)\s*(?:中(?:的)?|里(?:的)?)?(?:移除|删除|去掉)\s*[「“]?(.+?)[」”]?$/)
      || text.match(/^(?:移除|删除|去掉)\s*(?:今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})?(?:的)?(?:计划|安排)(?:中(?:的)?|里(?:的)?)?\s*[「“]?(.+?)[」”]?$/);
    if (removePlace) {
      const name = removePlace[1].trim();
      const target = this.findPlan(actorId, text, date, name);
      if (!target) return { handled: true, reply: `没有找到${date}的日计划。` };
      const targetDate = target.localDate || date;
      const existingStops = (target.stops || []) as Array<Record<string, unknown>>;
      const removed = existingStops.filter(stop => stopName(stop).includes(name));
      if (!removed.length) return { handled: true, reply: `计划里没有找到「${name}」。` };
      const removedIds = new Set(removed.map(stop => String(stop.stopId || '')));
      const stops = existingStops.filter(stop => !removedIds.has(String(stop.stopId || '')));
      const routeLegs = (target.routeLegs || []).filter((leg: any) => !removedIds.has(String(leg?.fromStopId || '')) && !removedIds.has(String(leg?.toStopId || '')));
      try {
        this.plans.update(actorId, target.id, { name: target.name, localDate: target.localDate, timezone: target.timezone, snapshot: { stops, routeLegs, plannedCharges: target.plannedCharges || [] } });
        return { handled: true, reply: `已从${targetDate}计划移除「${removed.map(stopName).join('、')}」。`, refresh: ['plans'], date: targetDate };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '移除地点失败，请检查当前进度。' };
      }
    }

    // 进度动作允许自然说法："完成游览武康大楼"、"结束武康大楼的游览"、
    // "到达徐家汇书院"。动作先归一化，再交给同一条 execution 队列处理。
    const suffixCompletion = text.match(/^(?:游览|参观|逛)\s*(.+?)\s*(?:完成|结束|完毕)$/);
    if (suffixCompletion) text = `完成${suffixCompletion[1]}`;
    const inPlaceCompletion = text.match(/^(?:在|于)\s*(.+?)\s*(?:完成|结束)(?:游览|参观)?$/);
    if (inPlaceCompletion) text = `完成${inPlaceCompletion[1]}`;
    const startVisit = text.match(/^(?:开始|现在开始|我开始)\s*(?:游览|参观|逛)\s*(?:地点)?\s*[「“]?(.+?)[」”]?$/);
    if (startVisit) text = `到达${startVisit[1]}`;
    const progress = text.match(/^(?:我(?:已经|已)?\s*)?(?:开始\s*)?(出发|前往|到达|到了|到|完成|完成游览|结束游览|结束|跳过|中止)(?:地点)?\s*(?:去|前往)?\s*(?:游览)?\s*[「“]?(.+?)[」”]?(?:的)?(?:游览)?[了啦]?$/);
    if (progress) {
      const typeWord = progress[1] || '';
      const type = typeWord === '出发' || typeWord === '前往' ? 'depart'
        : typeWord === '到达' || typeWord === '到了' || typeWord === '到' ? 'arrive'
          : typeWord === '完成' || typeWord === '完成游览' || typeWord === '结束游览' || typeWord === '结束' ? 'complete'
            : typeWord === '跳过' ? 'skip' : 'abort';
      const target = this.findPlan(actorId, text, date);
      if (!target) return { handled: true, reply: `今天还没有计划，请先告诉我“安排今天去${progress[2]}”。` };
      const targetName = progress[2].trim();
      const matches = (target.stops || []).filter(value => stopName(value).includes(targetName)) as PlanStop[];
      // Progress belongs to a visit. Prefer the active visit, then the next
      // planned visit; a completed earlier visit must not shadow a revisit.
      const active = matches.find(value => type === 'arrive' ? value.status === 'en_route'
        : type === 'complete' ? value.status === 'visiting'
          : type === 'abort' ? ['en_route', 'visiting'].includes(value.status || '') : false);
      const stop = active || matches.find(value => !value.status || value.status === 'planned') || matches[0];
      if (!stop || typeof stop.stopId !== 'string') return { handled: true, reply: `今天计划里没有找到「${targetName}」。` };
      try {
        this.plans.recordExecution(actorId, target.id, { stopId: stop.stopId, type, occurredAt: this.now(), expectedRevision: target.revision });
        const actionLabel = type === 'arrive' ? '到达' : typeWord;
        return { handled: true, reply: `已记录「${stopName(stop)}」${actionLabel}。`, refresh: ['plans'], date };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '进度记录失败，请检查当前计划。' };
      }
    }

    const timeToken = '(?:\\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})';
    const timeEdit = text.match(new RegExp(`^(?:请\\s*)?(?:把|将)\\s*[「“]?(.+?)[」”]?\\s*(?:(?:的)?时间\\s*)?(?:安排|调整|改到|改为|设为|排在|定在)\\s*(?:到|为|在)?\\s*(下午|晚上|上午|早上|中午)?\\s*(${timeToken})(?::(\\d{2})|点(?:\\s*(${timeToken})\\s*分?)?)`))
      || text.match(new RegExp(`^[「“]?(.+?)[」”]?\\s*(?:(?:的)?时间\\s*)?(?:安排|调整|改到|改为|设为|排在|定在)\\s*(?:到|为|在)?\\s*(下午|晚上|上午|早上|中午)?\\s*(${timeToken})(?::(\\d{2})|点(?:\\s*(${timeToken})\\s*分?)?)`));
    if (timeEdit) {
      const targetName = timeEdit[1].trim();
      const minutes = parseTime(timeEdit[0]);
      const target = this.findPlan(actorId, text, date, targetName);
      if (minutes === null) return { handled: true, reply: '时间格式没看懂，请使用“15:00”或“下午3点”。' };
      if (!target) return { handled: true, reply: `没有找到${date}的日计划。` };
      const targetDate = target.localDate || date;
      const stops = structuredClone(target.stops || []) as Array<Record<string, unknown>>;
      const matchingIndexes = stops.map((stop, index) => ({ stop, index }))
        .filter(({ stop }) => stopName(stop).includes(targetName) && (!stop.status || stop.status === 'planned'));
      if (matchingIndexes.length > 1) return { handled: true, reply: `「${targetName}」有多次待进行的到访，请在“计划与进度”中选择具体那次调整时间。`, refresh: ['plans'], date: targetDate };
      const index = matchingIndexes[0]?.index ?? stops.findIndex(stop => stopName(stop).includes(targetName));
      if (index < 0) return { handled: true, reply: `计划里没有找到「${targetName}」。` };
      const duration = Number(stops[index].plannedDurationMinutes || stops[index].minDurationMinutes || DEFAULT_DURATION);
      const previous = stops[index - 1];
      const previousEnd = previous
        ? Number(previous.departureMinutes ?? previous.endMinutes ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY;
      // 调整时间时先吸附到上一站结束后的可用时刻，避免“合法调整”
      // 仍因前后节点重叠被服务端拒绝。
      const effectiveMinutes = Math.max(minutes, Number.isFinite(previousEnd) ? previousEnd + DEFAULT_TRAVEL_BUFFER : minutes);
      stops[index] = { ...stops[index], plannedArrivalMinutes: effectiveMinutes, startMinutes: effectiveMinutes, endMinutes: effectiveMinutes + duration, departureMinutes: effectiveMinutes + duration };
      // 调整后顺排后续未执行地点，避免自然语言改时间制造重叠。
      for (let i = index + 1; i < stops.length; i += 1) {
        const previous = stops[i - 1];
        const current = stops[i];
        if (current.status && current.status !== 'planned') continue;
        const currentDuration = Number(current.plannedDurationMinutes || current.minDurationMinutes || DEFAULT_DURATION);
        const nextStart = Number(previous.departureMinutes || previous.endMinutes || effectiveMinutes + duration) + DEFAULT_TRAVEL_BUFFER;
        stops[i] = { ...current, plannedArrivalMinutes: nextStart, startMinutes: nextStart, endMinutes: nextStart + currentDuration, departureMinutes: nextStart + currentDuration };
      }
      try {
        this.plans.update(actorId, target.id, { name: target.name, localDate: target.localDate, timezone: target.timezone, snapshot: { stops, routeLegs: target.routeLegs || [], plannedCharges: target.plannedCharges || [] } });
        const adjustedNotice = effectiveMinutes === minutes ? '' : `（前一站结束后可用时间为${displayTime(effectiveMinutes)}）`;
        return { handled: true, reply: `已把「${targetName}」调整到${displayTime(effectiveMinutes)}${adjustedNotice}（${targetDate}），后续地点已自动顺排。`, refresh: ['plans'], date: targetDate };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '时间调整失败，请检查进度。' };
      }
    }

    const durationToken = '(?:\\d+(?:\\.\\d+)?|[零〇一二两俩三四五六七八九十]{1,3})';
    const planningIntent = /^(?:安排|计划|规划|生成|创建|做|制定|设计|今天|明天|后天|下周末|本周末|这周末|周末|下周|周|星期|去|游览|参观|打卡)/.test(text);
    const durationEdit = !planningIntent
      ? (text.match(new RegExp(`(?:把|将)\s*[「“]?(.+?)[」”]?\s*(?:停留|游览|逛)\s*(${durationToken})\s*(小时|分钟?)`))
        || text.match(new RegExp(`^[「“]?(.+?)[」”]?\s*(?:停留|游览|逛)\s*(${durationToken})\s*(小时|分钟?)$`)))
      : null;
    if (durationEdit) {
      const targetName = durationEdit[1].trim();
      const parsedDuration = durationEdit[2].includes('.') ? Number(durationEdit[2]) : parseInteger(durationEdit[2]);
      const minutes = durationEdit[3].startsWith('小时')
        ? Math.max(15, Math.round(Number(parsedDuration || 0) * 60))
        : Math.max(15, Number(parsedDuration || 0));
      const target = this.findPlan(actorId, text, date, targetName);
      if (!target) return { handled: true, reply: `没有找到${date}的日计划。` };
      const targetDate = target.localDate || date;
      const stops = structuredClone(target.stops || []) as Array<Record<string, unknown>>;
      const matchingIndexes = stops.map((stop, index) => ({ stop, index }))
        .filter(({ stop }) => stopName(stop).includes(targetName) && (!stop.status || stop.status === 'planned'));
      if (matchingIndexes.length > 1) return { handled: true, reply: `「${targetName}」有多次待进行的到访，请在“计划与进度”中选择具体那次调整停留时长。`, refresh: ['plans'], date: targetDate };
      const index = matchingIndexes[0]?.index ?? stops.findIndex(stop => stopName(stop).includes(targetName));
      if (index < 0) return { handled: true, reply: `计划里没有找到「${targetName}」。` };
      const original = stops[index];
      const start = Number(original.startMinutes ?? original.plannedArrivalMinutes ?? DEFAULT_START);
      stops[index] = {
        ...original,
        minDurationMinutes: minutes,
        plannedDurationMinutes: minutes,
        endMinutes: start + minutes,
        departureMinutes: start + minutes,
      };
      for (let i = index + 1; i < stops.length; i += 1) {
        const previous = stops[i - 1];
        const current = stops[i];
        if (current.status && current.status !== 'planned') continue;
        const currentDuration = Number(current.plannedDurationMinutes || current.minDurationMinutes || DEFAULT_DURATION);
        const nextStart = Number(previous.departureMinutes || previous.endMinutes || start + minutes) + DEFAULT_TRAVEL_BUFFER;
        stops[i] = { ...current, plannedArrivalMinutes: nextStart, startMinutes: nextStart, endMinutes: nextStart + currentDuration, departureMinutes: nextStart + currentDuration };
      }
      try {
        this.plans.update(actorId, target.id, { name: target.name, localDate: target.localDate, timezone: target.timezone, snapshot: { stops, routeLegs: target.routeLegs || [], plannedCharges: target.plannedCharges || [] } });
        return { handled: true, reply: `已把「${targetName}」调整为停留${minutes}分钟（${targetDate}），后续地点已自动顺延。`, refresh: ['plans'], date: targetDate };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '停留时间调整失败，请检查当前进度。' };
      }
    }

    const schemeMatch = text.match(/(?:生成|创建|规划|安排|做|制定|设计)(?:一个|一份)?\s*(?:(\d+|[一二三四五六七八九十两俩])\s*(?:天|日))?\s*(?:的)?\s*(?:旅行|旅游)?(?:方案|行程)\s*[:：]?\s*(.*)$/);
    if (schemeMatch && /方案|行程/.test(text)) {
      const days = schemeMatch[1] ? parseDayCount(`${schemeMatch[1]}天`) : parseDayCount(text);
      if (days < 1 || days > 30) return { handled: true, reply: '方案支持 1–30 天，请调整天数后再保存。原安排未改动。' };
      // A single sentence may both create a scheme and request an import:
      // “生成两天方案并载入明天：武康大楼、龙华寺”.  The load directive is
      // metadata, not a POI name, so remove it before resolving places.
      const placeText = (schemeMatch[2] || text)
        .replace(/(?:并|然后|再|同时)?\s*(?:载入|导入|加入|放入)(?:计划)?\s*(?:从|于)?\s*(?:今天|明天|后天|下周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})?\s*[:：]?/g, ' ');
      const grouped = explicitDayGroups(placeText);
      const groupedPlaces: Array<{ dayIndex: number; places: Array<NonNullable<Awaited<ReturnType<PlaceProvider['detail']>>>> }> = [];
      if (grouped.length) {
        for (const group of grouped) {
          const resolved = await this.resolvePlaces(group.text);
          if (resolved.error || !resolved.places.length) {
            return { handled: true, reply: resolved.error || `第 ${group.dayIndex + 1} 天还没有识别到地点。` };
          }
          groupedPlaces.push({ dayIndex: group.dayIndex, places: resolved.places });
        }
      }
      const found = grouped.length
        ? { places: groupedPlaces.flatMap(group => group.places) }
        : await this.resolvePlaces(placeText);
      if (found.error || !found.places.length) return { handled: true, reply: found.error || '请告诉我方案里想去哪些地点。' };
      const selectedPlaces = pace && !grouped.length && !looksLikeExplicitPlaceList(placeText)
        ? found.places.slice(0, 2)
        : found.places;
      const explicitDuration = parseRequestedDuration(text);
      const maxExplicitDay = groupedPlaces.reduce((max, group) => Math.max(max, group.dayIndex + 1), 0);
      if (maxExplicitDay > 30) return { handled: true, reply: '方案支持 1–30 天，请核对每个日期分组。原安排未改动。' };
      const dayStops: Array<{ dayIndex: number; stops: PlanStop[]; routeLegs: unknown[]; plannedCharges: unknown[] }> = Array.from({ length: Math.max(1, Math.min(30, Math.max(days, maxExplicitDay))) }, (_, dayIndex) => ({ dayIndex, stops: [], routeLegs: [], plannedCharges: [] }));
      const placeGroups = grouped.length
        ? groupedPlaces
        : [{ dayIndex: 0, places: selectedPlaces }];
      let roundRobinIndex = 0;
      for (const group of placeGroups) {
        for (const place of group.places) {
          const day = grouped.length
            ? dayStops[Math.min(group.dayIndex, dayStops.length - 1)]
            : dayStops[roundRobinIndex++ % dayStops.length];
          const duration = explicitDuration ?? (Number(place.suggestedDurationMinutes) || DEFAULT_DURATION);
          const previous = day.stops.at(-1);
          const start = previous
            ? Number(previous.departureMinutes ?? previous.endMinutes ?? DEFAULT_START) + DEFAULT_TRAVEL_BUFFER
            : DEFAULT_START;
          day.stops.push(stopFor(place, start, duration));
        }
      }
      for (const day of dayStops) day.routeLegs = await this.routeLegs(day.stops);
      const baseName = this.schemeName(text, selectedPlaces);
      const existingNames = new Set(this.plans.list(actorId).map(item => item.name));
      let name = baseName;
      for (let suffix = 2; existingNames.has(name); suffix += 1) name = `${baseName} ${suffix}`;
      try {
        const saved = this.plans.save(actorId, { name, kind: 'scheme', cityCode: CITY_CODE, timezone: TIMEZONE, days: dayStops }, 'current');
        // “生成方案并载入明天”是一个完整意图，成功生成后直接展开为日计划；
        // 如果目标日期已有安排，保留方案并把冲突交给下一句确认，避免半成功状态。
        const wantsLoad = /载入|导入|加入计划|放入计划/.test(text);
        if (wantsLoad) {
          const loadDate = parseDate(text, this.now()) || date;
          const loaded = this.plans.loadAsPlans(actorId, saved.id, loadDate, false, { stops: this.progressStops(actorId) });
          if (loaded.conflict || loaded.progressConflict) {
            if (loaded.confirmationToken) this.pendingLoads.set(this.pendingLoadKey(actorId, saved.id, loadDate), {
              schemeId: saved.id,
              startDate: loadDate,
              token: loaded.confirmationToken,
            });
            return { handled: true, reply: `已生成「${name}」，但${loadDate}已有安排。请回复“确认载入${name}”，我会自动顺延到不冲突的日期。`, refresh: ['plans'], date: loadDate };
          }
          return { handled: true, reply: `已生成「${name}」并载入${loadDate}起的计划，共${dayStops.length}天。`, refresh: ['plans'], date: loadDate };
        }
        return { handled: true, reply: `已生成「${name}」，共${dayStops.length}天，包含${selectedPlaces.length}个地点。`, refresh: ['plans'] };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '方案保存失败，请换一个名称。' };
      }
    }

    const arrange = text.match(/^(?:(?:安排|计划|规划|生成)(?:今天|明天|后天|下周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2})?|(?:今天|明天|后天|下周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2}日?)|(?:去|游览|参观|打卡))\s*(?:去|游览|参观|打卡)?\s*(.*)$/);
    const planQueryPattern = /^(?:计划与进度|今天计划|明天计划|后天计划|今天安排|明天安排|后天安排|我今天(?:有什么|的)?(?:安排|计划|行程)|我明天(?:有什么|的)?(?:安排|计划|行程)|我后天(?:有什么|的)?(?:安排|计划|行程)|(?:查看|看看|看一下|打开|显示|列出|告诉我)(?:今天|明天|后天|当前)(?:的|有(?:什么)?)?(?:安排|计划|行程)|(?:今天|明天|后天)(?:安排|计划|行程)(?:了)?(?:什么)?|(?:今天|明天|后天)(?:有|的)?(?:什么)?(?:安排|计划|行程)|(?:我的)?(?:日程|行程)|\d{1,2}月\d{1,2}[日号]计划)$/;
    const isPlanQuery = planQueryPattern.test(text) || /^(?:\u4eca\u5929|\u660e\u5929|\u540e\u5929)(?:\u5b89\u6392|\u8ba1\u5212|\u884c\u7a0b)(?:\u4e86)?(?:\u4ec0\u4e48|\u6709|\u5185\u5bb9)?$/.test(text);
    if (arrange && arrange[1] && !isPlanQuery) {
      const found = await this.resolvePlaces(arrange[1]);
      if (found.error || !found.places.length) return { handled: true, reply: found.error || '请告诉我想安排哪些地点。' };
      const selectedPlaces = pace && !looksLikeExplicitPlaceList(arrange[1])
        ? found.places.slice(0, 2)
        : found.places;
      const explicitDuration = parseRequestedDuration(text);
      const existing = this.plans.list(actorId).find(item => item.kind === 'plan' && planDate(item) === date);
      const currentStops = existing ? structuredClone(existing.stops || []) as PlanStop[] : [];
      // Repeated destinations are intentional visits with fresh stop IDs.
      const placesToAdd = selectedPlaces;
      const occupied = currentStops.reduce((max, stop) => Math.max(max, Number(stop.departureMinutes || stop.endMinutes || DEFAULT_START)), DEFAULT_START - DEFAULT_TRAVEL_BUFFER);
      let start = currentStops.length ? occupied + DEFAULT_TRAVEL_BUFFER : (parseTime(text) ?? DEFAULT_START);
      if (date === dateKey(new Date(this.now()))) start = Math.max(start, localMinutes(this.now()) + 10);
      const addedStopIds = new Set<string>();
      for (const place of placesToAdd) {
        const duration = explicitDuration ?? (Number(place.suggestedDurationMinutes) || DEFAULT_DURATION);
        const stop = stopFor(place, start, duration);
        addedStopIds.add(stop.stopId);
        currentStops.push(stop);
        start += duration + DEFAULT_TRAVEL_BUFFER;
      }
      try {
        const generatedLegs = await this.routeLegs(currentStops) as Array<Record<string, unknown>>;
        const generatedPairs = new Set(generatedLegs.map(leg => `${String(leg.fromStopId)}>${String(leg.toStopId)}`));
        // Keep any user or provider route that could not be regenerated, but
        // replace the affected pairs so appending a stop always adds its leg.
        const preservedLegs = (existing?.routeLegs || []).filter(leg => {
          if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return false;
          const item = leg as Record<string, unknown>;
          return !generatedPairs.has(`${String(item.fromStopId)}>${String(item.toStopId)}`);
        });
        const routeLegs = [...preservedLegs, ...generatedLegs];
        if (existing) {
          this.plans.update(actorId, existing.id, { name: existing.name, localDate: existing.localDate, timezone: existing.timezone, snapshot: { stops: currentStops, routeLegs, plannedCharges: existing.plannedCharges || [] } });
        } else {
          this.plans.save(actorId, { name: `${date} 日计划`, kind: 'plan', cityCode: CITY_CODE, timezone: TIMEZONE, localDate: date, snapshot: { stops: currentStops, routeLegs, plannedCharges: [] } }, 'current');
        }
        // Saving can carry stops into another dated plan. Report only this
        // request's fresh stop IDs, including visits merged into an existing day.
        const arrangedByDate = new Map<string, string[]>();
        for (const plan of this.plans.list(actorId)) {
          if (plan.kind !== 'plan' || !plan.localDate) continue;
          const names = (plan.stops as PlanStop[]).filter(stop => addedStopIds.has(stop.stopId)).map(stopName);
          if (names.length) arrangedByDate.set(plan.localDate, [...(arrangedByDate.get(plan.localDate) || []), ...names]);
        }
        const arranged = [...arrangedByDate].sort(([left], [right]) => left.localeCompare(right));
        const carriedDates = arranged.filter(([actualDate]) => actualDate !== date).map(([actualDate]) => actualDate);
        const summary = arranged.map(([actualDate, names]) => `${actualDate}：${names.map(name => `「${name}」`).join('、')}`).join('；');
        return {
          handled: true,
          reply: `已安排${summary}。${carriedDates.length ? `因时间跨过午夜，已从${date}顺延至${carriedDates.join('、')}。` : ''}`,
          refresh: ['plans'], date: arranged[0]?.[0],
        };
      } catch (error) {
        return { handled: true, reply: error instanceof Error ? error.message : '日计划保存失败。' };
      }
    }

    if (/^(?:(?:查看|打开|列出)\s*)?(?:我的)?方案(?:候选)?$/.test(text)) {
      const schemes = this.plans.list(actorId).filter(item => item.kind === 'scheme');
      return { handled: true, reply: schemes.length
        ? `方案候选有${schemes.length}个：${schemes.slice(0, 8).map(item => `「${item.name}」`).join('、')}${schemes.length > 8 ? '等。' : '。'}`
        : '还没有方案候选，可以说“生成两天方案：武康大楼、龙华寺”。', refresh: ['plans'] };
    }

    if (planQueryPattern.test(text)) {
      const visible = this.plans.list(actorId);
      const dated = visible.filter(item => item.kind === 'plan' && item.localDate);
      const schemes = visible.filter(item => item.kind === 'scheme');
      const selected = dated.filter(item => item.localDate === date);
      const stops = selected.flatMap(item => (item.stops || []).map(stop => ({
        name: stopName(stop),
        start: Number((stop as PlanStop).startMinutes ?? (stop as PlanStop).plannedArrivalMinutes),
        status: (stop as PlanStop).status,
      }))).filter(item => item.name);
      const details = stops.length
        ? `：${stops.slice(0, 12).map(item => `${Number.isFinite(item.start) ? `${displayTime(item.start)} ` : ''}${item.name}${item.status === 'completed' ? '（已完成）' : item.status === 'visiting' ? '（游览中）' : item.status === 'en_route' ? '（前往中）' : ''}`).join('、')}${stops.length > 12 ? '等' : ''}`
        : '，暂无待进行地点';
      return { handled: true, reply: `${date}有${selected.length}份计划${details}。方案候选有${schemes.length}个。`, refresh: ['plans'], date };
    }

    if (/^(?:(?:查看|打开|浏览)\s*)?(?:我的\s*)?(?:旅行)?记忆(?:列表)?$/.test(text)) {
      const memories = this.memories.list(actorId);
      return { handled: true, reply: memories.length
        ? `共有${memories.length}条旅行记忆：${memories.slice(0, 6).map(item => `「${item.title || item.userText.slice(0, 24)}」`).join('、')}${memories.length > 6 ? '等。' : '。'}`
        : '还没有旅行记忆，可以说“记下：今天在武康大楼看了夕阳”。', refresh: ['memories'] };
    }

    return { handled: false, reply: '' };
  }

  private schemeName(text: string, places: Array<NonNullable<Awaited<ReturnType<PlaceProvider['detail']>>>>): string {
    const named = text.match(/(?:叫|名为|名称是)\s*[「“]?([^」”：:]+)[」”]?/);
    return named?.[1]?.trim() || `${places[0]?.name || '旅行'}路线`;
  }

  private async routeLegs(stops: PlanStop[]): Promise<unknown[]> {
    const legs: unknown[] = [];
    for (let index = 1; index < stops.length; index += 1) {
      const from = stops[index - 1].place;
      const to = stops[index].place;
      if (!from?.coordinates || !to?.coordinates) continue;
      try {
        const dataMode = this.routes.providerName === 'demo_route_estimator' ? 'demo' : 'online';
        const result = await this.routes.plan({ origin: from, destination: to, transportMode: 'walking', cityCode: CITY_CODE, dataMode });
        if (result.leg) legs.push({ ...result.leg, legId: `agent_leg_${randomUUID().replaceAll('-', '').slice(0, 16)}`, fromStopId: stops[index - 1].stopId, toStopId: stops[index].stopId });
      } catch { /* route estimation is helpful but never blocks plan creation */ }
    }
    return legs;
  }

  private findPlan(actorId: string, text: string, date: string, placeName = ''): SavedPlan | null {
    const plans = this.plans.list(actorId).filter(item => item.kind === 'plan');
    const quoted = text.match(/[「“]([^」”]+)[」”]/)?.[1]?.trim();
    // If the user names a date, never fall through to another day's plan just
    // because it contains the same place. This keeps “删除今天计划中的…” and
    // time edits scoped to the date the user actually selected.
    const explicitDate = /今天|今日|明天|明日|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2}/.test(text);
    const byPlace = placeName
      ? plans.filter(item => (item.stops || []).some(stop => stopName(stop).includes(placeName)))
        .sort((left, right) => String(left.localDate || '').localeCompare(String(right.localDate || '')))
      : [];
    return plans.find(item => quoted && item.name === quoted)
      || byPlace.find(item => item.localDate === date)
      || (!explicitDate ? byPlace[0] : null)
      || plans.find(item => item.localDate === date)
      || null;
  }

  private async resolvePlaces(text: string): Promise<{ places: Array<NonNullable<Awaited<ReturnType<PlaceProvider['detail']>>>>; error?: string }> {
    const query = stripPlanningClock(cleanText(text))
      .replace(/(?:安排|计划|规划|生成|创建|做|制定|设计|一个|旅行|旅游|方案|行程|今天|明天|后天|下周末|本周末|这周末|周末|下周[一二三四五六日天]|(?:周|星期)[一二三四五六日天]|今日|明日|去|游览|逛|参观|打卡|每个地方|各|取消收藏|收藏|地点|的|共\d+天|载入|导入|加入计划|放入计划|并|然后|再|同时)/g, ' ')
      .replace(/[一二三四五六七八九十两俩]\s*天/g, ' ')
      .replace(/(?:(?:\d+(?:\.\d+)?|[零〇一二两俩三四五六七八九十]{1,3})\s*个?\s*半?\s*(?:小时|分钟?)|半小时)/g, ' ')
      .replace(/(?:下午|晚上|上午|早上|中午)?\s*(?:\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})(?::\d{2}|点(?:\s*(?:\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})\s*分?)?)/g, ' ')
      .replace(/[，,、+和及以及与]/g, '|');
    let names = query.split('|').map(item => item.trim()).filter(item => item.length >= 2 && !/^(?:的|地方|地点|方案)$/.test(item));
    // 先从本区目录中识别完整地点名。这样“安排徐汇一日游”不会把整句话
    // 当成一个 POI 关键词，而是能直接选出平台目录中的一组可用地点。
    let catalog: Array<NonNullable<Awaited<ReturnType<PlaceProvider['detail']>>>> = [];
    const genericRequest = /徐汇|一日游|两日游|三日游|玩一天|逛一天|city\s*walk|路线|景点|旅行|旅游|附近|安静|文化|美食|公园|亲子|推荐/i.test(text);
    if (genericRequest || !names.length) {
      try {
        const result = await this.places.search({ cityCode: CITY_CODE, districtAdcode: DISTRICT_CODE, limit: 50 });
        catalog = result.places;
      } catch { /* 目录不可用时继续走关键词搜索，给出明确的供应商错误。 */ }
      if (catalog.length) {
        const mentioned = catalog.filter(place => text.includes(place.name));
        if (mentioned.length && names.length <= 1) {
          return { places: mentioned.map(place => place) };
        }
        // An explicit list may contain A → B → A. Resolve each occurrence
        // in order instead of collapsing it into unique catalog entries.
        if (genericRequest && !mentioned.length) names = [];
      }
    }
    if (!names.length) {
      if (!catalog.length) return { places: [], error: '暂时无法读取徐汇地点目录，请稍后再试。' };
      const requestedDays = text.match(/(\d+)\s*天/);
      const maxPlaces = Math.min(catalog.length, Math.max(3, Math.min(8, (requestedDays ? Number(requestedDays[1]) : 1) * 4)));
      return { places: catalog.slice(0, maxPlaces) };
    }
    const resolved: Array<NonNullable<Awaited<ReturnType<PlaceProvider['detail']>>>> = [];
    for (const name of names) {
      const result = await this.places.search({ cityCode: CITY_CODE, districtAdcode: DISTRICT_CODE, query: name, limit: 10 });
      const exact = result.places.filter(place => place.name === name);
      const candidates = exact.length ? exact : result.places.filter(place => place.name.includes(name) || name.includes(place.name));
      if (candidates.length === 0) return { places: [], error: `没有找到「${name}」，请换一个地点名称。` };
      if (candidates.length > 1 && !exact.length) return { places: [], error: `「${name}」有多个匹配地点，请说完整名称。` };
      const detail = await this.places.detail(candidates[0].placeId);
      if (detail) resolved.push(detail);
    }
    return { places: resolved };
  }
}
