/**
 * 本地时间工具。
 *
 * 约定：领域内部计划时间一律使用“旅行当地当天从 00:00 起的分钟数”。
 * 对外展示时再格式化为 HH:mm。真实事件使用带时区 ISO 字符串。
 */
export type Minutes = number;

/** 解析 "HH:mm" 为分钟数；非法输入返回 null。 */
export function parseTime(value: string): Minutes | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 从 HH:mm、ISO 时间戳或数字中取当天分钟数。 */
export function parseClockValue(value: string | number | null | undefined): Minutes | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    if (value <= 24 * 60) return value;
    if (value <= 24 * 60 * 60) return value / 60;
    return null;
  }
  const direct = parseTime(value);
  if (direct !== null) return direct;
  const clock = /T(\d{2}):(\d{2})/.exec(value) ?? /^(\d{2}):(\d{2})/.exec(value);
  if (!clock) return null;
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 分钟数格式化为 "HH:mm"；按 24 小时循环，避免跨午夜操作出现负数。 */
export function formatMinutes(value: Minutes): string {
  const safe = Math.max(0, Math.floor(value));
  const hour = Math.floor(safe / 60) % 24;
  const minute = safe % 60;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

export function addMinutes(value: Minutes, delta: Minutes): Minutes {
  return value + delta;
}

export function minutesBetween(later: Minutes, earlier: Minutes): Minutes {
  return later - earlier;
}

/** 判断一个 [start,end] 是否完全位于 area 内；允许 end === area.end。 */
export function isWithinRange(
  value: { startMinutes: Minutes; endMinutes: Minutes },
  area: { startMinutes: Minutes; endMinutes: Minutes },
): boolean {
  if (value.endMinutes < value.startMinutes) return false;
  return value.startMinutes >= area.startMinutes && value.endMinutes <= area.endMinutes;
}

/** 两个半开区间 [start,end) 是否相交。 */
export function overlaps(
  a: { startMinutes: Minutes; endMinutes: Minutes },
  b: { startMinutes: Minutes; endMinutes: Minutes },
): boolean {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

export function rangeDuration(range: { startMinutes: Minutes; endMinutes: Minutes }): Minutes {
  return Math.max(0, range.endMinutes - range.startMinutes);
}

export interface FeasibleStart {
  startMinutes: Minutes;
  endMinutes: Minutes;
  waitingMinutes: Minutes;
  interval?: { startMinutes: Minutes; endMinutes: Minutes };
  reasonCode?: string;
}

/**
 * docs/02 §8.2 的 earliestFeasibleStart：
 * 从按时间排序的营业区间中寻找能容纳完整停留的最早开始时间。
 * 没有营业限制时退化为 max(arrival, earliestStart)；资料缺失由调用方决定 unknown。
 */
export function findEarliestFeasibleStart(
  arrivalMinutes: Minutes,
  durationMinutes: Minutes,
  options: {
    earliestStartMinutes?: Minutes | null;
    latestStartMinutes?: Minutes | null;
    latestArrivalMinutes?: Minutes | null;
    openingIntervals?: readonly { startMinutes: Minutes; endMinutes: Minutes }[] | null;
  } = {},
): FeasibleStart | null {
  if (
    !Number.isFinite(arrivalMinutes) ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes < 0
  ) {
    return null;
  }
  const earliest = options.earliestStartMinutes ?? arrivalMinutes;
  const latestArrival = options.latestArrivalMinutes ?? Number.POSITIVE_INFINITY;
  const latestStart = options.latestStartMinutes ?? Number.POSITIVE_INFINITY;

  const intervals = options.openingIntervals
    ? [...options.openingIntervals]
        .filter((item) => Number.isFinite(item.startMinutes) && Number.isFinite(item.endMinutes))
        .sort((a, b) => a.startMinutes - b.startMinutes)
    : [];

  if (intervals.length === 0) {
    const startMinutes = Math.max(arrivalMinutes, earliest);
    const endMinutes = startMinutes + durationMinutes;
    if (startMinutes > latestStart || startMinutes > latestArrival) return null;
    return {
      startMinutes,
      endMinutes,
      waitingMinutes: Math.max(0, startMinutes - arrivalMinutes),
    };
  }

  for (const interval of intervals) {
    const startMinutes = Math.max(arrivalMinutes, earliest, interval.startMinutes);
    if (startMinutes > latestStart || startMinutes > latestArrival) continue;
    const endMinutes = startMinutes + durationMinutes;
    if (endMinutes <= interval.endMinutes) {
      return {
        startMinutes,
        endMinutes,
        waitingMinutes: Math.max(0, startMinutes - arrivalMinutes),
        interval: { ...interval },
      };
    }
  }
  return null;
}

/** 预约等待不重复计算缓冲：arrival 是已经包含交通缓冲的到达时刻。 */
export function waitingBefore(startMinutes: Minutes, arrivalMinutes: Minutes): Minutes {
  return Math.max(0, startMinutes - arrivalMinutes);
}

export function maxTime(values: readonly (number | null | undefined)[]): Minutes | null {
  const finite = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  return finite.length === 0 ? null : Math.max(...finite);
}
