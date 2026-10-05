/** Return reasons to confirm an unusually long or overnight departure before recording progress. */
export function departureReview(minutes, mode, now = new Date(), timezone = 'Asia/Shanghai') {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const read = type => Number(parts.find(part => part.type === type)?.value || 0);
  const arrival = read('hour') * 60 + read('minute') + minutes;
  const overnight = arrival >= 1440 && arrival % 1440 < 6 * 60;
  const longWalk = mode === 'walking' && minutes > 90;
  if (!overnight && !longWalk) return null;
  return { overnight, longWalk, minutes: Math.ceil(minutes), arrivalMinutes: arrival };
}
