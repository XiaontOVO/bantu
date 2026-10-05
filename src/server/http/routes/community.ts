import { timingSafeEqual } from 'node:crypto';
import { RequestBodyTooLargeError } from '../errors.js';
import { PlaceProviderUnavailableError, type PlaceProvider } from '../../../providers/travel.js';
import { readJson, paginate, parsePagination } from '../request.js';
import { sendData, sendError } from '../respond.js';
import type { RouteHandler } from '../router.js';
import { decodePlanShareCode, CommunityReviewConflictError } from '../../../services/community-service.js';
import { cityNameOf } from '../../../domain/cities.js';

const planShareCityCache = new Map<string, { cityCode: string; cityLabel: string }>();

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

async function resolvePlanShareCity(code: string, provider: PlaceProvider) {
  const cached = planShareCityCache.get(code);
  if (cached) return cached;
  const decoded = decodePlanShareCode(code);
  const resolved = await Promise.all(decoded.stops.map(async stop => {
    const center = { lat: stop.lat, lng: stop.lng };
    try {
      const nearby = await provider.search({ cityCode: '', center, radiusMeters: 5_000, limit: 50 });
      const candidates = nearby.places
        .filter(place => place.cityCode && place.coordinates)
        .map(place => ({ place, distance: distanceMeters(center, place.coordinates!) }))
        .sort((a, b) => a.distance - b.distance)[0];
      const exactMatch = nearby.places
        .filter(place => place.name.trim().toLowerCase() === stop.name.trim().toLowerCase() && place.cityCode && place.coordinates)
        .map(place => ({ place, distance: distanceMeters(center, place.coordinates!) }))
        .sort((a, b) => a.distance - b.distance)[0];
      const match = exactMatch && exactMatch.distance <= 5_000 ? exactMatch : candidates?.distance <= 1_500 ? candidates : null;
      if (match) {
        return { cityCode: match.place.cityCode!, coordinates: match.place.coordinates! };
      }
    } catch {
      // Fall through to the city captured in newer per-place share codes.
    }
    return stop.cityCode && stop.cityCode !== '000000' ? { cityCode: stop.cityCode, coordinates: center } : null;
  }));
  const known = resolved.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const codes = [...new Set(known.map(item => item.cityCode))];
  let result: { cityCode: string; cityLabel: string };
  if (codes.length > 1) {
    result = { cityCode: codes[0], cityLabel: '多地' };
  } else if (codes.length === 1) {
    const code = codes[0];
    const allStopsNearby = resolved.every((item, index) => item || known.some(match =>
      distanceMeters({ lat: decoded.stops[index].lat, lng: decoded.stops[index].lng }, match.coordinates) <= 25_000));
    result = allStopsNearby
      ? { cityCode: code, cityLabel: cityNameOf(code) || '城市待核实' }
      : { cityCode: '000000', cityLabel: '部分地点待核实' };
  } else {
    result = { cityCode: '000000', cityLabel: '城市待核实' };
  }
  while (planShareCityCache.size > 500) {
    const oldest = planShareCityCache.keys().next().value;
    if (oldest) planShareCityCache.delete(oldest); else break;
  }
  planShareCityCache.set(code, result);
  return result;
}

/** A single damaged/old share must not take down the public share list. */
async function resolvePlanShareCitySafely(code: string, provider: PlaceProvider) {
  try {
    return await resolvePlanShareCity(code, provider);
  } catch {
    return null;
  }
}

export const communityRoutes: RouteHandler = async (ctx, req) => {
  if (!req.path.startsWith('/api/v1/community')) return false;
  const auth = ctx.requireAuth(req.request, req.response);
  if (!auth) return true;
  // 社区是账号能力：游客（匿名主体）只读不写。审核员操作走独立凭证，不受此限制。
  const clearSamples = req.path === '/api/v1/community/samples' && req.method === 'DELETE';
  const moderatorAction = req.path === '/api/v1/community/moderation' || /\/decision$/.test(req.path) || clearSamples;
  // Long searches use a JSON body instead of a URL, but do not modify community data.
  const readOnlySearch = req.method === 'POST' && [
    '/api/v1/community/posts/search', '/api/v1/community/plan-shares/search',
  ].includes(req.path);
  if (req.method !== 'GET' && !readOnlySearch && !moderatorAction && ctx.accounts.profile(auth.actorId).kind !== 'account') {
    sendError(req.response, 403, 'LOGIN_REQUIRED', '社区需登录后使用：请到「我的」页登录或注册。');
    return true;
  }
  const service = ctx.communityService;
  const accountNickname = ctx.accounts.nicknameOf(auth.actorId);
  try {
    if (req.path === '/api/v1/community/posts/search' && req.method === 'POST') {
      const body = await readJson(req.request);
      if (typeof body.query !== 'string' || (body.cursor !== undefined && body.cursor !== null && typeof body.cursor !== 'string')) {
        sendError(req.response, 400, 'COMMUNITY_INPUT_INVALID', '请提供有效的搜索文字和分页游标。'); return true;
      }
      const page = service.listPostPage(auth.actorId, typeof body.cursor === 'string' ? body.cursor : null, parsePagination(req.url).limit, body.query);
      sendData(req.response, page.items, { nextCursor: page.nextCursor }); return true;
    }
    if (req.path === '/api/v1/community/posts') {
      if (req.method === 'GET') {
        const pagination = parsePagination(req.url);
        const query = req.url.searchParams.get('query') || '';
        // `stable=1` enables keyset pagination for the current client. Requests without it
        // keep the legacy numeric offset cursor contract.
        const page = req.url.searchParams.get('stable') === '1'
          ? service.listPostPage(auth.actorId, req.url.searchParams.get('cursor'), pagination.limit, query)
          : paginate(service.listPosts(auth.actorId, query), pagination);
        sendData(req.response, page.items, {nextCursor: page.nextCursor}); return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req.request);
        const suppliedRefs = Array.isArray(body.placeRefs)
          ? body.placeRefs
          : body.placeRef === undefined || body.placeRef === null ? [] : [body.placeRef];
        const validRefs = suppliedRefs.every((item) => Boolean(item && typeof item === 'object' && !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).placeId === 'string' &&
          typeof (item as Record<string, unknown>).name === 'string'));
        if (Array.isArray(body.placeRefs) && body.placeRefs.length > 12) {
          sendError(req.response, 400, 'COMMUNITY_INPUT_INVALID', '一篇帖子最多关联 12 个地点。'); return true;
        }
        if (validRefs && suppliedRefs.length) {
          const provider = ctx.options.placeProvider ?? ctx.fallbackPlaceProvider;
          const canonicalRefs = [];
          for (const item of suppliedRefs as Array<Record<string, unknown>>) {
            const placeId = String(item.placeId).trim();
            if (!placeId) {
              sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '关联地点不存在或尚未公开。'); return true;
            }
            let place;
            try { place = await provider.detail(placeId, 'demo'); }
            catch {
              sendError(req.response, 503, 'PROVIDER_UNAVAILABLE', '地点目录暂时无法核实关联地点，请稍后重试。', undefined, true);
              return true;
            }
            if (!place) {
              sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '关联地点不存在或尚未公开。'); return true;
            }
            canonicalRefs.push({ placeId: place.placeId, name: place.name });
          }
          body.placeRefs = canonicalRefs;
          delete body.placeRef;
        }
        sendData(req.response, service.publishPost(auth.actorId, body, accountNickname)); return true;
      }
    }
    if (req.path === '/api/v1/community/plan-shares' && ['GET', 'POST'].includes(req.method)) {
      if (req.method === 'GET') {
        const page = paginate(service.listPlanShares(auth.actorId, req.url.searchParams.get('query') || ''), parsePagination(req.url));
        const items = await Promise.all(page.items.map(async share => {
          const resolved = await resolvePlanShareCitySafely(share.code, ctx.fallbackPlaceProvider);
          return resolved ? { ...share, ...resolved } : share;
        }));
        sendData(req.response, items, { nextCursor: page.nextCursor });
        return true;
      }
      const body = await readJson(req.request);
      const resolvedCity = await resolvePlanShareCity(String(body.code || ''), ctx.fallbackPlaceProvider);
      sendData(req.response, service.publishPlanShare(auth.actorId, {
        ...body,
        ...resolvedCity,
        nickname: body.nickname || ctx.accounts.nicknameOf(auth.actorId),
      }, resolvedCity));
      return true;
    }
    const shareMatch = /^\/api\/v1\/community\/plan-shares\/([^/]+)$/.exec(req.path);
    if (shareMatch && req.method === 'DELETE') {
      sendData(req.response, service.removePlanShare(auth.actorId, decodeURIComponent(shareMatch[1])));
      return true;
    }
    if (req.path === '/api/v1/community/mine' && req.method === 'GET') {
      const mine = service.mine(auth.actorId);
      mine.planShares = await Promise.all(mine.planShares.map(async share => {
        const resolved = await resolvePlanShareCitySafely(share.code, ctx.fallbackPlaceProvider);
        return resolved ? { ...share, ...resolved } : share;
      }));
      sendData(req.response, mine); return true;
    }
    if (clearSamples) {
      if (!hasModeratorCredential(ctx, req.request)) {
        sendError(req.response, 403, 'REVIEWER_REQUIRED', '清除全局样例内容需要平台审核员凭证。'); return true;
      }
      sendData(req.response, service.clearSamples()); return true;
    }
    // 我的收藏的帖子列表（快照；原帖撤回后仍保留可辨认条目）。
    if (req.path === '/api/v1/community/post-favorites' && req.method === 'GET') {
      for (const entry of ctx.favoritesService.listPosts(auth.actorId)) {
        if (!service.postSnapshot(entry.post.postId, auth.actorId)) ctx.favoritesService.markPostWithdrawn(entry.post.postId);
      }
      sendData(req.response, ctx.favoritesService.listPosts(auth.actorId));
      return true;
    }
    if (req.path === '/api/v1/community/plan-shares/search' && req.method === 'POST') {
      const body = await readJson(req.request);
      const query = typeof body.query === 'string' ? body.query : '';
      const page = paginate(service.listPlanShares(auth.actorId, query), parsePagination(req.url));
      const items = await Promise.all(page.items.map(async share => {
        const resolved = await resolvePlanShareCitySafely(share.code, ctx.fallbackPlaceProvider);
        return resolved ? { ...share, ...resolved } : share;
      }));
      sendData(req.response, items, { nextCursor: page.nextCursor });
      return true;
    }
    const postImageMatch = /^\/api\/v1\/community\/posts\/([^/]+)\/images\/([^/]+)$/.exec(req.path);
    if (postImageMatch && req.method === 'GET') {
      const image = service.postImage(decodeURIComponent(postImageMatch[1]), decodeURIComponent(postImageMatch[2]), auth.actorId);
      if (!image) { sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '照片不存在或帖子已撤回。'); return true; }
      req.response.writeHead(200, {
        'content-type': image.mimeType,
        'content-length': image.data.byteLength,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      req.response.end(image.data);
      return true;
    }
    const postMatch = /^\/api\/v1\/community\/posts\/([^/]+)(?:\/(like|comments|favorite)(?:\/([^/]+))?)?$/.exec(req.path);
    if (postMatch) {
      const id = decodeURIComponent(postMatch[1]);
      if (req.method === 'PATCH' && !postMatch[2]) {
        const current = service.postDetail(id, auth.actorId);
        if (!current) { sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '帖子不存在或不可访问。'); return true; }
        if (!current.mine) { sendError(req.response, 403, 'POST_OWNER_REQUIRED', '只能修改自己帖子的可见范围。'); return true; }
        const body = await readJson(req.request);
        const post = service.updatePostVisibility(auth.actorId, id, body.visibility);
        if (post.visibility === 'private') ctx.favoritesService.removePostForOthers(id, auth.actorId);
        sendData(req.response, post); return true;
      }
      if (postMatch[2] && !(req.method === 'DELETE' && postMatch[2] === 'favorite') && !service.postDetail(id, auth.actorId)) {
        sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '帖子不存在或不可访问。'); return true;
      }
      if (req.method === 'GET' && !postMatch[2]) {
        const post = service.postDetail(id, auth.actorId);
        if (!post) { sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '帖子不存在或已撤回。'); return true; }
        sendData(req.response, post); return true;
      }
      if (req.method === 'DELETE' && !postMatch[2]) {
        const result = service.removePost(auth.actorId, id);
        ctx.favoritesService.markPostWithdrawn(id);
        sendData(req.response, result); return true;
      }
      if (req.method === 'POST' && postMatch[2] === 'like') { sendData(req.response, service.likePost(auth.actorId, id)); return true; }
      // 帖子收藏：POST 加入（存帖子快照），DELETE 取消；与地点收藏共用 FavoritesService。
      if (postMatch[2] === 'favorite') {
        if (req.method === 'POST') {
          const snapshot = service.postSnapshot(id, auth.actorId);
          if (!snapshot) { sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '帖子不存在或已被撤回。'); return true; }
          sendData(req.response, { favorited: true, postFavorites: ctx.favoritesService.addPost(auth.actorId, snapshot) });
          return true;
        }
        if (req.method === 'DELETE') {
          sendData(req.response, { favorited: false, postFavorites: ctx.favoritesService.removePost(auth.actorId, id) });
          return true;
        }
        sendError(req.response, 405, 'METHOD_NOT_ALLOWED', '帖子收藏只支持 POST 或 DELETE。');
        return true;
      }
      if (req.method === 'POST' && postMatch[2] === 'comments') { sendData(req.response, service.addComment(auth.actorId, id, await readJson(req.request), accountNickname)); return true; }
      if (req.method === 'DELETE' && postMatch[2] === 'comments' && postMatch[3]) {
        sendData(req.response, service.removeComment(auth.actorId, id, decodeURIComponent(postMatch[3]))); return true;
      }
    }

    if (req.path === '/api/v1/community/moderation' && req.method === 'GET') {
      if (!hasModeratorCredential(ctx, req.request)) {
        sendError(req.response, 403, 'REVIEWER_REQUIRED', '需要平台审核员凭证。'); return true;
      }
      sendData(req.response, service.moderation()); return true;
    }

    if (req.path === '/api/v1/community/places') {
      if (req.method === 'GET') {
        const page = paginate(service.list(auth.actorId, req.url.searchParams.get('query') || '', req.url.searchParams.get('tag') || '', {
          city: req.url.searchParams.get('city') || '',
          sort: req.url.searchParams.get('sort') || '',
        }), parsePagination(req.url));
        sendData(req.response, page.items, { nextCursor: page.nextCursor }); return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req.request);
        // 每个地点独一无二：同城同名的地点已在目录（含已收录社区分享）时不再接受重复分享。
        const name = String(body.name || '').trim();
        const cityCode = String(body.cityCode || '');
        const communityDuplicate = name && service.approvedPlaces({ cityCode })
          .some(place => place.name.trim() === name);
        if (communityDuplicate) {
          sendError(req.response, 400, 'PLACE_DUPLICATE', '目录里已有这个名字的地点，不能重复分享；可以直接收藏或加入计划。');
          return true;
        }
        if (name) {
          const provider = ctx.options.placeProvider ?? ctx.fallbackPlaceProvider;
          let search;
          try {
            search = await provider.search({ cityCode, query: name, limit: 50 });
          } catch {
            // A thrown lookup failure is just as inconclusive as a returned error.
            // Do not turn an upstream outage into a successful unchecked share.
            sendError(req.response, 503, 'PROVIDER_UNAVAILABLE', '地点目录暂时无法核验，请稍后重试。', undefined, true);
            return true;
          }
          if (search.error) {
            // Duplicate protection depends on the catalog lookup. If it failed,
            // do not accept a share that may duplicate an existing catalog POI.
            sendError(req.response, 503, search.error.code, search.error.message, undefined, true);
            return true;
          }
          const catalogHit = search.places.some(place => String(place.name).trim() === name);
          if (catalogHit) {
            sendError(req.response, 400, 'PLACE_DUPLICATE', '目录里已有这个名字的地点，不能重复分享；可以直接收藏或加入计划。');
            return true;
          }
        }
        sendData(req.response, service.publish(auth.actorId, body, accountNickname)); return true;
      }
    }
    const match = /^\/api\/v1\/community\/places\/([^/]+)(?:\/(reviews|submit|decision|reports))?$/.exec(req.path);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    if (req.method === 'DELETE' && !match[2]) { sendData(req.response, service.remove(id, auth.actorId)); return true; }
    if (req.method === 'GET' && !match[2]) {
      if (!service.has(id) || !service.canView(id, auth.actorId)) {
        sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '地点不存在或尚未公开。'); return true;
      }
      sendData(req.response, service.detail(id, auth.actorId)); return true;
    }
    if (req.method !== 'POST') return false;
    const body = await readJson(req.request);
    if (match[2] === 'reviews') {
      // 官方目录地点也能评价：不是社区分享时按地点 ID 归档用户评价。
      if (service.has(id)) { sendData(req.response, service.review(id, auth.actorId, body, accountNickname)); return true; }
      const provider = ctx.options.placeProvider ?? ctx.fallbackPlaceProvider;
      const place = await provider.detail(id, 'demo');
      if (!place) { sendError(req.response, 404, 'RESOURCE_NOT_FOUND', '地点不存在或暂未收录。'); return true; }
      sendData(req.response, service.reviewPlace(id, auth.actorId, body, accountNickname)); return true;
    }
    else if (match[2] === 'submit') sendData(req.response, service.submit(id, auth.actorId, body));
    else if (match[2] === 'reports') sendData(req.response, service.report(id, auth.actorId, body));
    else if (match[2] === 'decision') {
      if (!hasModeratorCredential(ctx, req.request)) {
        sendError(req.response, 403, 'REVIEWER_REQUIRED', '需要平台审核员凭证。'); return true;
      }
      sendData(req.response, service.decide(id, body));
    } else return false;
    return true;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    if (error instanceof PlaceProviderUnavailableError) throw error;
    if (error instanceof CommunityReviewConflictError) {
      sendError(req.response, 409, 'REVISION_CONFLICT', error.message); return true;
    }
    sendError(req.response, 400, 'COMMUNITY_INPUT_INVALID', error instanceof Error ? error.message : '操作失败。'); return true;
  }
};

function hasModeratorCredential(ctx: Parameters<RouteHandler>[0], request: Parameters<RouteHandler>[1]['request']): boolean {
  const expected = Buffer.from(ctx.options.communityAdminToken || '');
  const supplied = Buffer.from(String(request.headers['x-community-admin-token'] || ''));
  return Boolean(expected.length && expected.length === supplied.length && timingSafeEqual(expected, supplied));
}
