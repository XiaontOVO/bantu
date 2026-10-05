/**
 * 前端模块图守卫。
 *
 * 拆成多个 ES module 之后，最危险的失败是"路径写错"——浏览器只在控制台报
 * Failed to fetch dynamically imported module，页面白屏，而 node --check 查不出来。
 * 这里从入口出发做一次广度优先，逐个 import 规格符去服务器上取，确认全都能解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { createHttpServer } from '../src/server/http-server.js';
import { frontendScriptPaths } from './ui-source.js';

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createHttpServer({ seedDemo: false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 抽出 import ... from '...' 里的规格符（含副作用 import）。 */
function importSpecifiers(source: string): string[] {
  const specs = [];
  for (const match of source.matchAll(/from\s+'([^']+)'/g)) specs.push(match[1]);
  for (const match of source.matchAll(/^\s*import\s+'([^']+)'/gm)) specs.push(match[1]);
  return specs;
}

async function entryScripts(): Promise<string[]> {
  const html = await readFile(join(process.cwd(), 'public/index.html'), 'utf8');
  return [...html.matchAll(/<script[^>]+src="(\/[^"]+\.js)"/g)].map(match => match[1]);
}

test('every frontend module import resolves through the server', async () => {
  await withServer(async (baseUrl) => {
    const seen = new Set();
    const queue = await entryScripts();
    const visited = [];

    while (queue.length > 0) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);

      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, `${path} 取不到（import 路径可能写错了）`);
      assert.ok(
        response.headers.get('content-type')?.includes('javascript'),
        `${path} 的 content-type 不是 javascript`,
      );
      const source = await response.text();
      visited.push(path);

      for (const spec of importSpecifiers(source)) {
        if (!spec.startsWith('.')) continue; // 只跟同源相对模块
        const resolved = new URL(spec, `http://localhost${path}`).pathname;
        queue.push(resolved);
      }
    }

    // 至少覆盖入口 + lib/ + views/，否则说明 BFS 没真正走起来。
    assert.ok(visited.length >= 10, `只访问到 ${visited.length} 个模块，模块图疑似没走通`);
    assert.ok(visited.includes('/lib/format.js'), '未走到 lib/format.js');
    assert.ok(visited.includes('/lib/components.js'), '未走到 lib/components.js');
    assert.ok(visited.includes('/views/home.js'), '未走到 views/home.js');
  });
});

test('every frontend module is reachable from the entry on disk', async () => {
  // 比上面那条 HTTP 版本更早反馈：直接在磁盘上走图，并且要求
  // lib/ 与 views/ 下**没有孤儿模块**（写了文件却没被任何地方引用）。
  const publicDir = join(process.cwd(), 'public');
  const seen = new Set();
  const queue = (await entryScripts()).map(path => normalize(path.slice(1)));

  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);

    const source = await readFile(join(publicDir, rel), 'utf8');
    for (const match of source.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const target = normalize(join(dirname(rel), match[1]));
      assert.equal(
        target.startsWith('..'),
        false,
        `${rel} 引用了 public/ 之外的 ${match[1]}`,
      );
      // 断链在这里就会抛 ENOENT，报出是哪个文件引了不存在的模块。
      const exists = await readFile(join(publicDir, target), 'utf8').then(
        () => true,
        () => false,
      );
      assert.ok(exists, `${rel} 引用了不存在的模块 ${match[1]}（解析为 ${target}）`);
      queue.push(target);
    }
  }

  const all = await frontendScriptPaths();
  const orphans = all.filter((path) => !seen.has(path) && path !== 'app.js');
  assert.deepEqual(orphans, [], `存在没有被引用的前端模块: ${orphans.join(', ')}`);
  assert.ok(seen.size >= 10, `模块图只有 ${seen.size} 个节点，疑似没走通`);
});

test('frontend modules are not cached, so edits take effect on reload', async () => {
  await withServer(async (baseUrl) => {
    for (const path of ['/app.js', '/lib/format.js', '/styles.css']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(
        response.headers.get('cache-control'),
        'no-store',
        `${path} 不该被缓存（旧副本会让修改变得不生效）`,
      );
    }
  });
});

test('local collection fonts are WOFF2 binaries served under the same-origin font policy', async () => {
  await withServer(async baseUrl => {
    const shell = await fetch(baseUrl + '/');
    assert.match(shell.headers.get('content-security-policy') || '', /font-src 'self'/);
    for (const name of ['bantu-collection-serif-title.woff2', 'bantu-collection-serif.woff2']) {
      const response = await fetch(baseUrl + '/fonts/' + name);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'font/woff2');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
      if (name.includes('-title')) assert.ok(bytes.length < 120_000, 'normal collection viewing should not fetch a full Chinese font');
    }
    assert.equal((await fetch(baseUrl + '/fonts/%2e%2e%2f%2e%2e%2ftmp/font.woff2')).status, 404);
  });
});

test('static serving refuses to escape the public directory', async () => {
  await withServer(async (baseUrl) => {
    // 目录穿越：即便路径被解码成 ../，也不允许读到 public/ 之外的文件。
    for (const attempt of [
      '/lib/%2e%2e%2fpackage.json',
      '/%2e%2e%2fpackage.json',
      '/../package.json',
      '/lib/../../package.json',
    ]) {
      const response = await fetch(`${baseUrl}${attempt}`);
      assert.equal(response.status, 404, `${attempt} 不应被提供`);
    }
    // 同时确认不在白名单里的扩展名一律拒绝。
    const json = await fetch(`${baseUrl}/package.json`);
    assert.equal(json.status, 404, 'package.json 不属于外壳资源');
  });
});

test('the server does not hardcode a module list', async () => {
  // 回归：静态白名单若退回"逐文件登记"，新增 lib/views 模块就会 404，
  // 且只有浏览器控制台能发现。这里直接看实现是否仍按扩展名白名单解析。
  const source = await readFile(`${process.cwd()}/src/server/http/static.ts`, 'utf8');
  assert.ok(source.includes('SERVABLE_EXTENSIONS'), '静态服务应使用扩展名白名单');
  assert.ok(source.includes("'.js'"), '静态服务应支持 .js');
  assert.equal(
    /'\/lib\/format\.js'/.test(source),
    false,
    '不应把具体模块硬编码进静态白名单',
  );
});
