import type { ServerContext } from '../server/http/context.js';
import type { PlanStop } from '../domain/types.js';
import { getStopStart, getStopEnd } from '../domain/normalize.js';
import { companionProtectedIds } from './companion-advice.js';

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** A pause changes the schedule, without pretending to locate the user or invent a road. */
export function restAgentPlan(ctx: ServerContext, actorId: string, args: Record<string, unknown>) {
  const minutes = Number(args.minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) throw new Error('休息时长应为 5–120 分钟。');
  const plan = ctx.planLibrary.list(actorId).find(item => item.id === args.planId);
  if (!plan || plan.kind !== 'plan') throw new Error('请先读取并选定日计划；方案请先载入日期。');
  if (plan.revision !== args.expectedRevision) throw new Error('计划已变化，请重新读取最新版本。');
  const stops = structuredClone(plan.stops) as PlanStop[];
  const protectedIds = companionProtectedIds(plan);
  const pending = stops.filter(stop => (stop.status || 'planned') === 'planned');
  if (!pending.length) throw new Error('没有待进行的地点；当前到访进度由你自己确认结束。');
  if (pending.some(stop => protectedIds.has(stop.stopId))) throw new Error('后续有预约、必留、锁时或付款保护，不能整体顺延；请说明哪些弹性地点可调整。');
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: plan.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ctx.now()));
  const part = (key: string) => now.find(item => item.type === key)!.value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const currentMinute = Number(part('hour')) * 60 + Number(part('minute'));
  const delay = plan.localDate === today ? Math.max(minutes, currentMinute + minutes - getStopStart(pending[0])) : minutes;
  const changes = pending.map(stop => {
    const before = getStopStart(stop), finish = getStopEnd(stop);
    if (!Number.isFinite(before) || !Number.isFinite(finish) || finish + delay > 1440) throw new Error('休息后安排会跨日，请先调整后续地点或日期。');
    for (const field of ['startMinutes', 'plannedArrivalMinutes', 'plannedStartMinutes', 'endMinutes', 'departureMinutes', 'plannedDepartureMinutes', 'travelStartMinutes'] as const) {
      if (typeof stop[field] === 'number') stop[field] += delay;
    }
    return { stopId: stop.stopId, name: stop.place?.name || '地点', beforeMinutes: before, afterMinutes: before + delay,
      startTime: clock(before + delay), endTime: clock(finish + delay) };
  });
  ctx.planLibrary.update(actorId, plan.id, { name: plan.name, localDate: plan.localDate, timezone: plan.timezone, expectedRevision: Number(args.expectedRevision), snapshot: { stops, routeLegs: structuredClone(plan.routeLegs || []), plannedCharges: structuredClone(plan.plannedCharges || []) } });
  // Return the execution projection, not the editable snapshot whose statuses are normalized.
  const saved = ctx.planLibrary.list(actorId).find(item => item.id === plan.id)!;
  return { saved: true, locationKnown: false, minutes, delayMinutes: delay, changes, plan: saved,
    scheduleSummary: changes.map(change => `${change.name}：游览开始 ${change.startTime}，结束 ${change.endTime}`).join('；'),
    warnings: ['只安排休息时间，未确定用户实际休息位置；已顺延待进行安排并保留已有道路，交通时间未实时重新估算，开放情况以现场为准。'] };
}
