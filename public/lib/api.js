/**
 * HTTP 客户端。
 *
 * 服务端统一返回 `{ data, meta }` / `{ error, meta }`，因此这里只做两件事：
 * 解包 `data`，以及在失败时抛出**服务端给的中文消息**——界面直接展示它，
 * 不需要自己翻译错误码。
 *
 * 额外处理一种情况：服务重启会清空内存会话，页面里的旧凭证会收到
 * 401 SESSION_EXPIRED。此时自动重建匿名会话并刷新页面（8 秒内只恢复一次，
 * 防止服务持续不可用时无限刷新），刷新完成后提示一次“连接已恢复”。
 */

import { state } from './store.js';
import { pauseAccountContext, announceAccountChange, accountContextEpoch } from './account-context.js';
import { requestDeadline, apiTimeout } from './http-request.js';

const RECOVER_FLAG = 'bantu:session-recovered';
const RECOVER_ATTEMPT = 'bantu:session-recovery-at';
const RECOVER_WINDOW_MS = 8000;
let lastRecoveryAttempt = 0;

export async function api(path, options = {}, envelope = false) {
  if (state.accountContextChanged) throw new Error('账号已在其他页面切换，请先核对账号。输入仍保留在当前页面。');
  const expectedPrincipal = state.principal?.principalId;
  const expectedKind = state.principal?.kind, expectedContext = accountContextEpoch();
  const {timeoutMs, ...requestOptions} = options;
  const deadline = requestDeadline(options,apiTimeout(path,options.method || 'GET'));
  try {
    deadline.signal.throwIfAborted();
    const response = await deadline.wait(fetch(path, {
      credentials: 'same-origin',
      ...requestOptions,
      signal:deadline.signal,
      headers: { 'content-type': 'application/json', ...(options.headers || {}),
        ...(expectedPrincipal && path !== '/api/v1/session/guest' ? { 'x-bantu-principal': expectedPrincipal } : {}) },
    }));
    let body;
    try { body = await deadline.wait(response.json()); }
    catch (error) {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      if (response.ok) throw new Error('服务器返回的数据无法读取，请检查结果后重试。');
      body = {};
    }
    if (state.accountContextChanged || expectedKind !== state.principal?.kind || expectedPrincipal !== state.principal?.principalId) throw new Error('账号已切换，请重新核对；刚才的回执未应用到当前页面。');
    if (expectedContext !== accountContextEpoch()) throw Object.assign(new Error('账号已重新核对，较早的回执未应用到当前页面。请重新查看刚才操作的结果。'), {code:'ACCOUNT_CONTEXT_STALE'});
    if (!response.ok) {
      if (body?.error?.code === 'SESSION_CHANGED') {
        pauseAccountContext();
        throw new Error(body.error.message);
      }
      if (response.status === 401 && body?.error?.code === 'SESSION_EXPIRED' && !path.startsWith('/api/v1/session')) {
        if (await recoverSession(expectedPrincipal, expectedKind, expectedContext)) { location.reload(); throw Object.assign(new Error('会话已恢复，正在重新打开页面。'),{code:'SESSION_RECOVERED'}); }
        throw new Error('连接已失效，请刷新页面重试。');
      }
      throw Object.assign(new Error(body?.error?.message || `HTTP ${response.status}`), {
        status: response.status, code: body?.error?.code || '',
      });
    }
    if (!body || typeof body !== 'object' || !Object.hasOwn(body,'data')) throw new Error('服务器返回的数据不完整，请检查结果后重试。');
    return envelope ? body : body.data;
  } finally { deadline.dispose(); }
}

/** 服务重启等原因导致会话失效时，静默重建匿名会话。8 秒内只尝试一次。 */
async function recoverSession(expectedPrincipal, expectedKind, expectedContext) {
  let stored = 0;
  try { stored = Number(sessionStorage.getItem(RECOVER_ATTEMPT) || 0); } catch { /* Runtime throttle works without storage. */ }
  const last = Math.max(lastRecoveryAttempt,stored), now = Date.now();
  if (last && now - last < RECOVER_WINDOW_MS) return false;
  lastRecoveryAttempt = now;
  try { sessionStorage.setItem(RECOVER_ATTEMPT,String(now)); } catch { /* Storage is optional. */ }
  const deadline = requestDeadline({timeoutMs:15000});
  try {
    const response = await deadline.wait(fetch('/api/v1/session/guest', { method: 'POST', credentials: 'same-origin',signal:deadline.signal }));
    const body = await deadline.wait(response.json());
    if (expectedPrincipal !== state.principal?.principalId || expectedKind !== state.principal?.kind || expectedContext !== accountContextEpoch() || state.accountContextChanged) return false;
    if (!response.ok || !body?.data || typeof body.data !== 'object') return false;
    if (response.ok) { try { sessionStorage.setItem(RECOVER_FLAG,'1'); } catch { /* Storage is optional. */ } }
    if (response.ok && body.data?.previousSessionInvalid) {
      try { sessionStorage.setItem('bantu:session-invalid', '1'); } catch { /* Storage is optional. */ }
    }
    if (response.ok) announceAccountChange();
    return response.ok;
  } catch { return false; }
  finally { deadline.dispose(); }
}
