import { fmtWithDay, dateKeyInTimeZone } from './format.js';
import { routeTravelMinutes } from './plan-route-timing.js';

/** Actual visit facts, with superseded corrections and aborted attempts excluded. */
export function completedVisitLabel(stop, snapshot) {
  const events = snapshot?.executionEvents || [];
  const replaced = new Set(events.map(event => event.correctsEventId).filter(Boolean));
  const effective = events.filter(event => event.stopId === stop.stopId && !replaced.has(event.executionEventId))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || String(a.recordedAt || '').localeCompare(String(b.recordedAt || '')));
  let arrival = null, completion = null;
  for (const event of effective) {
    const timestamp = Date.parse(event.occurredAt);
    if (!Number.isFinite(timestamp)) continue;
    const status = event.correctsEventId && event.statusOverride ? event.statusOverride
      : ({ arrive: 'visiting', complete: 'completed', depart: 'en_route', abort: 'planned', skip: 'skipped' })[event.type];
    if (status === 'visiting') {
      if (arrival === null || event.type === 'arrive') arrival = timestamp;
      completion = null;
    }
    else if (status === 'completed') completion = timestamp;
    else if (['planned', 'en_route', 'skipped'].includes(status)) { arrival = null; completion = null; }
  }
  if (completion === null) return '实际完成时间未记录';
  const timezone = snapshot?.timezone || 'Asia/Shanghai';
  const baseDate = snapshot?.localDate || dateKeyInTimeZone(new Date(arrival ?? completion), timezone);
  const minute = timestamp => {
    const instant = new Date(timestamp);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(instant);
    const days = Math.round((Date.parse(`${dateKeyInTimeZone(instant, timezone)}T00:00:00Z`) - Date.parse(`${baseDate}T00:00:00Z`)) / 86400000);
    return days * 1440 + Number(parts.find(part => part.type === 'hour').value) * 60 + Number(parts.find(part => part.type === 'minute').value);
  };
  if (arrival === null || arrival > completion) return `${fmtWithDay(minute(completion))} 完成 · 到达时间未记录`;
  const duration = (completion - arrival) / 60000;
  return `${fmtWithDay(minute(arrival))} - ${fmtWithDay(minute(completion))} · ${duration < 1 ? '不足 1 分钟' : `${Math.floor(duration)} 分钟`}`;
}
/** 卡片时间摘要：只显示这一站的窗口（开始出发 - 离开），不为缺失的路线编造交通时间。 */
export function itineraryTimeLabel(stop, snapshot) {
  const timing = itineraryTiming(stop, snapshot);
  const start = Number.isFinite(stop.startMinutes) ? stop.startMinutes : timing.arrival;
  const leave = Number.isFinite(timing.leave) ? timing.leave : null;
  if (start === null && leave === null) return '时间待定';
  if (start === null) return `${fmtWithDay(leave)} 离开`;
  if (leave === null) return `${fmtWithDay(start)} 出发`;
  return `${fmtWithDay(start)}出发 - ${fmtWithDay(leave)}离开`;
}

// 事件按计划时区与归属日期换算，跨午夜仍保留“次日”的绝对分钟。
function minuteOfDay(iso, snapshot, stop) {
  const time = new Date(iso);
  if (!Number.isNaN(time.getTime())) {
    const timezone = snapshot?.timezone || 'Asia/Shanghai';
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(time);
    const h = Number(parts.find(part => part.type === 'hour')?.value), m = Number(parts.find(part => part.type === 'minute')?.value);
    const date = dateKeyInTimeZone(time, timezone), base = stop?.date || snapshot?.localDate || snapshot?.travelDate || date;
    const offset = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${base}T00:00:00Z`)) / 86400000);
    if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(offset)) return offset * 1440 + h * 60 + m;
  }
  return null;
}

export function itineraryTiming(stop, snapshot) {
  const stops = (snapshot?.stops || []).filter(item => item.status !== 'skipped');
  const index = stops.findIndex(item => item.stopId === stop.stopId);
  const previous = index > 0 ? stops[index - 1] : null;
  const leg = (snapshot?.routeLegs || []).find(item => item.toStopId === stop.stopId && (!stop.preferredTransportMode || item.transportMode === stop.preferredTransportMode) && (previous
    ? item.fromStopId === previous.stopId
    : !(snapshot?.stops || []).some(origin => origin.stopId === item.fromStopId)));
  const legMinutes = routeTravelMinutes(leg);
  // 服务端在用户出发时按当前位置和所选交通方式重新估算；没有路线结果时保持未知。
  const autoMinutes = Number.isFinite(stop.estimatedTravelMinutes) && stop.estimatedTravelMinutes > 0 ? stop.estimatedTravelMinutes : null;
  const leave = stop.actualCompletionMinutes ?? stop.forecastEndMinutes ?? stop.departureMinutes ?? stop.endMinutes;
  // 已经点过「出发」且仍在进行中的站点：出发时间用实际记录，不再显示「待定」。
  const useActualDepart = stop.status === 'en_route' || stop.status === 'visiting';
  // 前往中的路线起点已经变成实时定位；旧计划路段不能盖过刚生成的实走路线估时。
  const minutes = useActualDepart ? autoMinutes : legMinutes ?? autoMinutes;
  const events = snapshot?.executionEvents || [];
  const replaced = new Set(events.map(event => event.correctsEventId).filter(Boolean));
  let actualDepartMinute = null, actualArriveMinute = null;
  for (const event of events.filter(event => event.stopId === stop.stopId && !replaced.has(event.executionEventId))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))) {
    const status = event.correctsEventId && event.statusOverride ? event.statusOverride
      : ({depart:'en_route',arrive:'visiting',complete:'completed',abort:'planned',skip:'skipped'})[event.type];
    if (['planned','skipped'].includes(status)) { actualDepartMinute = null; actualArriveMinute = null; }
    else if (status === 'en_route') { actualDepartMinute = minuteOfDay(event.occurredAt, snapshot, stop); actualArriveMinute = null; }
    else if (status === 'visiting' && (actualArriveMinute === null || event.type === 'arrive')) actualArriveMinute = minuteOfDay(event.occurredAt, snapshot, stop);
  }
  if (!useActualDepart) actualDepartMinute = null;
  // 已到达/已完成的站点：到达时间用「到达」事件的实际记录，取代「出发+交通时长」的预测值。
  if (Number.isFinite(stop.actualArrivalMinutes)) actualArriveMinute = stop.actualArrivalMinutes;
  if (!['visiting','completed'].includes(stop.status)) actualArriveMinute = null;
  // 第一站没有上一站：有交通时长按计划到达倒推出发，没有就按计划的游览开始时间，不再显示「待定」。
  const plannedStart = stop.forecastStartMinutes ?? stop.plannedArrivalMinutes ?? stop.startMinutes;
  const plannedDeparture = stop.plannedTravelStartMinutes ?? (previous ? previous.forecastEndMinutes ?? previous.departureMinutes ?? previous.endMinutes
    : minutes !== null ? Math.max(0, plannedStart - minutes) : plannedStart);
  const estimate = actualDepartMinute ?? stop.travelStartMinutes ?? plannedDeparture;
  const departure = Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
  // 到达：已点「到达」用实际时间；否则有交通时长按出发+时长预测；没有路线时按游览开始时间估计。
  const arrivalEstimated = minutes === null && actualArriveMinute === null;
  const estimatedArrival = departure !== null ? (plannedStart ?? null) : null;
  const predictedArrival = departure !== null && minutes !== null ? departure + minutes : estimatedArrival;
  const arrival = actualArriveMinute ?? predictedArrival;
  return {departure: departure !== null && departure >= 0 ? departure : null, arrival, arrivalEstimated, leave, minutes,
    // estimated：耗时来自出发时的自动估算而非人工路线；arrivalIsForecast：到达时刻是预测值（尚无「到达」事件）。
    estimated: useActualDepart ? autoMinutes !== null : legMinutes === null && autoMinutes !== null,
    arrivalIsForecast: arrival !== null && actualArriveMinute === null,
    mode: useActualDepart ? stop.estimatedTransportMode : leg?.transportMode ?? (autoMinutes !== null ? stop.estimatedTransportMode : undefined), isFirst: index === 0,
    departureConflict: departure !== null && previous != null && departure < (previous.departureMinutes ?? previous.endMinutes),
    overlap: arrival !== null && !arrivalEstimated && arrival > stop.startMinutes, waiting: arrival !== null && !arrivalEstimated ? Math.max(0,stop.startMinutes-arrival) : 0};
}
