import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

test('伴途品牌标记与功能图标共用本地自绘 SVG 系统', async () => {
  const mark = await readFile(resolve(process.cwd(), 'public/icon.svg'), 'utf8');
  assert.match(mark, /linearGradient/);
  assert.match(mark, /viewBox="0 0 512 512"/);
  assert.match(mark, /aria-label="伴途"/);
  assert.ok(!mark.includes('circle cx="256" cy="154"'), '品牌图标不再使用旧的人物符号');

  const { uiIcon } = await import(pathToFileURL(resolve(process.cwd(), 'public/lib/icons.js')).href);
  const brand = uiIcon('brand').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replace('fill="currentColor"', 'fill="#fff"');
  assert.ok(mark.includes(brand), '安装图标与页内品牌使用同一标记');
  for (const name of ['pin', 'landmark', 'art', 'tree', 'food', 'clock', 'ticket', 'train', 'compass', 'agent', 'community', 'photo-add', 'share']) {
    const svg = uiIcon(name, { size: 20 });
    assert.match(svg, /<svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(svg), `${name} must not depend on platform emoji rendering`);
  }
  const customized = uiIcon('pin', { size: 180, className: 'map-pin !' });
  assert.match(customized, /width="96" height="96"/);
  assert.match(customized, /class="ui-icon map-pin " /);
  for (const name of ['constructor', '__proto__', '<script>']) {
    assert.equal(uiIcon(name), uiIcon('sparkle'), `${name} is not an approved icon`);
  }
});

test('桌面与底部导航使用功能图标库中的同一版本', async () => {
  const shell = await readFile(resolve(process.cwd(), 'public/index.html'), 'utf8');
  const { uiIcon } = await import(pathToFileURL(resolve(process.cwd(), 'public/lib/icons.js')).href);
  const entries = [...shell.matchAll(/<span class="nav-icon" data-icon="([^"]+)">(<svg[\s\S]*?<\/svg>)<\/span>/g)];
  assert.equal(entries.length, 10);
  for (const [, name, svg] of entries) assert.equal(svg, uiIcon(name, { size: 22 }), `${name} must not retain a separate hand-coded drawing`);
});
