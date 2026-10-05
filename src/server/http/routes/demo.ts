/**
 * 用户反馈接口。
 *
 * - `feedback`：自愿评分，不参与规划 revision。
 */
import { readJson } from '../request.js';
import { sendData, sendServiceError } from '../respond.js';
import type { RouteHandler } from '../router.js';
const FEEDBACK = /^\/api\/v1\/trips\/([^/]+)\/feedback$/;

export const demoRoutes: RouteHandler = async (ctx, req) => {
  const { path, method, request, response } = req;
  const service = ctx.service;

  const feedbackMatch = FEEDBACK.exec(path);
  if (feedbackMatch && method === 'POST') {
    const auth = ctx.requireAuth(request, response);
    if (!auth) return true;
    const tripId = decodeURIComponent(feedbackMatch[1]);
    if (!ctx.requireOwnedTrip(auth, tripId, response)) return true;
    const body = await readJson(request);
    const result = service.recordFeedback(auth.actorId, tripId, {
      rating: typeof body.rating === 'number' ? body.rating : null,
      reasonCode: typeof body.reasonCode === 'string' ? body.reasonCode : null,
      note: typeof body.note === 'string' ? body.note : null,
      operationId: typeof body.operationId === 'string' ? body.operationId : null,
    });
    if (!result.ok) {
      sendServiceError(response, result);
      return true;
    }
    sendData(response, result.value);
    return true;
  }

  return false;
};
