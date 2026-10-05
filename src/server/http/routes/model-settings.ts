import { readJson } from '../request.js';
import { sendData, sendError } from '../respond.js';
import type { RouteHandler } from '../router.js';

export const modelSettingsRoutes: RouteHandler = async (ctx, req) => {
  if (!['/api/v1/settings/model', '/api/v1/settings/model/test'].includes(req.path)) return false;
  const { request, response, method } = req;
  const manager = ctx.options.modelSettings;
  const peer = request.socket.remoteAddress;
  const host = request.headers.host || '';
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  if (!manager || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer || '') || !localHost ||
      (request.headers.origin && request.headers.origin !== `http://${host}` && request.headers.origin !== `https://${host}`)) {
    sendError(response, 403, 'LOCAL_SETTINGS_ONLY', '模型配置只允许在本机页面管理。'); return true;
  }
  if (!ctx.requireAuth(request, response)) return true;
  if (method === 'GET') { sendData(response, manager.view()); return true; }
  if (method === 'POST') {
    const body = await readJson(request);
    try {
      const result = await manager.test(body, !req.path.endsWith('/test'));
      ctx.options.modelProvider = manager.provider;
      ctx.agentService.setModelProvider(manager.provider);
      sendData(response, result);
    } catch (error) { sendError(response, 400, 'MODEL_CONFIGURATION_FAILED', error instanceof Error ? error.message : '配置失败。'); }
    return true;
  }
  if (method === 'DELETE' && !req.path.endsWith('/test')) {
    const result = manager.disable();
    ctx.options.modelProvider = undefined; ctx.agentService.setModelProvider(undefined);
    sendData(response, result); return true;
  }
  return false;
};
