import { randomUUID } from 'node:crypto';
import type { ServerContext } from '../server/http/context.js';
import type { SavedPlanDay } from './plan-library.js';
import type { PlanStop, RouteLeg, PlannedCharge } from '../domain/types.js';

/** Copy design data only. Execution facts and payment facts stay on the source. */
export function copyAgentScheme(ctx: ServerContext, actorId: string, name: string, sourceIds: string[]) {
  if (!name.trim() || !sourceIds.length || sourceIds.length > 30 || new Set(sourceIds).size !== sourceIds.length) throw new Error('请提供名称和不重复的来源计划 ID。');
  const sources = sourceIds.map(id => ctx.planLibrary.get(actorId, id));
  const days: SavedPlanDay[] = [];
  for (const source of sources) {
    for (const day of source.kind === 'scheme' ? source.days || [] : [source]) {
      const stops = structuredClone(day.stops) as PlanStop[];
      const stopIds = new Map(stops.map(s => [s.stopId, `stop_${randomUUID()}`]));
      for (const stop of stops) {
        stop.stopId = stopIds.get(stop.stopId)!;
        stop.status = 'planned';
        delete stop.date;
        delete stop.baseRevision;
      }
      const routeLegs = structuredClone(day.routeLegs) as RouteLeg[];
      const routeIds = new Map(routeLegs.map(l => [l.legId, `leg_${randomUUID()}`]));
      for (const leg of routeLegs) {
        leg.legId = routeIds.get(leg.legId)!;
        leg.fromStopId = stopIds.get(leg.fromStopId) || leg.fromStopId;
        leg.toStopId = stopIds.get(leg.toStopId) || leg.toStopId;
        delete leg.departureAt;
      }
      const plannedCharges = structuredClone(day.plannedCharges || []) as PlannedCharge[];
      for (const charge of plannedCharges) {
        charge.chargeId = `charge_${randomUUID()}`;
        if (charge.stopId) charge.stopId = stopIds.get(charge.stopId) || charge.stopId;
        if (charge.routeLegRef) charge.routeLegRef = routeIds.get(charge.routeLegRef) || charge.routeLegRef;
        charge.paymentStatus = 'unpaid';
        delete charge.includedSpendEventId;
      }
      days.push({ dayIndex: days.length, stops, routeLegs, plannedCharges });
    }
  }
  if (!days.length || days.length > 30) throw new Error('复制后的方案应为 1 至 30 天。');
  return ctx.planLibrary.save(actorId, { name, kind: 'scheme', days, timezone: sources[0].timezone || 'Asia/Shanghai' }, 'draft');
}
