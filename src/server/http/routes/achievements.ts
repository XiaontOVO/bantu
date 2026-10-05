import type { RouteHandler } from '../router.js';
import { sendData } from '../respond.js';
import { travelAchievements } from '../../../services/travel-achievements.js';

export const achievementRoutes: RouteHandler = async (ctx, req) => {
  if (req.path !== '/api/v1/achievements' || req.method !== 'GET') return false;
  const auth = ctx.requireAuth(req.request, req.response);
  if (auth) sendData(req.response, travelAchievements(ctx.planLibrary, auth.actorId));
  return true;
};
