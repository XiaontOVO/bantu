import { dateKeyInTimeZone } from './format.js';

/** A plan-time cue, not an arrival or departure fact. Only an active visit may produce it. */
export function sceneTimingCandidate(plan, stop, placeId, now = new Date()) {
  if (!plan?.id || plan.kind !== 'plan' || !stop?.stopId || stop.status !== 'visiting' ||
      (stop.placeId || stop.place?.placeId) !== placeId || !Number.isInteger(stop.endMinutes) ||
      stop.endMinutes < 0 || stop.endMinutes > 2879 || !/^\d{4}-\d{2}-\d{2}$/.test(plan.localDate || '')) return null;
  try {
    const zone = plan.timezone || 'Asia/Shanghai';
    const today = dateKeyInTimeZone(now, zone);
    const elapsedDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${plan.localDate}T00:00:00Z`)) / 86400000);
    if (!Number.isInteger(elapsedDays) || elapsedDays < 0 || elapsedDays > 1) return null;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const clockMinute = Number(parts.find(part => part.type === 'minute')?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(clockMinute)) return null;
    const remainingMinutes = stop.endMinutes - (elapsedDays * 1440 + hour * 60 + clockMinute);
    if (remainingMinutes > 20 || remainingMinutes < -30) return null;
    return {
      key: `${plan.id}:${stop.stopId}:${plan.revision || 0}`,
      remainingMinutes,
      text: remainingMinutes > 0
        ? `按原计划，这一站约 ${remainingMinutes} 分钟后结束。想让我根据剩余时间帮你选重点或调整后续吗？`
        : '原计划的结束时间已过。要我核对后续安排，并帮你按现在的节奏调整吗？',
    };
  } catch { return null; }
}
