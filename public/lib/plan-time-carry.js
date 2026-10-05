import { fitPlanStopTime } from './plan-time-constraints.js';
import { carryPlaceTarget } from './plan-carry-target.js';

const carriedStart = stop => [stop.startMinutes, stop.plannedStartMinutes, stop.plannedArrivalMinutes].find(Number.isFinite);
const carriedFields = ['travelStartMinutes', 'plannedArrivalMinutes', 'startMinutes', 'plannedStartMinutes',
  'endMinutes', 'departureMinutes', 'plannedDepartureMinutes'];
const sameCarryDayRoutes = (day, stops) => {
  const offsets = new Map(stops.map(stop => [stop.stopId, Math.floor(carriedStart(stop) / 1440)]));
  return (day.routeLegs || []).filter(leg => {
    if (['origin', 'my-location'].includes(leg.fromStopId) && offsets.get(leg.toStopId) > 0) return false;
    return offsets.has(leg.fromStopId) && offsets.has(leg.toStopId)
      ? offsets.get(leg.fromStopId) === offsets.get(leg.toStopId) : true;
  });
};

/** Fit the source queue, then append every carried visit after its destination queue.
 * Keep each destination's existing facts/windows intact and capture the dates being written.
 */
export function fitDatedPlanStopTime(day, stopId, requestedStart, requestedDuration, plans = []) {
  let fitted = fitPlanStopTime(day, stopId, requestedStart, requestedDuration);
  const virtualPlans = structuredClone(plans);
  const destinations = new Map();
  for (let index = 0; index < fitted.stops.length; index++) {
    let stop = fitted.stops[index];
    let start = carriedStart(stop);
    if ((stop.status && stop.status !== 'planned') || !(start >= 1440)) continue;
    const duration = stop.endMinutes - start;
    const target = carryPlaceTarget({ baseDate:day.localDate, start, duration,
      intervals:stop.place?.openingIntervals || [], plans:virtualPlans });
    if (target.start !== start) {
      fitted = fitPlanStopTime({ ...day, stops:fitted.stops, routeLegs:sameCarryDayRoutes(day, fitted.stops) },
        stop.stopId, target.start, duration);
      stop = fitted.stops[index]; start = carriedStart(stop);
      if (start !== target.start || stop.endMinutes - start !== duration) {
        throw new Error('接续日期与后续固定安排冲突，请调整固定安排后重新核对；本次修改尚未保存。');
      }
    }
    const offset = Math.floor(start / 1440);
    const normalized = { ...stop };
    delete normalized.date;
    for (const field of carriedFields) if (Number.isFinite(normalized[field])) normalized[field] = Math.max(0, normalized[field] - offset * 1440);
    let destination = destinations.get(target.date);
    if (!destination) {
      const original = plans.find(plan => plan.kind === 'plan' && plan.localDate === target.date);
      destination = { date:target.date, planName:original?.name || `${target.date} 日计划`,
        existingStops:structuredClone(original?.stops || []), stops:[],
        expected:{ localDate:target.date, planId:original?.id || null, expectedRevision:original ? original.revision || 0 : null } };
      destinations.set(target.date, destination);
    }
    destination.stops.push(normalized);
    let virtualTarget = virtualPlans.find(plan => plan.kind === 'plan' && plan.localDate === target.date);
    if (!virtualTarget) { virtualTarget = { kind:'plan', localDate:target.date, stops:[] }; virtualPlans.push(virtualTarget); }
    virtualTarget.stops.push(normalized);
  }
  const edited = fitted.stops.find(stop => stop.stopId === stopId);
  const start = carriedStart(edited), duration = edited.endMinutes - start;
  const routeLegs = sameCarryDayRoutes(day, fitted.stops);
  const retainedLegs = new Set(routeLegs.map(leg => leg.legId));
  const plannedCharges = (day.plannedCharges || []).filter(charge => {
    if (!charge.routeLegRef || retainedLegs.has(charge.routeLegRef)) return true;
    if ((charge.paymentStatus ?? charge.status) !== 'unpaid') {
      throw new Error('跨日调整影响已支付或尚未核对的交通费用，请先核对费用关联；本次修改尚未保存。');
    }
    return false;
  });
  const adjusted = fitted.stops.filter(stop => stop.stopId !== stopId && (() => {
    const original = day.stops.find(item => item.stopId === stop.stopId);
    return carriedStart(original) !== carriedStart(stop) || original.endMinutes !== stop.endMinutes;
  })());
  return { ...fitted, start, duration, adjusted, routeLegs, plannedCharges, corrected:start !== requestedStart || duration !== requestedDuration,
    destinations:[...destinations.values()], expectedCarryTargets:[...destinations.values()].map(destination => destination.expected) };
}
