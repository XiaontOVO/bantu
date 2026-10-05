import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFrontendScripts, readServiceWorker, readShell, readStyles } from './ui-source.js';

/**
 * 外壳按"关注的层"分文件，断言也按层读取：
 * 样式留在 styles.css，行为留在页面脚本（入口 + lib/ + views/）。
 */
const readApp = readFrontendScripts;

test('prototype page includes basic accessibility affordances', async () => {
  const html = await readShell();
  const css = await readStyles();
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes('aria-label="切换字体大小"'));
  assert.ok(css.includes(':focus-visible'));
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.ok(css.includes('large-text'));
  assert.ok(css.includes('min-height:42px'));
});

test('sidebar trip shortcut is exposed as a named keyboard-operable button', async () => {
  const html = await readShell();
  assert.match(html, /<button class="trip-mini" id="sidebarTrip"[^>]*data-action="navigate" data-view="today"[^>]*aria-label="查看计划与进度"/);
  assert.doesNotMatch(html, /<div class="trip-mini" id="sidebarTrip"/);
});

test('SPA navigation returns to the top and moves focus to the new page heading', async () => {
  const app = await readApp();
  assert.ok(app.includes('if (previousView !== view)'));
  assert.ok(app.includes("window.scrollTo({ top: 0, behavior: 'auto' })"));
  assert.ok(app.includes('heading.focus({ preventScroll: true })'));
  assert.ok(app.includes('navigate(view, { preserveScroll: true })'), 'browser history navigation should keep its restored scroll position');
});

test('place back replaces its history entry, restores list scroll, and falls back to places for deep links', async () => {
  const app = await readApp();
  assert.match(app, /if \(replaceHistory\) history\.replaceState\(null, '', route\);\s*else history\.pushState\(null, '', route\);/);
  assert.ok(app.includes('navigate(target, { replaceHistory: true, preserveScroll: true })'));
  assert.match(app, /const revision = state\.navigationRevision;\s*requestAnimationFrame\(\(\) => \{\s*if \(state\.currentView === target && state\.navigationRevision === revision\) window\.scrollTo\(\{ top: scrollY, behavior:'auto' \}\);/,
    'scroll restoration applies only to the original return navigation');
  assert.match(app, /state\.placeReturnView !== 'place'[\s\S]*?\?\s*state\.placeReturnView\s*:\s*'places'/);
});

test('responsive navigation and date/day controls include safe-area and selection semantics', async () => {
  const css = await readStyles();
  const app = await readApp();
  assert.ok(css.includes('bottom: calc(12px + env(safe-area-inset-bottom, 0px))'));
  assert.ok(css.includes('padding: 16px 14px calc(104px + env(safe-area-inset-bottom, 0px))'));
  assert.ok(css.includes('.place-detail-actions { position: static;'));
  assert.doesNotMatch(css,/\.place-detail-actions\s*\{[^}]*position:\s*(?:fixed|sticky)/);
  assert.ok(app.includes('function planDateChip(date, { selected, today, action })'));
  assert.ok(app.includes('data-action="${action}" data-date="${escapeHtml(date)}" aria-pressed="${date === selected ? \'true\' : \'false\'}"'));
  assert.ok(app.includes('data-action="delete-date-plan" data-date="${escapeHtml(date)}"'));
  assert.ok(css.includes('.plan-date-chip > button:focus-visible'));
  assert.ok(css.includes('.plan-date-chip > .plan-date-delete:hover'));
  assert.ok(app.includes('data-action="plan-draft-day" data-day="${d.dayIndex}" aria-label="第 ${d.dayIndex + 1} 天'));
  assert.ok(app.includes('id="draftDayCount" type="number" min="1" max="${Math.max(366, draft.days.length)}" step="1"'));
});

test('time wheels support keyboard users and app navigation remains browser-back reachable', async () => {
  const app = await readApp();
  assert.ok(app.includes('role="listbox" tabindex="0" aria-label="${label}"'), 'time columns need a keyboard focus target');
  assert.ok(app.includes("event.key === 'ArrowDown'"), 'ArrowDown should change the focused time column');
  assert.ok(app.includes("event.key === 'ArrowUp'"), 'ArrowUp should change the focused time column');
  assert.ok(app.includes("history.pushState(null, '', route)"), 'view changes must create browser history entries');
});

test('the sheet overlay can actually be hidden and dismissed', async () => {
  // 去掉 CSS 注释再匹配：注释里出现的规则名不应让断言通过。
  const css = (await readStyles()).replace(/\/\*[\s\S]*?\*\//g, '');
  const app = await readApp();

  // 回归：.sheet-backdrop 用了 display: grid，作者样式会盖掉浏览器默认的
  // [hidden] { display: none }，导致全屏遮罩永久显示并吃掉页面上的所有点击。
  assert.ok(
    /\[hidden\]\s*\{[^}]*display:\s*none/.test(css),
    'author stylesheet must force [hidden] { display: none }',
  );

  // 面板必须始终可退出：吸顶标题栏、遮罩点击、Escape。
  assert.ok(
    /\.sheet-head\s*\{[^}]*position:\s*sticky/.test(css),
    'sheet header must stay reachable on long content',
  );
  assert.ok(app.includes("event.target === $('sheetBackdrop')"), 'backdrop click must close the sheet');
  assert.ok(app.includes("event.key === 'Escape'"), 'Escape must close the sheet');
});

test('the shell loads its styles and behaviour from separate files', async () => {
  const html = await readShell();
  assert.ok(html.includes('<link rel="stylesheet" href="/styles.css" />'), 'missing stylesheet link');
  // 入口必须是 ES module：模块默认 defer，且不共享全局作用域。
  assert.ok(
    html.includes('<script type="module" src="/app.js"></script>'),
    'missing module app script',
  );
  // 拆分后不应再有内联块，否则会出现两套实现并存的隐患。
  assert.equal(html.includes('<style>'), false, 'index.html must not inline CSS');
  assert.equal(html.includes('<script>'), false, 'index.html must not inline JS');
});

test('the service worker serves navigation from the network so fixes are not cached out', async () => {
  const sw = await readServiceWorker();
  assert.ok(sw.includes("request.mode === 'navigate'"), 'navigations must bypass the cache');
  assert.ok(
    /navigate'\)\s*\{[\s\S]*?fetch\(request\)/.test(sw),
    'navigations must be network-first with a cached fallback',
  );
  // 外壳分文件后，离线回退也必须覆盖 CSS 与入口 JS，否则离线时页面没有样式和交互。
  for (const asset of ['/styles.css', '/app.js']) {
    assert.ok(sw.includes(`'${asset}'`), `${asset} missing from the precache shell`);
  }
});
