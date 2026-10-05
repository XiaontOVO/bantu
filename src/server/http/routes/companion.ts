import { readJson } from '../request.js';
import { sendData, sendError } from '../respond.js';
import type { RouteHandler } from '../router.js';
import { CompanionContextError, readCompanionContext } from '../../../services/companion-context.js';
import { applyCompanionAdvice, createCompanionAdvice } from '../../../services/companion-advice.js';

export const companionRoutes: RouteHandler = async (ctx, req) => {
  const match = /^\/api\/v1\/plans\/([^/]+)\/companion\/(context|advice|apply)$/.exec(req.path);
  if (!match || req.method !== 'POST') return false;
  const auth = ctx.requireAuth(req.request, req.response);
  if (!auth) return true;
  try {
    const body = await readJson(req.request);
    const id = decodeURIComponent(match[1]!);
    const result = match[2] === 'context' ? await readCompanionContext(ctx, auth.actorId, id, body)
      : match[2] === 'advice' ? await createCompanionAdvice(ctx, auth.actorId, id, body)
      : applyCompanionAdvice(ctx, auth.actorId, id, body);
    sendData(req.response, result);
  } catch (error) {
    if (!(error instanceof CompanionContextError)) throw error;
    sendError(req.response, error.status, error.code, error.message);
  }
  return true;
};
