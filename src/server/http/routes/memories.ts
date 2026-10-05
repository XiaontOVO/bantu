/**
 * 旅行记录（随手记与回顾）与候选收藏。
 *
 * 记录只写真实素材：`contentRevision` 走版本校验，草稿不会因为别的改动自我失效。
 * 收藏是独立清单，增删都不改正式计划。
 */
import { randomUUID } from 'node:crypto';
import { paginate, parsePagination, readJson } from '../request.js';
import { sendData, sendServiceError } from '../respond.js';
import type { RouteHandler } from '../router.js';

const MEMORY_LIST = /^\/api\/v1\/trips\/([^/]+)\/(memories|recaps)$/;
const MEMORY_DETAIL = /^\/api\/v1\/trips\/([^/]+)\/memories\/([^/]+)$/;
const SHORTLIST_LIST = /^\/api\/v1\/trips\/([^/]+)\/shortlist$/;
const SHORTLIST_DETAIL = /^\/api\/v1\/trips\/([^/]+)\/shortlist\/([^/]+)$/;

export const memoryRoutes: RouteHandler = async (ctx, req) => {
  const { path, method, url, request, response } = req;

  // Personal notes are account-owned and intentionally independent from Trip.
  const personalMatch = /^\/api\/v1\/memories(?:\/([^/]+))?$/.exec(path);
  if (personalMatch) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const memoryId = personalMatch[1] ? decodeURIComponent(personalMatch[1]) : undefined;

    if (method === 'GET' && !memoryId) {
      const result = paginate(ctx.personalMemoriesService.list(auth.actorId), parsePagination(url));
      sendData(response, result.items, { nextCursor: result.nextCursor });
      return true;
    }
    if (method === 'GET' && memoryId) {
      const memory = ctx.personalMemoriesService.list(auth.actorId).find(item => item.memoryId === memoryId);
      if (!memory) sendServiceError(response, { error: { code: 'RESOURCE_NOT_FOUND', message: '这条笔记不存在。' } });
      else sendData(response, memory);
      return true;
    }
    if (method === 'POST' && !memoryId) {
      const body = await readJson(request);
      const userText = typeof body.userText === 'string'
        ? body.userText
        : typeof body.text === 'string' ? body.text : '';
      const result = ctx.personalMemoriesService.create(auth.actorId, {
        title: typeof body.title === 'string' ? body.title : undefined,
        content: typeof body.content === 'string' ? body.content : undefined,
        userText,
        localDate: typeof body.localDate === 'string' ? body.localDate : undefined,
      });
      if (!result.ok) sendServiceError(response, result);
      else sendData(response, result.value);
      return true;
    }
    if (method === 'PATCH' && memoryId) {
      const body = await readJson(request);
      const userText = typeof body.userText === 'string'
        ? body.userText
        : typeof body.text === 'string' ? body.text : undefined;
      const result = ctx.personalMemoriesService.patch(auth.actorId, memoryId, {
        expectedEntryVersion: body.expectedEntryVersion as number | undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        content: typeof body.content === 'string' ? body.content : undefined,
        userText,
        localDate: typeof body.localDate === 'string' ? body.localDate : body.localDate === null ? null : undefined,
      });
      if (!result.ok) sendServiceError(response, result);
      else sendData(response, result.value);
      return true;
    }
    if (method === 'DELETE' && memoryId) {
      const result = ctx.personalMemoriesService.delete(auth.actorId, memoryId);
      if (!result.ok) sendServiceError(response, result);
      else sendData(response, result.value);
      return true;
    }
    return false;
  }

  const listMatch = MEMORY_LIST.exec(path);
  if (listMatch) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(listMatch[1]);
    const kind = listMatch[2];

    if (kind === 'memories' && method === 'GET') {
      const result = ctx.service.listMemories(auth.actorId, tripId);
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      const page = paginate(result.value.slice().reverse(), parsePagination(url));
      sendData(response, page.items, { nextCursor: page.nextCursor });
      return true;
    }

    if (kind === 'memories' && method === 'POST') {
      const body = await readJson(request);
      if (body.kind === 'journey') {
        const result = ctx.service.generateJourneyMemory(
          auth.actorId,
          tripId,
          String(body.localDate ?? ''),
        );
        if (!result.ok) {
          sendServiceError(response, result);
          return true;
        }
        sendData(response, result.value);
        return true;
      }
      const result = ctx.service.createMemory(auth.actorId, tripId, {
        userText: String(body.userText ?? ''),
        localDate: typeof body.localDate === 'string' ? body.localDate : undefined,
        memoryId: typeof body.memoryId === 'string' ? body.memoryId : undefined,
        sourceEventIds: Array.isArray(body.sourceEventIds) ? body.sourceEventIds.map(String) : [],
        sourceMessageIds: Array.isArray(body.sourceMessageIds)
          ? body.sourceMessageIds.map(String)
          : [],
        expectedContentRevision:
          typeof body.expectedContentRevision === 'number'
            ? body.expectedContentRevision
            : undefined,
      });
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value);
      return true;
    }

    if (kind === 'recaps' && method === 'POST') {
      const body = await readJson(request);
      const result = ctx.service.generateRecap(auth.actorId, tripId, {
        userText: String(body.userText ?? '按照真实记录生成的回顾草稿。'),
        baseContentRevision: Number(body.baseContentRevision),
        originOperationId: String(body.operationId ?? `op_recap_${randomUUID()}`),
      });
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value);
      return true;
    }
    return false;
  }

  const detailMatch = MEMORY_DETAIL.exec(path);
  if (detailMatch) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(detailMatch[1]);
    const memoryId = decodeURIComponent(detailMatch[2]);

    if (method === 'GET') {
      const result = ctx.service.listMemories(auth.actorId, tripId);
      if (!result.ok) { sendServiceError(response, result); return true; }
      const memory = result.value.find((entry) => entry?.memoryId === memoryId);
      if (!memory) { sendServiceError(response, { error: { code: 'RESOURCE_NOT_FOUND', message: '记录不存在。' } }); return true; }
      sendData(response, memory); return true;
    }

    if (method === 'PATCH') {
      const body = await readJson(request);
      const result = ctx.service.patchMemory(auth.actorId, tripId, memoryId, {
        userText: typeof body.userText === 'string' ? body.userText : undefined,
        status: body.status === 'saved' ? 'saved' : body.status === 'draft' ? 'draft' : undefined,
        expectedContentRevision: Number(body.expectedContentRevision),
        expectedEntryVersion: Number(body.expectedEntryVersion),
      });
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value);
      return true;
    }
    if (method === 'DELETE') {
      const result = ctx.service.deleteMemory(auth.actorId, tripId, memoryId);
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value);
      return true;
    }
    return false;
  }

  if (SHORTLIST_LIST.test(path)) {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(SHORTLIST_LIST.exec(path)![1]);
    if (method === 'GET') {
      const result = ctx.service.listShortlist(auth.actorId, tripId);
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value);
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const result = ctx.service.addShortlist(auth.actorId, tripId, String(body.placeId));
      if (!result.ok) {
        sendServiceError(response, result);
        return true;
      }
      sendData(response, result.value);
      return true;
    }
    return false;
  }

  const shortlistMatch = SHORTLIST_DETAIL.exec(path);
  if (shortlistMatch && method === 'DELETE') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const result = ctx.service.removeShortlist(
      auth.actorId,
      decodeURIComponent(shortlistMatch[1]),
      decodeURIComponent(shortlistMatch[2]),
    );
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value);
    return true;
  }

  return false;
};
