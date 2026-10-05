import { formatTimeRange } from './format.js';

/** Daily catalog intervals describe reference hours, never live admission or closure. */
export function placeOpeningInfo(intervals, now = new Date()) {
  const ranges = (Array.isArray(intervals) ? intervals : []).flatMap(slot => {
    const start = slot?.startMinutes, end = slot?.endMinutes;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= 1440 || end < 0 || end > 2880 || start === end) return [];
    const finish = end < start ? end + 1440 : end;
    if (finish - start > 1440) return [];
    return [{ start, end: finish }];
  });
  if (!ranges.length) return { label: '开放时间待核实', within: null, hours: '暂无可靠时段资料' };
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minutes = Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
  const within = ranges.some(range => (minutes >= range.start && minutes < range.end) ||
    (minutes + 1440 >= range.start && minutes + 1440 < range.end));
  const allDay = ranges.some(range => range.end - range.start === 1440);
  return {
    label: allDay ? '全天时段 · 参考' : within ? '参考时段内' : '参考时段外', within,
    hours: ranges.map(range => range.end - range.start === 1440 ? '全天' : formatTimeRange(range.start, range.end)).join('、'),
  };
}

/** Update only the small status label; do not redraw the page or disturb an editor. */
export function refreshPlaceOpeningLabel(now = new Date()) {
  const label = document.getElementById('placeOpeningStatus');
  if (!label) return;
  let intervals;
  try { intervals = JSON.parse(label.dataset.openingIntervals); } catch { intervals = []; }
  const info = placeOpeningInfo(intervals, now);
  label.textContent = info.label;
  label.classList.toggle('green', info.within === true);
  label.classList.toggle('gray', info.within === null);
}
