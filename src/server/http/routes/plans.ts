/** 我的方案库：全局方案（不依赖旅行）的保存、列表、删除与按起始日期载入。 */
import { readJson, paginate, parsePagination, readRevision } from '../request.js';
import { RequestBodyTooLargeError } from '../errors.js';
import { sendData, sendError, sendServiceError, statusFor } from '../respond.js';
import type { RouteHandler } from '../router.js';
import { replayExecutionEvents } from '../../../domain/execution.js';
import type { ExecutionEvent, PlanStop } from '../../../domain/types.js';
import type { PlaceProvider } from '../../../providers/travel.js';
import { DatedPlanConflictError, PlanExecutionConflictError, SavedPlanRevisionConflictError } from '../../../services/plan-library.js';
import { estimateDepartTravel } from '../../../services/plan-departure.js';
import { placeRefFromDirectory, readExecutionType, readStopStatus } from './_shared.js';

function todayInTimeZone(timeZone = 'Asia/Shanghai', now = new Date()) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
  }
  const value = (type: string) => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

async function normalizePlanStopPlaces(body: Record<string, unknown>, provider: PlaceProvider) {
  const copy = structuredClone(body);
  const stops: unknown[] = [];
  if (Array.isArray(copy.days)) {
    for (const day of copy.days) {
      if (day && typeof day === 'object' && !Array.isArray(day) && Array.isArray((day as Record<string, unknown>).stops)) {
        stops.push(...(day as Record<string, unknown>).stops as unknown[]);
      }
    }
  }
  const snapshot = copy.snapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && Array.isArray((snapshot as Record<string, unknown>).stops)) {
    stops.push(...(snapshot as Record<string, unknown>).stops as unknown[]);
  }
  if (Array.isArray(copy.stops)) stops.push(...copy.stops);

  await Promise.all([...new Set(stops)].map(async value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const stop = value as Record<string, unknown>;
    const place = stop.place && typeof stop.place === 'object' && !Array.isArray(stop.place)
      ? stop.place as Record<string, unknown>
      : null;
    const placeId = typeof place?.placeId === 'string' ? place.placeId : typeof stop.placeId === 'string' ? stop.placeId : '';
    if (!placeId) return;
    try {
      const resolved = await provider.detail(placeId, 'demo');
      const canonical = placeRefFromDirectory(resolved);
      if (canonical) {
        stop.place = canonical;
        stop.placeId = canonical.placeId;
      }
    } catch { /* Keep legacy metadata usable when the directory is unavailable. */ }
  }));
  return copy;
}

function dateAndMinuteInTimezone(value: string, timezone: string): { date: string; minute: number } | null {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const part = (name: string) => parts.find(item => item.type === name)?.value || '';
    return {
      date: `${part('year')}-${part('month')}-${part('day')}`,
      minute: Number(part('hour')) * 60 + Number(part('minute')),
    };
  } catch {
    return null;
  }
}

export const planLibraryRoutes: RouteHandler = async (ctx, req) => {
  const daytimeMatch = /^\/api\/v1\/plans\/([^/]+)\/daytime-(preview|apply)$/.exec(req.path);
  if (daytimeMatch && req.method === 'POST') {
    const auth = ctx.requireAuth(req.request, req.response);
    if (!auth) return true;
    try {
      const body = await readJson(req.request), id = decodeURIComponent(daytimeMatch[1]);
      sendData(req.response, daytimeMatch[2] === 'preview' ? ctx.planLibrary.previewDaytime(auth.actorId, id, body)
        : ctx.planLibrary.applyDaytime(auth.actorId, id, body));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
      sendError(req.response, error instanceof SavedPlanRevisionConflictError ? 409 : 400,
        error instanceof SavedPlanRevisionConflictError ? 'REVISION_CONFLICT' : 'DAYTIME_PLAN_INVALID', error instanceof Error ? error.message : '白天安排暂时无法完成。');
    }
    return true;
  }
  const historyMatch = /^\/api\/v1\/plans\/history$/.test(req.path)
    ? { list: true }
    : /^\/api\/v1\/plans\/([^/]+)\/history(?:\/(backfill|corrections))?$/.exec(req.path);
  if (historyMatch) {
    const auth = ctx.requireAuth(req.request, req.response);
    if (!auth) return true;
    try {
      const isList = !Array.isArray(historyMatch), id = isList ? '' : decodeURIComponent(historyMatch[1]), action = isList ? '' : historyMatch[2];
      if (req.method === 'GET' && isList) {
        const page = paginate(ctx.planLibrary.history(auth.actorId), parsePagination(req.url));
        sendData(req.response, page.items, { nextCursor: page.nextCursor }); return true;
      }
      if (req.method === 'GET' && !isList && !action) { sendData(req.response, ctx.planLibrary.historyDetail(auth.actorId, id)); return true; }
      if (['POST', 'DELETE'].includes(req.method) && !isList) {
        const body = await readJson(req.request), revision = readRevision(body);
        if (revision === null || revision === undefined) { sendError(req.response, 400, 'INVALID_INPUT', '请提供当前记录版本。'); return true; }
        if (req.method === 'DELETE' && !action) { sendData(req.response, ctx.planLibrary.removeHistory(auth.actorId, id, revision)); return true; }
        if (req.method === 'POST' && action === 'backfill') {
          if (!['complete', 'skip'].includes(String(body.type))) { sendError(req.response, 400, 'INVALID_INPUT', '请选择完成或跳过。'); return true; }
          sendData(req.response, ctx.planLibrary.backfillHistory(auth.actorId, id, { stopId: String(body.stopId || ''), type: body.type as 'complete' | 'skip',
            occurredAt: String(body.occurredAt || ''), arrivedAt: typeof body.arrivedAt === 'string' && body.arrivedAt ? body.arrivedAt : undefined, expectedRevision: revision })); return true;
        }
        if (req.method === 'POST' && action === 'corrections') {
          if (!['planned', 'completed', 'skipped'].includes(String(body.status))) { sendError(req.response, 400, 'INVALID_INPUT', '往日记录不能改为实时进行中。'); return true; }
          sendData(req.response, ctx.planLibrary.correctHistory(auth.actorId, id, { eventId: String(body.eventId || ''), status: body.status as 'planned' | 'completed' | 'skipped',
            occurredAt: typeof body.occurredAt === 'string' && body.occurredAt ? body.occurredAt : undefined, reason: typeof body.reason === 'string' ? body.reason : undefined, expectedRevision: revision })); return true;
        }
      }
      return false;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
      if (error instanceof SavedPlanRevisionConflictError) sendError(req.response, 409, 'REVISION_CONFLICT', error.message);
      else if (error instanceof PlanExecutionConflictError) sendError(req.response, statusFor(error.code), error.code, error.message);
      else sendError(req.response, 400, 'PLAN_HISTORY_INVALID', error instanceof Error ? error.message : '往日记录操作失败。');
      return true;
    }
  }
  const legacyMigration = /^\/api\/v1\/plans\/migrate-trip\/([^/]+)$/.exec(req.path);
  if (legacyMigration && req.method === 'POST') {
    const auth = ctx.requireAuth(req.request, req.response);
    if (!auth) return true;
    const tripId = decodeURIComponent(legacyMigration[1]);
    const current = ctx.service.getTrip(auth.actorId, tripId);
    if (!current.ok) {
      sendServiceError(req.response, current);
      return true;
    }
    try {
      sendData(req.response, ctx.planLibrary.migrateLegacyTrip(auth.actorId, current.value));
    } catch (error) {
      sendError(req.response, 409, 'PLAN_MIGRATION_FAILED', error instanceof Error ? error.message : '旧行程迁移失败。');
    }
    return true;
  }

  const progressMatch = /^\/api\/v1\/plans\/([^/]+)\/(execution-events|execution-corrections)$/.exec(req.path);
  if (progressMatch && req.method === 'POST') {
    const auth = ctx.requireAuth(req.request, req.response);
    if (!auth) return true;
    try {
      const body = await readJson(req.request);
      const expectedRevision = readRevision(body);
      if (expectedRevision === null) {
        sendError(req.response, 400, 'INVALID_INPUT', 'expectedRevision 必须是非负整数。');
        return true;
      }
      const planId = decodeURIComponent(progressMatch[1]);
      if (progressMatch[2] === 'execution-events') {
        const type = readExecutionType(body.type);
        if (!type) {
          sendError(req.response, 400, 'INVALID_INPUT', 'type 必须是有效的进度动作。');
          return true;
        }
        const estimation = type === 'depart' ? await estimateDepartTravel(ctx, auth.actorId, planId, body) : null;
        sendData(req.response, ctx.planLibrary.recordExecution(auth.actorId, planId, {
          stopId: String(body.stopId || ''),
          type,
          occurredAt: String(body.occurredAt ?? ctx.now()),
          expectedRevision,
          ...(estimation ?? {}),
        }));
        return true;
      }
      const type = readExecutionType(body.type);
      const status = readStopStatus(body.status);
      if (!type || !status) {
        sendError(req.response, 400, 'INVALID_INPUT', 'type 或 status 不是有效的进度值。');
        return true;
      }
      sendData(req.response, ctx.planLibrary.correctExecution(auth.actorId, planId, {
        eventId: String(body.eventId || ''), type, status,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
        expectedRevision,
      }));
      return true;
    } catch (error) {
      if (error instanceof PlanExecutionConflictError) {
        sendError(req.response, statusFor(error.code), error.code, error.message);
        return true;
      }
      if (error instanceof SavedPlanRevisionConflictError) {
        sendError(req.response, 409, 'REVISION_CONFLICT', error.message);
        return true;
      }
      sendError(req.response, 400, 'PLAN_LIBRARY_INVALID', error instanceof Error ? error.message : '进度操作失败。');
      return true;
    }
  }
  const match = /^\/api\/v1\/plans(?:\/([^/]+)(?:\/(load|versions|restore))?)?$/.exec(req.path);
  if (!match) return false;
  const auth = ctx.requireAuth(req.request, req.response);
  if (!auth) return true;
  try {
    if (req.method === 'POST' && match[1] && match[2] === 'restore') {
      const body = await readJson(req.request);
      const revision = readRevision(body);
      if (revision === null || revision === undefined || !Number.isInteger(body.versionRevision) || Number(body.versionRevision) < 1) {
        sendError(req.response, 400, 'INVALID_INPUT', '请提供当前版本与要恢复的历史版本号。');
        return true;
      }
      sendData(req.response, ctx.planLibrary.restoreVersion(auth.actorId, decodeURIComponent(match[1]), Number(body.versionRevision), revision));
      return true;
    }
    if (req.method === 'GET' && !match[1]) {
      const page = paginate(ctx.planLibrary.list(auth.actorId), parsePagination(req.url));
      sendData(req.response, page.items, { nextCursor: page.nextCursor });
      return true;
    }
    if (req.method === 'GET' && match[1] && match[2] === 'versions') {
      sendData(req.response, ctx.planLibrary.versions(auth.actorId, decodeURIComponent(match[1])));
      return true;
    }
    if (req.method === 'POST' && !match[1]) {
      const body = await normalizePlanStopPlaces(await readJson(req.request), ctx.options.placeProvider ?? ctx.fallbackPlaceProvider);
      const source = ['current', 'candidate', 'draft', 'imported'].includes(String(body.source)) ? body.source as 'current' | 'candidate' | 'draft' | 'imported' : 'draft';
      sendData(req.response, ctx.planLibrary.save(auth.actorId, body, source));
      return true;
    }
    if (req.method === 'POST' && match[1] && match[2] === 'load') {
      // 方案载入：确定起始日期后自动展开为每天一份带日期的计划。
      // 目标日期已有计划时返回 { conflict, dates }，由界面询问是否替换（replace=true 执行替换）。
      const body = await readJson(req.request);
      let progressStops: Array<PlanStop & { progressEndMinutes?: number }> = [];
      let progressRevision: number | undefined;
      const tripId = typeof body.tripId === 'string' ? body.tripId.trim() : '';
      if (tripId) {
        const current = ctx.service.getTrip(auth.actorId, tripId);
        if (!current.ok) {
          sendServiceError(req.response, current);
          return true;
        }
        const fallbackDate = current.value.snapshot.travelDate || current.value.snapshot.localDate ||
          current.value.snapshot.tripSettings?.localDate || current.value.trip.localDate || '';
        progressRevision = current.value.trip.revision;
        const stops = current.value.snapshot.stops || [];
        const events = current.value.snapshot.executionEvents || [];
        const replay = replayExecutionEvents(stops, events);
        const invalidEvents = new Set(replay.errors.map(error => error.eventId));
        const latestEvents = new Map<string, ExecutionEvent>();
        for (const event of replay.effectiveEvents) {
          if (!invalidEvents.has(event.executionEventId)) latestEvents.set(event.stopId, event);
        }
        const timezone = current.value.snapshot.timezone || current.value.trip.timezone || 'Asia/Shanghai';
        progressStops = stops
          .filter(stop => stop.status !== 'planned')
          .map(stop => {
            const occurred = latestEvents.get(stop.stopId);
            const stamp = occurred ? dateAndMinuteInTimezone(occurred.occurredAt, timezone) : null;
            const active = ['en_route', 'visiting'].includes(stop.status || '');
            const activeDate = active ? current.value.clock?.date : undefined;
            const progressEndMinutes = active && typeof current.value.clock?.minutes === 'number'
              ? current.value.clock.minutes
              : stamp?.minute;
            return {
              ...stop,
              date: activeDate || stop.date || stamp?.date || fallbackDate,
              ...(stop.status !== 'skipped' && typeof progressEndMinutes === 'number' ? { progressEndMinutes } : {}),
            };
          });
      }
      else {
        // 日计划自身保存的进度也参与方案载入冲突判断；无需先创建 Trip 才能保护当天已记录的事实。
        const datedPlans = ctx.planLibrary.list(auth.actorId)
          .filter(plan => plan.kind === 'plan' && Boolean(plan.localDate));
        progressRevision = datedPlans.reduce((revision, plan) => revision + (plan.revision || 0), 0);
        progressStops = datedPlans.flatMap(plan => {
          const timezone = plan.timezone || 'Asia/Shanghai';
          const events = plan.executionEvents || [];
          const corrected = new Set(events.flatMap(event => event.correctsEventId ? [event.correctsEventId] : []));
          const latest = new Map<string, ExecutionEvent>();
          for (const event of events) {
            if (!corrected.has(event.executionEventId)) latest.set(event.stopId, event);
          }
          return (plan.stops || []).flatMap(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            const stop = value as PlanStop;
            if (stop.status === 'planned') return [];
            const event = latest.get(stop.stopId);
            const active = ['en_route', 'visiting'].includes(stop.status || '');
            const stamp = active ? dateAndMinuteInTimezone(ctx.now(), timezone)
              : event ? dateAndMinuteInTimezone(event.occurredAt, timezone) : null;
            return [{
              ...stop,
              date: plan.localDate,
              ...(stamp && stop.status !== 'skipped' ? { progressEndMinutes: stamp.minute } : {}),
            } as PlanStop & { progressEndMinutes?: number }];
          });
        });
      }
      const scheme = ctx.planLibrary.get(auth.actorId, decodeURIComponent(match[1]));
      const defaultStartDate = todayInTimeZone(scheme.timezone || 'Asia/Shanghai', new Date(ctx.now()));
      const hasStartDate = Object.prototype.hasOwnProperty.call(body, 'startDate');
      sendData(req.response, ctx.planLibrary.loadAsPlans(
        auth.actorId,
        decodeURIComponent(match[1]),
        hasStartDate ? String(body.startDate ?? '').trim() : defaultStartDate,
        body.replace === true,
        {
          stops: progressStops,
          revision: progressRevision,
          confirmed: body.confirmProgressConflict === true,
          ...(typeof body.confirmationToken === 'string' ? { confirmationToken: body.confirmationToken } : {}),
        },
      ));
      return true;
    }
    if (req.method === 'DELETE' && match[1] && !match[2]) {
      sendData(req.response, ctx.planLibrary.remove(auth.actorId, decodeURIComponent(match[1])));
      return true;
    }
    if (req.method === 'PUT' && match[1] && !match[2]) {
      // 原地编辑：整体更新名称/日期/内容，id 与创建时间不变。
      const body = await normalizePlanStopPlaces(await readJson(req.request), ctx.options.placeProvider ?? ctx.fallbackPlaceProvider);
      sendData(req.response, ctx.planLibrary.update(auth.actorId, decodeURIComponent(match[1]), body));
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    if (error instanceof DatedPlanConflictError) {
      sendError(req.response, 409, 'DATED_PLAN_CONFLICT', error.message);
      return true;
    }
    if (error instanceof PlanExecutionConflictError) {
      sendError(req.response, statusFor(error.code), error.code, error.message);
      return true;
    }
    if (error instanceof SavedPlanRevisionConflictError) {
      sendError(req.response, 409, 'REVISION_CONFLICT', error.message);
      return true;
    }
    sendError(req.response, 400, 'PLAN_LIBRARY_INVALID', error instanceof Error ? error.message : '方案操作失败。');
    return true;
  }
};
