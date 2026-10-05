/**
 * 旅行的建立、读取、手动编辑与删除。
 *
 * 手动编辑（plan-edits / PATCH）不经过提案与许可：它是用户直接改自己的行程，
 * 但仍然必须带 `expectedRevision`，否则并发保存会静默覆盖别人的改动。
 */
import { paginate, parsePagination, readJson, readRevision, rejectNonArrayFields } from '../request.js';
import { sendData, sendError, sendServiceError } from '../respond.js';
import type { RouteHandler } from '../router.js';
import type { TripView } from '../../../services/trip-service.js';
import type { PlaceProvider } from '../../../providers/travel.js';
import { isValidBudgetMinor, isValidBudgetSetting, isValidPartySize } from '../../../services/trip/validation.js';
import { placeRefFromDirectory } from './_shared.js';

const TRIPS = '/api/v1/trips';
const TRIP = /^\/api\/v1\/trips\/([^/]+)$/;
const VERSIONS = /^\/api\/v1\/trips\/([^/]+)\/versions$/;
const PLAN_EDITS = /^\/api\/v1\/trips\/([^/]+)\/plan-edits$/;
const SHORTLIST = /^\/api\/v1\/trips\/([^/]+)\/shortlist$/;

/** 会被写成数组的快照字段；非数组必须在入口拦下，否则领域层会抛 TypeError。 */
const ARRAY_FIELDS = ['constraints', 'stops', 'routeLegs', 'plannedCharges'] as const;

// 旧 Trip 接口仅作迁移兼容；默认城市仍应与当前地点目录保持一致。
const DEFAULT_CITY_CODE = '310100';

async function normalizeTripStopPlaces(value: unknown, provider: PlaceProvider): Promise<TripView['snapshot']['stops'] | undefined> {
  if (!Array.isArray(value)) return undefined;
  const stops = structuredClone(value) as unknown[];
  await Promise.all([...new Set(stops)].map(async item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const stop = item as Record<string, unknown>;
    const place = stop.place && typeof stop.place === 'object' && !Array.isArray(stop.place)
      ? stop.place as Record<string, unknown>
      : null;
    const placeId = typeof place?.placeId === 'string' ? place.placeId : typeof stop.placeId === 'string' ? stop.placeId : '';
    if (!placeId) return;
    try {
      const canonical = placeRefFromDirectory(await provider.detail(placeId, 'demo'));
      if (canonical) {
        stop.place = canonical;
        stop.placeId = canonical.placeId;
      }
    } catch { /* Preserve legacy stop metadata while the catalog is unavailable. */ }
  }));
  return stops as TripView['snapshot']['stops'];
}

function localDateInShanghai(now: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export const tripRoutes: RouteHandler = async (ctx, req) => {
  const { path, method, url, request, response } = req;
  const service = ctx.service;

  const restoreMatch = /^\/api\/v1\/trips\/([^/]+)\/versions\/(\d+)\/proposals$/.exec(path);
  if (restoreMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const body = await readJson(request);
    const tripId = decodeURIComponent(restoreMatch[1]);
    const historic = service.getVersion(auth.actorId, tripId, Number(restoreMatch[2]));
    const current = service.getTrip(auth.actorId, tripId);
    if (!historic.ok) { sendServiceError(response, historic); return true; }
    if (!current.ok) { sendServiceError(response, current); return true; }
    const expectedRevision = readRevision(body);
    if (expectedRevision === null) {
      sendError(response, 400, 'INVALID_INPUT', 'expectedRevision 必须是非负整数。');
      return true;
    }
    const actual = (current.value.snapshot.stops || []).filter((stop) => stop.status !== 'planned');
    const protectedIds = new Set(actual.map((stop) => stop.stopId));
    const stops = [...actual, ...(historic.value.snapshot.stops || [])
      .filter((stop) => !protectedIds.has(stop.stopId))
      .map((stop) => ({ ...stop, status: 'planned' as const }))];
    const routeLegs = actual.length === 0 ? (historic.value.snapshot.routeLegs || [])
      : (historic.value.snapshot.routeLegs || []).filter((leg) =>
        stops.some((stop, index) => stop.stopId === leg.fromStopId && stops[index + 1]?.stopId === leg.toStopId));
    const result = service.createProposal(auth.actorId, tripId, {
      kind: 'replan', baseRevision: expectedRevision, sessionId: auth.sessionId,
      contextSnapshotId: current.value.trip.latestContextId,
      candidates: [{ title: `沿用第 ${restoreMatch[2]} 版安排`, summary: '保留当前实际进度，预览历史安排；确认后保存为新版本。',
        snapshot: { ...current.value.snapshot, stops, routeLegs, plannedCharges: historic.value.snapshot.plannedCharges } }],
    });
    if (!result.ok) sendServiceError(response, result);
    else sendData(response, result.value);
    return true;
  }

  const snapshotMatch = /^\/api\/v1\/trips\/([^/]+)\/versions\/(\d+)$/.exec(path);
  if (snapshotMatch && method === 'GET') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const result = service.getVersion(auth.actorId, decodeURIComponent(snapshotMatch[1]), Number(snapshotMatch[2]));
    if (!result.ok) sendServiceError(response, result);
    else sendData(response, result.value);
    return true;
  }

  if (path === TRIPS) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;

    if (method === 'GET') {
      const result = service.listTrips(auth.actorId);
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      const page = paginate(
        result.value.map((trip) => trip.trip),
        parsePagination(url),
      );
      sendData(response, page.items, { nextCursor: page.nextCursor });
      return true;
    }

    if (method === 'POST') {
      const body = await readJson(request);
      if (Object.hasOwn(body, 'partySize') && !isValidPartySize(body.partySize)) {
        sendError(response, 400, 'INVALID_INPUT', 'partySize 必须是正整数。');
        return true;
      }
      if (Object.hasOwn(body, 'budgetMinor') && !isValidBudgetMinor(body.budgetMinor)) {
        sendError(response, 400, 'INVALID_INPUT', 'budgetMinor 必须是非负有限数值或 null。');
        return true;
      }
      const result = service.createTrip(auth.actorId, {
        cityCode: String(body.cityCode ?? DEFAULT_CITY_CODE),
        localDate: String(body.localDate ?? localDateInShanghai(ctx.now())),
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        dataMode: body.dataMode === 'online' ? 'online' : 'demo',
        partySize: typeof body.partySize === 'number' ? body.partySize : undefined,
        budgetMinor: typeof body.budgetMinor === 'number' ? body.budgetMinor : null,
        budgetStrength: body.budgetStrength === 'soft' ? 'soft' : 'hard',
      });
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value, { dataMode: result.value.trip.dataMode });
      return true;
    }

    return false;
  }

  const tripMatch = TRIP.exec(path);
  if (tripMatch) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(tripMatch[1]);

    if (method === 'GET') {
      const result = service.getTrip(auth.actorId, tripId);
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value, { dataMode: result.value.trip.dataMode });
      return true;
    }

    if (method === 'PATCH') {
      const body = await readJson(request);
      if (rejectNonArrayFields(response, body, ARRAY_FIELDS)) return true;
      if (Object.hasOwn(body, 'localDate') && typeof body.localDate !== 'string') {
        sendError(response, 400, 'INVALID_INPUT', 'localDate 必须是 YYYY-MM-DD 格式的日期。');
        return true;
      }
      if (Object.hasOwn(body, 'partySize') && !isValidPartySize(body.partySize)) {
        sendError(response, 400, 'INVALID_INPUT', 'partySize 必须是正整数。');
        return true;
      }
      if (Object.hasOwn(body, 'budget') && !isValidBudgetSetting(body.budget)) {
        sendError(response, 400, 'INVALID_INPUT', 'budget.limitMinor 必须是非负有限数值或 null。');
        return true;
      }
      const expectedRevision = readRevision(body);
      if (expectedRevision === null) {
        sendError(response, 400, 'INVALID_INPUT', 'expectedRevision 必须是非负整数。');
        return true;
      }
      const stops = await normalizeTripStopPlaces(body.stops, ctx.options.placeProvider ?? ctx.fallbackPlaceProvider);
      const result = service.patchTrip(auth.actorId, tripId, {
        expectedRevision,
        cityCode: typeof body.cityCode === 'string' ? body.cityCode : undefined,
        localDate: typeof body.localDate === 'string' ? body.localDate : undefined,
        partySize: typeof body.partySize === 'number' ? body.partySize : undefined,
        partyNeeds:
          body.partyNeeds && typeof body.partyNeeds === 'object'
            ? (body.partyNeeds as Record<string, Record<string, unknown>>)
            : undefined,
        constraints: body.constraints as TripView['snapshot']['constraints'],
        budget: body.budget as TripView['snapshot']['budget'],
        stops,
        routeLegs: body.routeLegs as TripView['snapshot']['routeLegs'],
        plannedCharges: body.plannedCharges as TripView['snapshot']['plannedCharges'],
        dayStartMinutes:
          typeof body.dayStartMinutes === 'number' ? body.dayStartMinutes : undefined,
      });
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value, { dataMode: result.value.trip.dataMode });
      return true;
    }

    if (method === 'DELETE') {
      const result = service.deleteTrip(auth.actorId, tripId);
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      // 旅行没了，挂在它上面的任务与对话也必须一起消失，否则会留下仍可读的孤儿数据。
      ctx.agentService.cancelForTrip(tripId, ctx.now());
      ctx.messageService.clearTrip(tripId);
      sendData(response, { deleted: true });
      return true;
    }

    return false;
  }

  const versionsMatch = VERSIONS.exec(path);
  if (versionsMatch && method === 'GET') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const result = service.listVersions(auth.actorId, decodeURIComponent(versionsMatch[1]));
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value);
    return true;
  }

  const editsMatch = PLAN_EDITS.exec(path);
  if (editsMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const body = await readJson(request);
    if (rejectNonArrayFields(response, body, ['stops', 'routeLegs', 'constraints'])) return true;
    const expectedRevision = readRevision(body);
    if (expectedRevision === null) {
      sendError(response, 400, 'INVALID_INPUT', 'expectedRevision 必须是非负整数。');
      return true;
    }
    const stops = await normalizeTripStopPlaces(body.stops, ctx.options.placeProvider ?? ctx.fallbackPlaceProvider);
    const result = service.patchTrip(auth.actorId, decodeURIComponent(editsMatch[1]), {
      expectedRevision,
      allowPast: body.allowPast === true,
      stops,
      routeLegs: body.routeLegs as TripView['snapshot']['routeLegs'],
      constraints: body.constraints as TripView['snapshot']['constraints'],
    });
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value, { dataMode: result.value.trip.dataMode });
    return true;
  }

  const shortlistMatch = SHORTLIST.exec(path);
  if (shortlistMatch) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(shortlistMatch[1]);
    if (method === 'GET') {
      const result = service.listShortlist(auth.actorId, tripId);
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value);
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const result = service.addShortlist(auth.actorId, tripId, String(body.placeId));
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value);
      return true;
    }
    return false;
  }

  return false;
};
