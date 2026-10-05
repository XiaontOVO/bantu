/** Bound fetch and body reads even when a device/network fails to honor AbortSignal. */
export function requestDeadline(options = {}, fallback = 30000) {
  const controller = new AbortController(), external = options.signal;
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : fallback;
  const onAbort = () => controller.abort(external.reason || new DOMException('请求已取消','AbortError'));
  if (external?.aborted) onAbort(); else external?.addEventListener('abort',onAbort,{once:true});
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('连接超时，请检查连接或已保存的结果后重试。'),{name:'TimeoutError',code:'REQUEST_TIMEOUT'})),timeout);
  // Browsers use numeric timers. CLI fixtures must not be kept alive by a
  // discarded page's deadline after their owned operations have completed.
  timer.unref?.();
  const wait = promise => new Promise((resolve,reject) => {
    const abort = () => reject(controller.signal.reason || new DOMException('请求已取消','AbortError'));
    if (controller.signal.aborted) { Promise.resolve(promise).catch(()=>{}); abort(); return; }
    controller.signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(() => controller.signal.removeEventListener('abort',abort));
  });
  return {signal:controller.signal,wait,dispose(){clearTimeout(timer);external?.removeEventListener('abort',onAbort);}};
}

export function apiTimeout(path, method) {
  return String(method).toUpperCase() === 'POST' && (/\/agent\/chat(?:\?|$)/.test(path) || /\/trips\/[^/]+\/messages(?:\?|$)/.test(path)) ? 300000 : 30000;
}
