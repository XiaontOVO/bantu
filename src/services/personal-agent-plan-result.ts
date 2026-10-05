import type { ServerContext } from '../server/http/context.js';

/** The storage snapshot contains baseline statuses; tools must expose replayed progress. */
export function projectAgentPlanResult(ctx: ServerContext, actorId: string, tool: string, value: unknown): unknown {
  if (!tool.startsWith('plans.') && !tool.startsWith('progress.')) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string' && (record.kind === 'plan' || record.kind === 'scheme')) {
    const current=ctx.planLibrary.list(actorId).find(plan => plan.id === record.id);
    if(current&&tool==='plans.set_transport'&&record.transportSelection&&typeof record.transportSelection==='object') {
      const selection=record.transportSelection as Record<string,unknown>;
      const stops=current.kind==='scheme'?current.days?.find(day=>day.dayIndex===selection.dayIndex)?.stops:current.stops;
      const stop=stops?.find((stop:any)=>stop.stopId===selection.stopId) as any;
      return {...current,transportSelection:{...selection,applied:stop?.preferredTransportMode===selection.mode,...(current.revision!==record.revision?{routeStatus:'needs_recheck'}:{})}};
    }
    return current || value;
  }
  if (tool === 'plans.load' && Array.isArray(record.plans)) {
    const plans = ctx.planLibrary.list(actorId);
    return { ...record, plans: record.plans.map(plan => plans.find(current => current.id === plan?.id) || plan) };
  }
  return value;
}
