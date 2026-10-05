const CACHE_NAME = 'bantu-shell-v191';
// 只预缓存入口；lib/ 与 views/ 下的模块由 fetch 处理器在首次请求时自动缓存，
// 这样新增前端模块不必同步修改这份清单（漏改会导致离线时白屏）。
const SHELL = ['/', '/index.html', '/styles.css', '/product-design.css', '/smart-companion.css', '/images/brand/city-day.svg', '/app.js', '/boot-recovery.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith('bantu-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求网络优先。这个原型的 API 本来就要本机 Node 服务在跑，
  // 离线外壳价值有限，而缓存优先会让修好的页面一直被执行旧副本挡住。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('/index.html')) ?? Response.error()),
    );
    return;
  }

  // Preview assets use the network first so a refresh shows the current build.
  // An unavailable script must not receive HTML as a fallback.
  if (url.origin !== self.location.origin) return;
  // Storage is optional: quota or cache failures must never discard a successful
  // online response. Clone before delivering it, then cache in the background.
  let cacheCopy;
  const network = fetch(request).then((response) => {
    if (response.ok) cacheCopy = response.clone();
    return response;
  });
  event.waitUntil(network.then(async () => {
    if (!cacheCopy) return;
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, cacheCopy);
    } catch { /* Cache storage may be unavailable; online loading still works. */ }
  }).catch(() => {}));
  event.respondWith(network.catch(async () => {
    try { return (await caches.match(request)) ?? Response.error(); }
    catch { return Response.error(); }
  }));
});
