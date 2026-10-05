import { incomingPlanRoute, routeTravelMinutes } from './plan-route-timing.js';

const startOf = stop => [stop.startMinutes, stop.plannedStartMinutes, stop.plannedArrivalMinutes].find(Number.isFinite);
const durationOf = stop => {
  const start = startOf(stop);
  return Number.isFinite(stop.endMinutes) && stop.endMinutes > start ? stop.endMinutes - start
    : [stop.plannedDurationMinutes, stop.minDurationMinutes, stop.place?.suggestedDurationMinutes].find(value => Number.isFinite(value) && value > 0) || 60;
};
const fixed = stop => stop.timeLocked || stop.lockTime || (stop.status && stop.status !== 'planned');
const travel = (day, previous, stop) => routeTravelMinutes(incomingPlanRoute(day, previous, stop)) ?? 0;

function setWindow(stop, start, duration) {
  stop.startMinutes = stop.plannedStartMinutes = stop.plannedArrivalMinutes = start;
  stop.endMinutes = stop.departureMinutes = stop.plannedDepartureMinutes = start + duration;
  stop.plannedDurationMinutes = duration;
  stop.minDurationMinutes = Math.min(stop.minDurationMinutes ?? duration, duration);
  if (Number.isFinite(stop.durationSeconds)) stop.durationSeconds = duration * 60;
  if (Number.isFinite(stop.minDurationSeconds)) stop.minDurationSeconds = Math.min(stop.minDurationSeconds, duration * 60);
}

/** Fit preferred visit times while preserving fixed windows and execution facts.
 * Unknown transport only supplies non-overlap bounds, never a claimed route ETA.
 */
export function fitPlanStopTime(day, stopId, requestedStart, requestedDuration) {
  const stops = (day.stops || []).map(stop => ({ ...stop }));
  const visits = stops.filter(stop => stop.status !== 'skipped');
  const index = visits.findIndex(stop => stop.stopId === stopId), edited = visits[index];
  if (!edited || (edited.status && edited.status !== 'planned')) throw new Error('该地点已有实际进度，请使用进度纠正入口。');
  const previous = visits[index - 1];
  const minimum = previous ? (startOf(previous) + durationOf(previous)) + travel(day, previous, edited) : 0;
  let limit = Infinity, anchor;
  let requiredAfter = 0;
  for (let next = index + 1; next < visits.length; next++) {
    requiredAfter += travel(day, visits[next - 1], visits[next]);
    if (fixed(visits[next])) { anchor = visits[next]; limit = startOf(anchor) - requiredAfter; break; }
    requiredAfter += durationOf(visits[next]);
  }
  if (!Number.isFinite(minimum) || Number.isNaN(limit) || limit - minimum < 15) {
    throw new Error(`「${anchor?.place?.name || anchor?.stopId || '固定安排'}」前没有足够的可用时段，请调整固定安排或移除地点；实际进度不会被改写。`);
  }
  const duration = Math.min(480, Math.max(15, Math.round(Number(requestedDuration) || durationOf(edited))), limit - minimum);
  const start = Math.max(minimum, Math.min(Math.max(0, Math.round(Number(requestedStart) || 0)), limit - duration));
  setWindow(edited, start, duration);
  const adjusted = [];
  let prior = edited;
  for (const stop of visits.slice(index + 1)) {
    const earliest = prior.endMinutes + travel(day, prior, stop);
    if (startOf(stop) < earliest) {
      if (fixed(stop)) throw new Error(`「${stop.place?.name || stop.stopId}」的固定时段或实际进度不能自动顺延。`);
      setWindow(stop, earliest, durationOf(stop));
      adjusted.push(stop);
    }
    prior = stop;
  }
  return { stops, start, duration, adjusted, minimum, anchor,
    corrected: start !== requestedStart || duration !== requestedDuration };
}
