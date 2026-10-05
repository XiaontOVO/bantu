import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createHttpServer } from '../src/server/http-server.js';

test('prototype exposes an installable PWA shell', async () => {
  const html = await readFile(`${process.cwd()}/public/index.html`, 'utf8');
  const app = await readFile(`${process.cwd()}/public/app.js`, 'utf8');
  const manifestText = await readFile(`${process.cwd()}/public/manifest.webmanifest`, 'utf8');
  const manifest = JSON.parse(manifestText) as {
    name: string;
    display: string;
    start_url: string;
  };
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.name.includes('伴途'));
  assert.ok(html.includes('/manifest.webmanifest'));
  // 注册逻辑在外壳脚本里，不在 HTML 内联块中。
  assert.ok(app.includes("navigator.serviceWorker.register('/sw.js')"));

  const server = createHttpServer({ seedDemo: false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.ok(manifestResponse.headers.get('content-type')?.includes('manifest'));
    const swResponse = await fetch(`${baseUrl}/sw.js`);
    assert.equal(swResponse.status, 200);
    assert.ok(swResponse.headers.get('content-type')?.includes('javascript'));
    const iconResponse = await fetch(`${baseUrl}/icon.svg`);
    assert.equal(iconResponse.status, 200);
    assert.ok(iconResponse.headers.get('content-type')?.includes('svg'));

    // 外壳分成三个文件后，样式与脚本也必须由静态白名单提供；
    // 漏登记会让页面变成"没有样式、点不动的裸 HTML"，而 marker 测试发现不了。
    const cssResponse = await fetch(`${baseUrl}/styles.css`);
    assert.equal(cssResponse.status, 200, '/styles.css must be served');
    assert.ok(cssResponse.headers.get('content-type')?.includes('text/css'));
    assert.ok((await cssResponse.text()).includes('--brand'));

    const appResponse = await fetch(`${baseUrl}/app.js`);
    assert.equal(appResponse.status, 200, '/app.js must be served');
    assert.ok(appResponse.headers.get('content-type')?.includes('javascript'));
    // 入口只做启动与绑定；渲染逻辑已外迁，因此检查它确实引用了模块。 
    assert.ok((await appResponse.text()).includes('bootstrap()'));

    const renderResponse = await fetch(`${baseUrl}/lib/render.js`);
    assert.equal(renderResponse.status, 200, '/lib/render.js must be served');
    assert.ok((await renderResponse.text()).includes('export function render'));

    // 外壳资源必须不缓存，否则修好之后浏览器仍执行旧副本。
    for (const path of ['/', '/index.html', '/styles.css', '/app.js', '/sw.js']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.headers.get('cache-control'), 'no-store', `${path} must not be cached`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Windows one-click launcher files are present', async () => {
  await access(`${process.cwd()}/scripts/start-windows.ps1`);
  await access(`${process.cwd()}/scripts/stop-windows.ps1`);
  await access(`${process.cwd()}/scripts/install-windows-shortcuts.ps1`);
  await access(`${process.cwd()}/scripts/uninstall-windows-shortcuts.ps1`);
  await access(`${process.cwd()}/启动伴途.cmd`);
  await access(`${process.cwd()}/停止伴途.cmd`);
  await access(`${process.cwd()}/start-bantu.cmd`);
  await access(`${process.cwd()}/stop-bantu.cmd`);
  await access(`${process.cwd()}/安装伴途快捷方式.cmd`);
  await access(`${process.cwd()}/卸载伴途快捷方式.cmd`);
});
