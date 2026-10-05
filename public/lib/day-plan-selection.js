/** Shared date and next-step selection; display never changes execution facts. */
import { dateKeyInTimeZone } from './format.js';
import { hasOvernightActiveStop } from './plan-execution-window.js';

export function validPlanDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  const instant = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date;
}

export function availableDayPlans(plans = [], now = new Date()) {
  return plans.filter(plan => {
    if (plan.kind !== 'plan' || !validPlanDate(plan.localDate)) return false;
    return plan.localDate >= dateKeyInTimeZone(now, plan.timezone || 'Asia/Shanghai') || hasOvernightActiveStop(plan, now);
  });
}

export function canViewPlanDate(date, plans = [], now = new Date()) {
  if (!validPlanDate(date)) return false;
  if (date >= dateKeyInTimeZone(now)) return true;
  return availableDayPlans(plans, now).some(plan => plan.localDate === date);
}

export function companionTarget(plans = [], preferredId = '', now = new Date()) {
  const available = availableDayPlans(plans, now);
  const activePlans = available.filter(plan => plan.stops?.some(stop => ['en_route', 'visiting'].includes(stop.status)));
  const activeCount = activePlans.reduce((count, plan) => count + plan.stops.filter(stop => ['en_route', 'visiting'].includes(stop.status)).length, 0);
  if (activeCount > 1) return { phase: 'conflict', plan: null, next: null, canExecute: false, reason: '存在多个进行中地点，请先核对进度。' };
  const preferred = available.find(plan => plan.id === preferredId);
  const todayPlans = available.filter(plan => plan.localDate === dateKeyInTimeZone(now, plan.timezone || 'Asia/Shanghai'));
  const plan = activePlans[0] || preferred || todayPlans[0] || available.slice().sort((a, b) => a.localDate.localeCompare(b.localDate))[0];
  if (!plan) return { phase: 'empty', plan: null, next: null, canExecute: false };
  if (available.filter(item => item.localDate === plan.localDate).length > 1) {
    return { phase: 'conflict', plan, next: null, canExecute: false, reason: `${plan.localDate} 有多份日计划，请先处理重复安排。` };
  }
  const stops = plan.stops || [];
  const next = stops.find(stop => ['en_route', 'visiting'].includes(stop.status)) || stops.find(stop => (stop.status || 'planned') === 'planned') || null;
  const phase = next ? ({ planned: 'ready', en_route: 'travel', visiting: 'visit' }[next.status || 'planned']) : 'finished';
  const canExecute = plan.localDate === dateKeyInTimeZone(now, plan.timezone || 'Asia/Shanghai') || hasOvernightActiveStop(plan, now);
  return { plan, next, phase, canExecute, isEarlier: plan.localDate < dateKeyInTimeZone(now, plan.timezone || 'Asia/Shanghai') };
}
