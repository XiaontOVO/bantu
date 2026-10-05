import type {ServerContext} from '../server/http/context.js';
import type {PlanStop,TransportMode} from '../domain/types.js';

/** A preference write is independent of GPS and road availability. */
export function setAgentStopTransport(ctx:ServerContext,actorId:string,args:Record<string,unknown>) {
  const current=ctx.planLibrary.list(actorId).find(plan=>plan.id===args.planId);
  if(!current)throw new Error('计划不存在或不属于当前用户。');
  if(args.expectedRevision!==current.revision)throw new Error('计划已更新，请重新读取版本后调整。');
  if(!['walking','transit','driving'].includes(String(args.mode)))throw new Error('请选择有效交通方式。');
  const raw=structuredClone(ctx.planLibrary.get(actorId,current.id));
  const day=current.kind==='scheme'?current.days?.find(day=>day.dayIndex===args.dayIndex):current;
  const target=raw.kind==='scheme'?raw.days?.find(day=>day.dayIndex===args.dayIndex):raw;
  if(!day||!target)throw new Error('请指定有效的方案天数。');
  const displayed=day.stops.find((item:any)=>item.stopId===args.stopId) as PlanStop|undefined;
  const stop=target.stops.find((item:any)=>item.stopId===args.stopId) as PlanStop|undefined;
  if(!stop||!displayed)throw new Error('本次到访不存在，请重新读取计划。');
  if(!['planned','en_route'].includes(displayed.status || 'planned'))throw new Error('只能修改尚未到达地点的交通选择，真实进度保持原样。');
  stop.preferredTransportMode=args.mode as TransportMode;
  delete stop.estimatedTravelMinutes;delete stop.estimatedTransportMode;
  const saved=ctx.planLibrary.update(actorId,raw.id,{name:raw.name,localDate:raw.localDate,timezone:raw.timezone,expectedRevision:args.expectedRevision,
    ...(raw.kind==='scheme'?{days:raw.days}:{snapshot:{stops:raw.stops,routeLegs:raw.routeLegs,plannedCharges:raw.plannedCharges}})});
  return {...ctx.planLibrary.list(actorId).find(plan=>plan.id===saved.id)!,transportSelection:{stopId:stop.stopId,mode:args.mode,dayIndex:args.dayIndex,applied:true,routeStatus:day.stops.filter((item:any)=>item.status!=='skipped').findIndex((item:any)=>item.stopId===stop.stopId)===0||displayed.status==='en_route'?'needs_current_location':'needs_route'}};
}
