/** 可核对的临时调整：有限候选、真实道路、版本绑定及显式应用。无需语言模型。 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PlanStop, RouteLeg, TransportMode } from '../domain/types.js';
import type { DemoPlace } from '../demo/demo-data.js';
import type { ServerContext } from '../server/http/context.js';
import { companionPlanSignature, type PlanLibraryService, type SavedPlan } from './plan-library.js';
import { usableAgentLocation } from './personal-agent-location.js';
import { CompanionContextError } from './companion-context.js';

type Change = 'rest' | 'rain' | 'time' | 'replace';
interface Preview {
  previewId: string; actorId: string; planId: string; revision: number; signature: string; expiresAt: string;
  params: { change: Change; minutes?: number; deadlineMinutes?: number; placeId?: string; targetStopId?: string; transportMode: TransportMode };
  title: string; warnings: string[]; stops: PlanStop[]; routeLegs: RouteLeg[]; plannedCharges: unknown[];
  changes: Array<{ name: string; before: string; after: string }>;
  impact: { endBefore: string; endAfter: string; roadMinutesAfter: number; roadMinutesBefore: number | null; protectedStops: number; fees: string };
  origin: { lat: number; lng: number; measuredAt?: number };
}
const previews = new WeakMap<PlanLibraryService, Map<string, Preview>>();
const start = (stop: PlanStop) => stop.startMinutes ?? stop.plannedStartMinutes ?? stop.plannedArrivalMinutes ?? NaN;
const end = (stop: PlanStop) => stop.endMinutes ?? stop.departureMinutes ?? stop.plannedDepartureMinutes ?? NaN;
const minimum = (stop: PlanStop) => stop.minDurationMinutes ?? (stop.minDurationSeconds == null ? 15 : stop.minDurationSeconds / 60);
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const range = (stop?: PlanStop) => stop ? `${stop.place?.name || '地点'} · ${clock(start(stop))}–${clock(end(stop))}` : '移除尚未开始的安排';
const indoor = (place: DemoPlace) => place.facilityCodes?.includes('indoor') === true && !place.facilityCodes.includes('outdoor');

function todayClock(now: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const value = (key: string) => parts.find(part => part.type === key)!.value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`, minute: Number(value('hour')) * 60 + Number(value('minute')) };
}

function ownedDay(ctx: ServerContext, actorId: string, id: string, revision: unknown) {
  const plans = ctx.planLibrary.list(actorId).filter(plan => plan.kind === 'plan');
  const view = plans.find(plan => plan.id === id);
  if (!view) throw new CompanionContextError('PLAN_NOT_FOUND', '计划已不存在，请重新选择。', 404);
  if (view.revision !== revision) throw new CompanionContextError('COMPANION_STALE', '计划或进度已变化，请重新预览。');
  if (plans.filter(plan => plan.localDate === view.localDate).length !== 1) throw new CompanionContextError('COMPANION_CONFLICT', '这天有重复计划，请先核对。');
  if (plans.some(plan => plan.id !== id && (plan.stops as PlanStop[]).some(stop => ['en_route', 'visiting'].includes(stop.status || 'planned')))) throw new CompanionContextError('COMPANION_CONFLICT', '请先收尾另一份仍在进行的安排。');
  if ((view.stops as PlanStop[]).filter(stop => ['en_route', 'visiting'].includes(stop.status || 'planned')).length > 1) throw new CompanionContextError('COMPANION_CONFLICT', '进行中地点冲突，请先核对进度。');
  if (view.localDate !== todayClock(ctx.now(), view.timezone || 'Asia/Shanghai').date) throw new CompanionContextError('COMPANION_DATE_CHANGED', '临时调整用于今天的后续安排。请先收尾旧行程，未来计划可到完整安排中编辑。');
  return view;
}

export function validateCompanionAdjustmentTarget(ctx: ServerContext, actorId: string, id: string, revision: unknown, stopId: unknown) {
  const plan = ownedDay(ctx, actorId, id, revision);
  const stops = plan.stops as PlanStop[];
  const next = stops.find(stop => ['en_route', 'visiting'].includes(stop.status || 'planned')) || stops.find(stop => (stop.status || 'planned') === 'planned');
  if (!next || next.stopId !== stopId) throw new CompanionContextError('COMPANION_STALE', '当前站点已变化，请从首页重新发起调整。');
  return plan;
}

export function companionProtectedIds(plan: SavedPlan) {
  const ids = new Set((plan.stops as PlanStop[]).filter(stop => stop.status && stop.status !== 'planned' || stop.retain || stop.retainStop || stop.lockTime || stop.timeLocked || stop.visitWindow).map(stop => stop.stopId));
  for (const event of plan.executionEvents || []) ids.add(event.stopId);
  const routes = plan.routeLegs as RouteLeg[];
  for (const value of plan.plannedCharges) {
    const charge = value as Record<string, unknown>;
    if (charge.paymentStatus !== 'paid' && charge.paymentStatus !== 'unknown') continue;
    if (charge.stopId) ids.add(String(charge.stopId));
    if (charge.routeLegRef) {
      const leg = routes.find(route => route.legId === charge.routeLegRef);
      if (!leg) throw new CompanionContextError('COMPANION_PAYMENT_UNKNOWN', '已付款或付款状态未知的费用无法关联到路线，请先核对。');
      ids.add(leg.fromStopId); ids.add(leg.toStopId);
    }
    if (!charge.stopId && !charge.routeLegRef) throw new CompanionContextError('COMPANION_PAYMENT_UNKNOWN', '存在无法关联的付款信息，请先核对费用后再调整。');
  }
  return ids;
}

export async function createCompanionAdvice(ctx: ServerContext, actorId: string, id: string, body: Record<string, unknown>) {
  const view = ownedDay(ctx, actorId, id, body.expectedRevision);
  const raw = ctx.planLibrary.get(actorId, id);
  const signature = companionPlanSignature(raw);
  const change = body.change as Change;
  const mode = body.transportMode as TransportMode;
  if (!['rest', 'rain', 'time', 'replace'].includes(change) || !['walking', 'transit', 'driving'].includes(mode)) throw new CompanionContextError('INVALID_INPUT', '请选择调整原因和交通方式。', 400);
  const params: Preview['params'] = { change, transportMode: mode };
  if (body.placeId !== undefined) {
    if (!['rain', 'replace'].includes(change) || typeof body.placeId !== 'string' || !body.placeId.trim()) throw new CompanionContextError('INVALID_INPUT', '替换地点无效。', 400);
    params.placeId = body.placeId;
  }
  if (body.targetStopId !== undefined) {
    if (!['rain', 'replace'].includes(change) || typeof body.targetStopId !== 'string' || !body.targetStopId.trim()) throw new CompanionContextError('INVALID_INPUT', '请指定有效的待进行到访。', 400);
    params.targetStopId = body.targetStopId;
  }
  if (change === 'rest') {
    if (!Number.isInteger(body.minutes) || Number(body.minutes) < 5 || Number(body.minutes) > 120) throw new CompanionContextError('INVALID_INPUT', '休息时长应为 5–120 分钟。', 400);
    params.minutes = Number(body.minutes);
  }
  if (change === 'time') {
    if (!Number.isInteger(body.deadlineMinutes) || Number(body.deadlineMinutes) <= todayClock(ctx.now(), view.timezone || 'Asia/Shanghai').minute || Number(body.deadlineMinutes) > 1439) throw new CompanionContextError('INVALID_INPUT', '请设置今天稍后的结束时间。', 400);
    params.deadlineMinutes = Number(body.deadlineMinutes);
  }
  const stops = view.stops as PlanStop[];
  const pending = stops.filter(stop => (stop.status || 'planned') === 'planned');
  if (!pending.length) return { candidates: [], reasons: ['没有尚未开始的安排。当前一站的真实进度请手动结束。'] };
  if (pending.length > 8) return { candidates: [], reasons: ['后续地点较多，请在完整安排中分段调整。'] };
  if (change === 'replace' && stops.some(stop => ['en_route', 'visiting'].includes(stop.status || 'planned'))) return { candidates: [], reasons: ['请先到达并结束，或明确中止当前出发，再替换下一站。'] };
  const locked = companionProtectedIds(view);
  const target = pending.find(stop => !locked.has(stop.stopId) && (!params.targetStopId || stop.stopId === params.targetStopId));
  if (params.targetStopId && !target) throw new CompanionContextError('INVALID_INPUT', '选定到访不在可调整的后续安排中，已有进度、预约和必留等保护不能绕过。', 400);
  if (!target && change !== 'rest') return { candidates: [], reasons: ['后续地点都有必留、预约、锁时、进度或付款保护，当前没有可自动调整的地点。'] };
  const provider = ctx.options.placeProvider || ctx.fallbackPlaceProvider;
  const road = ctx.options.routeProvider || ctx.fallbackRouteProvider;
  if (road.providerName === 'demo_route_estimator') return { candidates: [], reasons: ['当前只有演示路线。接入实际道路后才能核对调整影响。'] };
  const known = await Promise.all(stops.map(async stop => ({ stopId: stop.stopId, place: await provider.detail(stop.placeId || stop.place?.placeId || '', 'online').catch(() => null) })));
  const placeByStop = new Map(known.map(item => [item.stopId, item.place]));
  const fix = usableAgentLocation(body.position, ctx.now());
  const gps = fix && fix.accuracyMeters > 0 && Date.parse(ctx.now()) - fix.measuredAt >= 0 && Date.parse(ctx.now()) - fix.measuredAt <= 120000 ? fix : null;
  // 使用用户确认过的到达地点作具名起点；从不把它标成设备定位。
  const visited = [...stops].reverse().find(stop => ['visiting', 'completed'].includes(stop.status || 'planned'));
  const lastPlace = visited && placeByStop.get(visited.stopId);
  const origin = gps || lastPlace?.coordinates;
  if (!origin) return { candidates: [], reasons: ['需要有效设备定位或一个已由你确认到达的地点，才能核对调整后的道路。'] };
  const drafts: Array<{ title: string; stops: PlanStop[]; rest?: number }> = [];
  if (change === 'rest') drafts.push({ title: `先在原地休息 ${params.minutes} 分钟，再继续`, stops: structuredClone(stops), rest: params.minutes });
  if (change === 'time' && target) {
    const reducible = pending.filter(stop => !locked.has(stop.stopId) && end(stop) - start(stop) > minimum(stop));
    if (reducible.length) {
      const copies = structuredClone(stops);
      for (const stop of copies) if (reducible.some(item => item.stopId === stop.stopId)) {
        stop.plannedDurationMinutes = Math.max(minimum(stop), Math.floor((end(stop) - start(stop)) * .65));
        stop.endMinutes = start(stop) + stop.plannedDurationMinutes;
      }
      drafts.push({ title: '缩短可弹性安排的游览时间', stops: copies });
    }
    const removable = [...pending].reverse().filter(stop => !locked.has(stop.stopId));
    for (const item of removable.slice(0, 2)) drafts.push({ title: `这次暂不安排「${item.place?.name || '这站'}」`, stops: structuredClone(stops.filter(stop => stop.stopId !== item.stopId)) });
  }
  if ((change === 'rain' || change === 'replace') && target) {
    const center = placeByStop.get(target.stopId)?.coordinates || origin;
    const selected = params.placeId ? await provider.detail(params.placeId, 'online').catch(() => null) : null;
    if (params.placeId && (!selected?.coordinates || selected.cityCode !== view.cityCode || Math.hypot((selected.coordinates.lat-center.lat)*111000,(selected.coordinates.lng-center.lng)*111000*Math.cos(center.lat*Math.PI/180))>3000)) throw new CompanionContextError('INVALID_INPUT', '选定地点缺少有效坐标、超出同城附近范围或已不在目录，请重新查询。', 400);
    const found = params.placeId ? { places: selected ? [selected] : [] } : await provider.search({ actorId, cityCode: view.cityCode, center, radiusMeters: 3000, limit: 20, dataMode: 'online' }).catch(() => null);
    const existing = new Set(stops.map(stop => stop.placeId || stop.place?.placeId));
    const choices = (found?.places || []).filter(place => (!existing.has(place.placeId) || params.placeId && place.placeId !== (target.placeId || target.place?.placeId)) && place.coordinates && place.openingIntervals?.length && (change !== 'rain' || indoor(place))).slice(0, 3);
    for (const place of choices) {
      const copies = structuredClone(stops);
      const copy = copies.find(stop => stop.stopId === target.stopId)!;
      copy.placeId = place.placeId; copy.place = { placeId: place.placeId, name: place.name, coordinates: place.coordinates, facilityCodes: place.facilityCodes, cityCode: place.cityCode, evidenceIds: place.evidenceIds };
      placeByStop.set(`${target.stopId}:${place.placeId}`, place);
      const duration = Math.max(minimum(copy), Math.min(end(copy) - start(copy), place.suggestedDurationMinutes || 60));
      copy.plannedDurationMinutes = duration; copy.endMinutes = start(copy) + duration;
      drafts.push({ title: `${change === 'rain' ? '改去有室内标记的' : '下一站换成'}「${place.name}」`, stops: copies });
    }
  }
  const reasons = new Set<string>();
  if (change === 'rain' && target && placeByStop.get(target.stopId) && indoor(placeByStop.get(target.stopId)!)) reasons.add('下一站已有室内标记，你也可以保留原安排；仍需核实场馆开放。');
  const store = previews.get(ctx.planLibrary) || new Map<string, Preview>();
  previews.set(ctx.planLibrary, store);
  for (const [key, preview] of store) if (Date.parse(preview.expiresAt) < Date.parse(ctx.now())) store.delete(key);
  const candidates: Preview[] = [];
  // 同一预览批次的重复路段只查询一次。
  const routeCache = new Map<string, Promise<Awaited<ReturnType<ServerContext['estimateRoute']>>>>();
  for (const draft of drafts.slice(0, 3)) {
    try {
      let cursor = todayClock(ctx.now(), view.timezone || 'Asia/Shanghai').minute + (draft.rest || 0);
      if (visited?.status === 'visiting') cursor = Math.max(cursor, visited.forecastEndMinutes ?? end(visited));
      let previous = origin;
      let previousId = gps ? 'origin' : visited!.stopId;
      let roadMinutesAfter = 0;
      let roadValidUntil = Infinity;
      const routeLegs = (view.routeLegs as RouteLeg[]).filter(leg => !pending.some(stop => stop.stopId === leg.toStopId));
      const warnings = [gps ? '起点为当前设备定位。' : `起点为已确认到达的「${lastPlace!.name}」，请核对自己是否仍在此处。`, '开放时段来自地点目录，预约、临时闭馆与新门票费用仍需行前核实。', '道路按当前供应商估计，后续时段不含未来实时路况。'];
      for (const stop of draft.stops.filter(stop => (stop.status || 'planned') === 'planned')) {
        const place = placeByStop.get(`${stop.stopId}:${stop.placeId}`) || placeByStop.get(stop.stopId);
        if (!place?.coordinates) throw new Error('有后续地点坐标待核实，暂不能确认新路线。');
        const routeKey = JSON.stringify([previous, place.coordinates, mode]);
        if (!routeCache.has(routeKey)) routeCache.set(routeKey, ctx.estimateRoute({ origin: previous, destination: place, transportMode: mode, cityCode: view.cityCode }, 'online'));
        const result = await routeCache.get(routeKey)!;
        const leg = result.leg;
        const minutes = leg && (leg.durationMinutes ?? Number(leg.durationSeconds) / 60);
        if (!leg || result.error || result.departureSupport === 'demo' || leg.transportMode !== mode || !Number.isFinite(minutes) || minutes! < 0 || leg.expiresAt && Date.parse(leg.expiresAt) < Date.parse(ctx.now())) throw new Error('部分实际道路未能核对，暂不能确认调整。');
        roadMinutesAfter += minutes!;
        if (leg.expiresAt && Number.isFinite(Date.parse(leg.expiresAt))) roadValidUntil = Math.min(roadValidUntil, Date.parse(leg.expiresAt));
        const routeStart = Math.ceil(cursor + minutes! + Math.max(0, leg.bufferMinutes || 0));
        const old = pending.find(item => item.stopId === stop.stopId)!;
        const duration = stop.plannedDurationMinutes ?? end(stop) - start(stop);
        const earliest = Math.max(routeStart, draft.rest ? start(old) + draft.rest : change === 'rain' || change === 'replace' ? start(old) : 0);
        let arrival = earliest;
        if (locked.has(stop.stopId)) {
          if (arrival > start(old)) throw new Error('调整后可能赶不上受保护的预约、必留或已付款安排。');
          arrival = start(old);
        }
        if (!place.openingIntervals.length) throw new Error('后续开放时段未知，暂不能验证新安排。');
        const opening = place.openingIntervals.find(slot => Math.max(arrival, slot.startMinutes) + duration <= slot.endMinutes);
        if (!opening) throw new Error('调整后无法在目录开放时段内完成，请自行核对场馆。');
        arrival = Math.max(arrival, opening.startMinutes);
        if (locked.has(stop.stopId) && (arrival !== start(old) || duration !== end(old) - start(old))) throw new Error('这个调整会改变受保护安排，无法直接采用。');
        if (arrival + duration >= 1440) throw new Error('调整会跨入次日，请到完整安排中明确拆分日期。');
        if (!locked.has(stop.stopId)) {
          stop.startMinutes = arrival; stop.plannedStartMinutes = arrival; stop.plannedArrivalMinutes = arrival;
          stop.endMinutes = arrival + duration; stop.departureMinutes = arrival + duration; stop.plannedDepartureMinutes = arrival + duration;
          stop.plannedDurationMinutes = duration;
          stop.plannedTravelStartMinutes = arrival - Math.ceil(minutes! + Math.max(0, leg.bufferMinutes || 0));
          if (stop.durationSeconds !== undefined) stop.durationSeconds = duration * 60;
          delete stop.travelStartMinutes; delete stop.forecastStartMinutes; delete stop.forecastEndMinutes;
        }
        const originalLeg = (view.routeLegs as RouteLeg[]).find(item => item.fromStopId === previousId && item.toStopId === stop.stopId && item.transportMode === mode);
        const paidRoute = originalLeg && view.plannedCharges.some(value => { const charge = value as Record<string, unknown>; return charge.routeLegRef === originalLeg.legId && charge.paymentStatus !== 'unpaid'; });
        if (paidRoute) routeLegs.push(structuredClone(originalLeg));
        else routeLegs.push({ ...leg, legId: `companion_${randomUUID()}`, fromStopId: previousId, toStopId: stop.stopId, departureSupport: result.departureSupport as RouteLeg['departureSupport'] });
        cursor = arrival + duration; previous = place.coordinates; previousId = stop.stopId;
      }
      if (params.deadlineMinutes && cursor > params.deadlineMinutes) throw new Error('实际道路与保护条件下，尚不能在你要求的时间前结束。');
      const removedOrReplaced = new Set(pending.filter(old => !draft.stops.some(stop => stop.stopId === old.stopId && (stop.placeId || stop.place?.placeId) === (old.placeId || old.place?.placeId))).map(stop => stop.stopId));
      const routeIds = new Set(routeLegs.map(leg => leg.legId));
      const plannedCharges = view.plannedCharges.filter(value => { const charge = value as Record<string, unknown>; return (!charge.stopId || !removedOrReplaced.has(String(charge.stopId))) && (!charge.routeLegRef || routeIds.has(String(charge.routeLegRef))); });
      if (view.plannedCharges.some(value => { const charge = value as Record<string, unknown>; return charge.paymentStatus !== 'unpaid' && !plannedCharges.includes(value); })) throw new Error('调整会影响已付款或付款状态未知的费用，不能直接采用。');
      if (plannedCharges.length !== view.plannedCharges.length) warnings.push('原未付款的被替换地点或重算路段费用已移除；新增交通或门票费用保持未知。');
      const changes = pending.flatMap(old => { const changed = draft.stops.find(stop => stop.stopId === old.stopId); return range(old) !== range(changed) ? [{ name: old.place?.name || '后续地点', before: range(old), after: range(changed) }] : []; });
      if (!changes.length) throw new Error('当前安排已符合条件，无需改动。');
      const priorRoad = pending.map(stop => (view.routeLegs as RouteLeg[]).find(leg => leg.toStopId === stop.stopId)).map(leg => leg?.durationMinutes ?? (leg?.durationSeconds == null ? NaN : leg.durationSeconds / 60));
      const expiry = Math.min(Date.parse(ctx.now()) + 5 * 60000, ...(gps ? [gps.measuredAt + 120000] : []), roadValidUntil);
      const preview: Preview = { previewId: `preview_${randomUUID()}`, actorId, planId: id, revision: view.revision || 0, signature, expiresAt: new Date(expiry).toISOString(), params, title: draft.title, warnings, stops: draft.stops, routeLegs, plannedCharges, changes, origin: { lat: origin.lat, lng: origin.lng, ...(gps ? { measuredAt: gps.measuredAt } : {}) },
        impact: { endBefore: clock(Math.max(...pending.map(end))), endAfter: clock(cursor), roadMinutesAfter: Math.ceil(roadMinutesAfter), roadMinutesBefore: priorRoad.every(Number.isFinite) ? Math.ceil(priorRoad.reduce((sum, minutes) => sum + minutes, 0)) : null, protectedStops: pending.filter(stop => locked.has(stop.stopId)).length, fees: '新交通或门票费用未报价；不改变已付款及付款状态未知的费用。' } };
      candidates.push(preview); store.set(preview.previewId, preview);
    } catch (error) { reasons.add(error instanceof Error ? error.message : '部分信息待核对。'); }
  }
  if (!drafts.length) reasons.add(change === 'rain' ? '附近目录没有可核对的室内候选，暂不替你编造地点。' : '没有满足当前保护条件的可调整安排。');
  const current = ownedDay(ctx, actorId, id, body.expectedRevision);
  if (companionPlanSignature(ctx.planLibrary.get(actorId, current.id)) !== signature) throw new CompanionContextError('COMPANION_STALE', '查询期间计划或进度已变化，请重新预览。');
  // 不把可用于写入的完整快照或服务端签名交给浏览器。
  if (store.size > 512) for (const key of [...store.keys()].slice(0, store.size - 512)) store.delete(key);
  return { candidates: candidates.map(({ previewId, expiresAt, title, warnings, changes, params, revision, impact }) => ({ previewId, expiresAt, title, warnings, changes, params, revision, impact })), reasons: [...reasons] };
}

export function applyCompanionAdvice(ctx: ServerContext, actorId: string, planId: string, body: Record<string, unknown>) {
  const actionKey = String(body.actionKey || '');
  const previewId = String(body.previewId || '');
  const orderedParams = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? Object.entries(body.params).sort(([a], [b]) => a.localeCompare(b)) : body.params;
  const requestDigest = createHash('sha256').update(JSON.stringify([previewId, body.expectedRevision, orderedParams])).digest('hex');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(actionKey)) throw new CompanionContextError('INVALID_INPUT', '缺少有效确认标识，请重新预览。', 400);
  const raw = ctx.planLibrary.get(actorId, planId);
  const receipt = raw.companionReceipts?.find(item => item.actionKey === actionKey);
  if (receipt) {
    if (receipt.previewId !== previewId || receipt.requestDigest !== requestDigest) throw new CompanionContextError('COMPANION_STALE', '确认标识已用于另一份建议或参数。');
    return structuredClone(receipt);
  }
  const preview = previews.get(ctx.planLibrary)?.get(previewId);
  if (!preview || preview.actorId !== actorId || preview.planId !== planId) throw new CompanionContextError('COMPANION_PREVIEW_EXPIRED', '建议凭据已失效，请重新预览。');
  if (Date.parse(ctx.now()) > Date.parse(preview.expiresAt)) throw new CompanionContextError('COMPANION_PREVIEW_EXPIRED', '道路建议已过期，请重新核对。');
  const currentPosition = usableAgentLocation(body.position, ctx.now());
  if (currentPosition) {
    const meters = Math.hypot((currentPosition.lat - preview.origin.lat) * 111000, (currentPosition.lng - preview.origin.lng) * 111000 * Math.cos(preview.origin.lat * Math.PI / 180));
    if (meters > 200) throw new CompanionContextError('COMPANION_POSITION_CHANGED', '当前位置已经变化，请按新起点重新预览路线。');
  }
  if (body.expectedRevision !== preview.revision || !isDeepStrictEqual(body.params, preview.params)) throw new CompanionContextError('COMPANION_STALE', '选择参数或计划版本已变化，请重新预览。');
  ownedDay(ctx, actorId, planId, preview.revision);
  if (companionPlanSignature(raw) !== preview.signature) throw new CompanionContextError('COMPANION_STALE', '计划或执行记录已变化，请重新预览。');
  return ctx.planLibrary.applyCompanion(actorId, planId, { actionKey, previewId, requestDigest, expectedRevision: preview.revision, signature: preview.signature, stops: preview.stops, routeLegs: preview.routeLegs, plannedCharges: preview.plannedCharges });
}
