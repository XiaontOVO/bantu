/** 跨午夜的执行窗口，供页面展示与记录进度的日期校验共用。 */
import { dateKeyInTimeZone } from './format.js';

export function hasOvernightActiveStop(plan, now) {
  if (!plan?.localDate || !Array.isArray(plan.stops)) return false;
  const timezone = plan.timezone || 'Asia/Shanghai';
  const today = dateKeyInTimeZone(now, timezone);
  if (plan.localDate >= today) return false;
  const dayOffset = Math.round((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${plan.localDate}T00:00:00.000Z`)) / 86400000);
  if (!Number.isFinite(dayOffset) || dayOffset <= 0) return false;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    return false;
  }
  const hour = Number(parts.find(item => item.type === 'hour')?.value);
  const minute = Number(parts.find(item => item.type === 'minute')?.value);
  const absoluteNow = dayOffset * 1440 + hour * 60 + minute;
  return Number.isFinite(absoluteNow) && plan.stops.some(stop => {
    if (['completed', 'skipped'].includes(stop.status || '')) return false;
    if (['en_route', 'visiting'].includes(stop.status)) return true;
    const start = [stop.startMinutes, stop.plannedStartMinutes, stop.plannedArrivalMinutes, stop.plannedDepartureMinutes]
      .map(Number).find(Number.isFinite);
    const duration = [stop.plannedDurationMinutes, stop.minDurationMinutes,
      Number.isFinite(Number(stop.durationSeconds)) ? Number(stop.durationSeconds) / 60 : undefined]
      .map(Number).find(Number.isFinite);
    const end = Number.isFinite(Number(stop.endMinutes)) ? Number(stop.endMinutes) :
      (Number.isFinite(start) && Number.isFinite(duration) ? start + duration : NaN);
    return Number.isFinite(start) && Number.isFinite(end) && start <= absoluteNow && absoluteNow <= end;
  });
}
