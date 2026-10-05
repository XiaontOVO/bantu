/** 健康检查与就绪检查；供启动脚本和诊断工具使用。 */
import { sendData } from '../respond.js';
import { parseCookies } from '../request.js';
import type { RouteHandler } from '../router.js';

export const healthRoutes: RouteHandler = async (ctx, req) => {
  // The place provider is wrapped with the community directory during
  // bootstrap, so checking whether the option is truthy would label the
  // default offline catalog as online. Provider names survive that wrapper
  // and are the reliable source for the health response.
  const placeProviderName = ctx.options.placeProvider?.providerName || 'demo_place_catalog';
  const routeProviderName = ctx.options.routeProvider?.providerName || 'demo_route_estimator';
  const placeOnline = placeProviderName !== 'demo_place_catalog';
  const routeOnline = routeProviderName !== 'demo_route_estimator';
  const dataMode = placeOnline || routeOnline ? 'online' : 'demo';
  if (req.path === '/api/v1/health' && req.method === 'GET') {
    sendData(req.response, {
      status: 'ok',
      dataMode,
      service: ctx.stateStore ? 'sqlite' : 'in-memory',
    });
    return true;
  }
  if (req.path === '/api/v1/ready' && req.method === 'GET') {
    const auth = ctx.currentAuth(req.request);
    const actorId = auth && ctx.service.validateSession(auth.actorId, auth.sessionId, parseCookies(req.request).bantu_session) ? auth.actorId : undefined;
    const provider = ctx.modelProviderForActor(actorId);
    const settings = ctx.options.userModelSettings!.view(actorId, ctx.options.modelProvider);
    sendData(req.response, {
      status: 'ok',
      dataMode,
      service: ctx.stateStore ? 'sqlite' : 'in-memory',
      agentService: { source: settings.mode, enabled: settings.enabled, officialAvailable: settings.official.enabled,
        ...(!settings.enabled&&settings.thinkingStatus?{message:settings.thinkingStatus.message}:{}) },
      checks: {
        stateStore: ctx.stateStore ? 'sqlite' : 'memory',
        agentOperations: 'in-memory',
        modelProvider: provider && provider.providerName !== 'scripted' ? 'online_adapter' : 'scripted_demo',
        agentMode: provider && provider.providerName !== 'scripted' ? 'tools' : 'rules',
        placeProvider: placeOnline ? 'configured' : 'demo',
        routeProvider: routeOnline ? 'configured' : 'demo',
        rateLimiter: 'process_local',
      },
    });
    return true;
  }
  return false;
};
