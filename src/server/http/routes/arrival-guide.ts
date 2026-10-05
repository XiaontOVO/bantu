import { parsePagination, readJson } from '../request.js';
import { sendData, sendError, sendRateLimited } from '../respond.js';
import type { RouteHandler } from '../router.js';
import { arrivalGuidePlace, generateArrivalIntroduction } from '../../../services/arrival-guide.js';

/** Public directory metadata; model selection is authenticated and entirely read-only. */
export const arrivalGuideRoutes: RouteHandler = async (ctx, req) => {
  const { path, method, request, response, url } = req;
  const provider = ctx.options.placeProvider ?? ctx.fallbackPlaceProvider;
  if (path === '/api/v1/arrival-guide/places' && method === 'GET') {
    const pagination = parsePagination(url, 50);
    const result = await provider.search({ cityCode: url.searchParams.get('cityCode') ?? '', limit: pagination.limit, offset: pagination.cursor });
    if (result.error) {
      sendError(response, 503, result.error.code, '地点资料暂时不可用，请稍后重试。', undefined, true); return true;
    }
    sendData(response, result.places.map(arrivalGuidePlace), { nextCursor: result.nextCursor ?? null, coordinateCrs: 'WGS84' }); return true;
  }
  const match = /^\/api\/v1\/places\/([^/]+)\/arrival-guide\/introduction$/.exec(path);
  if (!match || method !== 'POST') return false;
  const auth = ctx.requireAuth(request, response); if (!auth) return true;
  // Parsing retains the standard body-size/JSON boundary. Client-supplied identity,
  // coordinates, facts and prompts cannot change the provider or grant any action.
  await readJson(request);
  const place = await provider.detail(decodeURIComponent(match[1]), 'demo');
  if (!place) { sendError(response, 404, 'RESOURCE_NOT_FOUND', '地点不存在或尚未收录。'); return true; }
  const limit = ctx.rateLimiter.consume(`arrival-guide:${auth.actorId}`, 12, 60);
  if (!limit.allowed) { sendRateLimited(response, limit.retryAfterSeconds, '地点讲解请求过于频繁，请稍后重试。'); return true; }
  sendData(response, await generateArrivalIntroduction(place, ctx.modelProviderForActor(auth.actorId)));
  return true;
};
