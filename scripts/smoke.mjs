import { createHttpServer } from '../dist/src/server/http-server.js';

const server = createHttpServer({ seedDemo: false });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server address unavailable');
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const health = await fetch(`${baseUrl}/api/v1/health`);
  const healthBody = await health.json();
  if (!health.ok || healthBody.data?.status !== 'ok') {
    throw new Error(`health check failed: ${health.status}`);
  }

  // 外壳是多文件 ES module：从入口把整张模块图抓下来再检查，
  // 而不是写死文件清单——否则新增一个 views/ 或 lib/ 模块就会让这里失效，
  // 而"页面 200 但某个模块 404"正是最该被冒烟测试抓住的半坏状态。
  const shell = new Map();
  const queue = ['/', '/styles.css', '/app.js'];
  while (queue.length > 0) {
    const path = queue.shift();
    if (shell.has(path)) continue;
    const response = await fetch(`${baseUrl}${path}`);
    if (!response.ok) throw new Error(`shell asset failed: ${path} -> ${response.status}`);
    const source = await response.text();
    shell.set(path, source);
    if (!path.endsWith('.js')) continue;
    for (const match of source.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      queue.push(new URL(match[1], `http://localhost${path}`).pathname);
    }
  }

  const bundle = [...shell.values()].join('\n');
  for (const marker of ['计划与进度', '发现地点', 'class="hero-card home-hero"', '--brand']) {
    if (!bundle.includes(marker)) throw new Error(`prototype page check failed: missing ${marker}`);
  }
  // 骨架必须引用样式与入口，否则页面会变成没有样式、点不动的裸 HTML。
  if (!shell.get('/').includes('/styles.css') || !shell.get('/').includes('/app.js')) {
    throw new Error('prototype page check failed: shell does not reference its assets');
  }
  // 模块图至少要走到 lib/ 与 views/，否则说明引用被写坏了。
  for (const required of ['/lib/format.js', '/lib/components.js', '/views/home.js']) {
    if (!shell.has(required)) throw new Error(`module graph missing ${required}`);
  }

  const guest = await fetch(`${baseUrl}/api/v1/session/guest`, { method: 'POST' });
  if (!guest.ok) throw new Error(`guest session failed: ${guest.status}`);

  console.log('SMOKE=PASS');
  console.log(`HEALTH=${JSON.stringify(healthBody.data)}`);
  console.log(`SHELL_FILES=${shell.size}`);
  console.log(
    `SHELL_BYTES=${[...shell.values()].reduce((total, text) => total + text.length, 0)}`,
  );
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
}
