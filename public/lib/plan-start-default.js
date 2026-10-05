import { dateKeyInTimeZone } from './format.js';

/** A dated day plan starts in the future; reusable schemes keep their own noon template. */
export function dailyFirstStopMinutes(date, timezone = 'Asia/Shanghai', now = new Date()) {
  if (date !== dateKeyInTimeZone(now, timezone)) return 9 * 60;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const partNumber = type => Number(parts.find(part => part.type === type)?.value || 0);
  return Math.max(9 * 60, Math.ceil((partNumber('hour') * 60 + partNumber('minute') + 1) / 30) * 30);
}
