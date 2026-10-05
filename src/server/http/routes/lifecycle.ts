/**
 * 旅行生命周期、撤销、执行事实与情境上报。
 *
 * 一条贯穿全模块的不变量：**计划版本与执行事实分开**。
 * 这里所有执行类写入（execution / spend / walking）都不会推进计划 revision，
 * 计划调整也不会覆盖已经发生的进度。
 */
import { readJson, readRevision } from '../request.js';
import { sendData, sendError, sendServiceError } from '../respond.js';
import type { RouteHandler } from '../router.js';
import { readExecutionType, readStopStatus } from './_shared.js';

const LIFECYCLE = /^\/api\/v1\/trips\/([^/]+)\/start$/;
const FINISH = /^\/api\/v1\/trips\/([^/]+)\/finish$/;
const ARCHIVE = /^\/api\/v1\/trips\/([^/]+)\/archive$/;
const CLONE = /^\/api\/v1\/trips\/([^/]+)\/clone$/;
const UNDO = /^\/api\/v1\/trips\/([^/]+)\/undo$/;
const EXECUTION_EVENTS = /^\/api\/v1\/trips\/([^/]+)\/execution-events$/;
const EXECUTION_CORRECTIONS = /^\/api\/v1\/trips\/([^/]+)\/execution-corrections$/;
const SPEND_EVENTS = /^\/api\/v1\/trips\/([^/]+)\/spend-events$/;
const WALKING_EVENTS = /^\/api\/v1\/trips\/([^/]+)\/walking-events$/;
const CONTEXT = /^\/api\/v1\/trips\/([^/]+)\/context$/;
const TRIP_ROUTES = /^\/api\/v1\/trips\/([^/]+)\/routes$/;

/** 执行类接口的 expectedRevision 是可选的：用户记进度不该被版本号挡住。 */
function optionalRevision(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export const lifecycleRoutes: RouteHandler = async (ctx, req) => {
  const { path, method, request, response } = req;
  const service = ctx.service;

  const lifecycleMatch = LIFECYCLE.exec(path) ?? FINISH.exec(path) ?? ARCHIVE.exec(path);
  if (lifecycleMatch && method === 'POST') {
    const action = path.endsWith('/start')
      ? 'start'
      : path.endsWith('/finish')
        ? 'finish'
        : 'archive';
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(lifecycleMatch[1]);
    const body = await readJson(request);
    const expectedRevision = readRevision(body);
    if (expectedRevision === null) {
      sendError(response, 400, 'INVALID_INPUT', 'expectedRevision 必须是非负整数。');
      return true;
    }
    const result =
      action === 'start'
        ? service.startTrip(auth.actorId, tripId, expectedRevision)
        : action === 'finish'
          ? service.finishTrip(auth.actorId, tripId, expectedRevision)
          : service.archiveTrip(auth.actorId, tripId, expectedRevision);
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value, { dataMode: result.value.trip.dataMode });
    return true;
  }

  if (CLONE.test(path) && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const result = service.cloneTrip(auth.actorId, decodeURIComponent(CLONE.exec(path)![1]));
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value, { dataMode: result.value.trip.dataMode });
    return true;
  }

  const undoMatch = UNDO.exec(path);
  if (undoMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(undoMatch[1]);
    const body = await readJson(request);
    const expectedRevision = readRevision(body);
    if (expectedRevision === null) {
      sendError(response, 400, 'INVALID_INPUT', 'expectedRevision 必须是非负整数。');
      return true;
    }
    const result = service.undo({
      actorId: auth.actorId,
      sessionId: auth.sessionId,
      tripId,
      mutationId: String(body.mutationId ?? ''),
      expectedRevision,
      idempotencyKey:
        String(request.headers['idempotency-key'] ?? '') ||
        `undo:${tripId}:${String(body.mutationId ?? '')}`,
    });
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value, { dataMode: result.value.trip.trip.dataMode });
    return true;
  }

  const eventsMatch = EXECUTION_EVENTS.exec(path);
  if (eventsMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const body = await readJson(request);
    const type = readExecutionType(body.type);
    if (!type) {
      sendError(response, 400, 'INVALID_INPUT', 'type 必须是有效的进度动作。');
      return true;
    }
    const result = service.recordExecution({
      actorId: auth.actorId,
      sessionId: auth.sessionId,
      tripId: decodeURIComponent(eventsMatch[1]),
      stopId: String(body.stopId),
      type,
      occurredAt: String(body.occurredAt ?? ctx.now()),
      expectedRevision: optionalRevision(body.expectedRevision),
    });
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value, { dataMode: result.value.trip.dataMode });
    return true;
  }

  const correctionMatch = EXECUTION_CORRECTIONS.exec(path);
  if (correctionMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const body = await readJson(request);
    const type = readExecutionType(body.type);
    const statusOverride = body.status === undefined ? undefined : readStopStatus(body.status);
    if (!type || (body.status !== undefined && !statusOverride)) {
      sendError(response, 400, 'INVALID_INPUT', 'type 或 status 不是有效的进度值。');
      return true;
    }
    const result = service.recordExecutionCorrection({
      actorId: auth.actorId,
      tripId: decodeURIComponent(correctionMatch[1]),
      eventIdToCorrect: String(body.eventId),
      statusOverride: statusOverride ?? undefined,
      correctionReason: typeof body.reason === 'string' ? body.reason : undefined,
      type,
      occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
      expectedRevision: optionalRevision(body.expectedRevision),
    });
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value, { dataMode: result.value.trip.dataMode });
    return true;
  }

  const spendMatch = SPEND_EVENTS.exec(path);
  if (spendMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const body = await readJson(request);
    const result = service.recordSpend({
      actorId: auth.actorId,
      tripId: decodeURIComponent(spendMatch[1]),
      amountMinor: Number(body.amountMinor),
      completenessConfirmed: body.completenessConfirmed === true,
      includedChargeIds: Array.isArray(body.includedChargeIds)
        ? body.includedChargeIds.map(String)
        : [],
      occurredAt: String(body.occurredAt ?? ctx.now()),
      expectedRevision: optionalRevision(body.expectedRevision),
    });
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value, { dataMode: result.value.trip.dataMode });
    return true;
  }

  const walkingMatch = WALKING_EVENTS.exec(path);
  if (walkingMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const body = await readJson(request);
    const result = service.recordWalking({
      actorId: auth.actorId,
      tripId: decodeURIComponent(walkingMatch[1]),
      walkingMeters: Number(body.walkingMeters),
      completenessConfirmed: body.completenessConfirmed === true,
      occurredAt: String(body.occurredAt ?? ctx.now()),
      expectedRevision: optionalRevision(body.expectedRevision),
    });
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value, { dataMode: result.value.trip.dataMode });
    return true;
  }

  const contextMatch = CONTEXT.exec(path);
  if (contextMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const body = await readJson(request);
    const result = service.captureContext(auth.actorId, decodeURIComponent(contextMatch[1]), {
      capturedAt: String(body.capturedAt ?? ctx.now()),
      clockRef: String(body.clockRef ?? 'demo-clock'),
      locationRef: typeof body.locationRef === 'string' ? body.locationRef : null,
      event:
        typeof body.event === 'object' && body.event
          ? (body.event as Record<string, unknown>)
          : {},
    });
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value);
    return true;
  }

  const routesMatch = TRIP_ROUTES.exec(path);
  if (routesMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(routesMatch[1]);
    const trip = service.getTrip(auth.actorId, tripId);
    if (!trip.ok) {
      sendServiceError(response, trip);
      return true;
    }
    const estimate = await ctx.estimateRoute(await readJson(request), trip.value.trip.dataMode);
    if (estimate.error) {
      sendError(response, 400, estimate.error.code, estimate.error.message);
      return true;
    }
    sendData(response, estimate, {
      dataMode: trip.value.trip.dataMode,
      responseSource: 'computed_template',
    });
    return true;
  }

  return false;
};
