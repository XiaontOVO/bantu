import { readJson } from '../request.js';
import { sendData, sendError, sendRateLimited } from '../respond.js';
import type { RouteHandler } from '../router.js';

/** Cookie-derived owner only; remote users cannot modify the official provider. */
export const userModelSettingsRoutes: RouteHandler = async (ctx, req) => {
  if (!['/api/v1/me/model', '/api/v1/me/model/test','/api/v1/me/model/preferences'].includes(req.path)) return false;
  const { request, response, method } = req;
  const auth = ctx.requireAuth(request, response);
  if (!auth) return true;
  const manager = ctx.options.userModelSettings!;
  const canConfigure = ctx.accounts.profile(auth.actorId).kind === 'account';
  const view = () => ({ ...manager.view(auth.actorId, ctx.options.modelProvider), canConfigure });
  if(req.path.endsWith('/preferences')) {
    if(method!=='POST')return false;
    const input=await readJson(request);
    try {manager.setThinking(auth.actorId,input,ctx.options.modelProvider);sendData(response,{...view(),message:'思考偏好已保存，从下一次请求开始生效。'})}
    catch(error){sendError(response,400,'MODEL_CONFIGURATION_FAILED',error instanceof Error?error.message:'思考设置失败，原设置保留。')}
    return true;
  }
  if (method === 'GET' && !req.path.endsWith('/test')) { sendData(response, view()); return true; }
  if (method !== 'POST' && !(method === 'DELETE' && !req.path.endsWith('/test'))) return false;
  if (!canConfigure) { sendError(response, 403, 'ACCOUNT_REQUIRED', '游客可直接使用官方服务；请登录或注册后保存自己的 API。'); return true; }
  const body = method === 'POST' ? await readJson(request) : {};
  try {
    if (method === 'DELETE') {
      manager.remove(auth.actorId);
      sendData(response, { ...view(), message: '自有 API 和密钥已删除，已切回官方服务。' }); return true;
    }
    if (body.mode === 'official' && !req.path.endsWith('/test')) {
      manager.useOfficial(auth.actorId);
      sendData(response, { ...view(), message: '已切回官方服务，自有 API 设置已保留。' }); return true;
    }
    if (body.mode !== 'custom') { sendError(response, 400, 'INVALID_INPUT', '请选择官方服务或自行接入。'); return true; }
    const limit = ctx.rateLimiter.consume(`model-test:${auth.actorId}`, 6, 60);
    if (!limit.allowed) { sendRateLimited(response, limit.retryAfterSeconds, '连接测试过于频繁，请稍后再试。'); return true; }
    const save = !req.path.endsWith('/test');
    await manager.test(auth.actorId, body, save);
    sendData(response, { ...view(), tested: true, message: save ? '连接与工具调用测试通过，已启用你的 API。' : '连接与工具调用测试通过，尚未切换服务。' });
  } catch (error) {
    const message = error instanceof Error && /^[\u4e00-\u9fff]/.test(error.message) ? error.message : '保存或测试失败，原有设置保持不变，请重试。';
    sendError(response, 400, 'MODEL_CONFIGURATION_FAILED', message);
  }
  return true;
};
