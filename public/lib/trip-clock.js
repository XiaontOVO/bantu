import { state } from './store.js';
import { refreshPlaceOpeningLabel } from './place-opening.js';

/** 服务端时间为基准，使用单调计时推进，避免用户设备时钟偏差。 */
export function currentTripClock() {
  const anchor = state.trip?.clock;
  if (!anchor) return null;
  const elapsed = Math.max(0, performance.now() - (state.clockReceivedAt ?? performance.now()));
  const now = new Date(Date.parse(anchor.now) + elapsed);
  const timezone = state.trip.snapshot.timezone || 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = name => parts.find(item => item.type === name)?.value || '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  return { date, minutes: Number(part('hour')) * 60 + Number(part('minute')), timezone,
    text: `${date} ${part('hour')}:${part('minute')}`,
    relation: anchor.travelDate < date ? 'past' : anchor.travelDate > date ? 'future' : 'today' };
}

export function checkStartTime(start) {
  const clock = currentTripClock();
  if (clock?.relation === 'past' || (clock?.relation === 'today' && start < clock.minutes)) {
    throw new Error('新安排不能早于当前时间，请选择之后的时段。');
  }
}

export function refreshClockLabels() {
  refreshPlaceOpeningLabel();
  // 顶栏胶囊显示「当前时间 · 定位地点」：时间是设备当前时间，地点在反查成功后显示；
  // 反查不可用时保留定位过程的占位文案（geoAppbarText），定时刷新不得清掉它。
  const appbarTime = document.getElementById('appbarTime');
  const appbarPlace = document.getElementById('appbarPlace');
  if (appbarTime) {
    const now = new Date();
    appbarTime.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
  if (appbarPlace) appbarPlace.textContent = state.geoLabel || state.geoAppbarText || '';
  const clock = currentTripClock();
  const label = document.getElementById('trip-clock');
  if (label) label.textContent = clock ? `当前时间 ${clock.text} · ${clock.timezone}` : '正在同步系统时间';
}
