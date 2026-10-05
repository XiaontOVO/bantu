/**
 * 启动兜底（经典脚本，不依赖任何模块）：模块加载失败（离线/缓存冲突）时应用代码
 * 完全不会执行，这里在 6 秒后亮出可操作的恢复界面，而不是永远卡在骨架屏。
 * 可用页面或明确的启动错误已显示时，不再叠加遮罩；完整启动由 app.js 单独标记。
 */
window.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () {
    if (window.__bantuBooted || window.__bantuUiReady || window.__bantuRecoveryShown) return;
    var el = document.getElementById('boot-recovery');
    if (el) el.hidden = false;
  }, 6000);
});

document.addEventListener('click', function (event) {
  var action = event.target.closest && event.target.closest('[data-boot-action]');
  if (!action) return;
  if (action.dataset.bootAction === 'retry') { location.reload(); return; }
  if (action.dataset.bootAction === 'clear-cache') {
    navigator.serviceWorker.getRegistrations()
      .then(function (registrations) { return Promise.all(registrations.map(function (registration) { return registration.unregister(); })); })
      .then(function () { if (window.caches) return caches.keys().then(function (keys) { return Promise.all(keys.map(function (key) { return caches.delete(key); })); }); })
      .then(function () { location.reload(); });
  }
});
