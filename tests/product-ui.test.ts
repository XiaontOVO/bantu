import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFrontendScripts, readShell } from './ui-source.js';

/** 行为分布在入口 + lib/ + views/ 多个文件里，因此读全部页面脚本。 */
const readApp = readFrontendScripts;

test('product UI exposes multi-view app shell, agent chat and polished states', async () => {
  const html = await readShell();
  const app = await readApp();

  assert.doesNotMatch(app, /dayEndMinutes/);
  assert.doesNotMatch(app, /当天已没有足够时间|超出当天结束时间|不能超过当天行程结束时间/);
  assert.ok(app.includes('确认后将加入次日计划'));

  // 静态骨架：写在 index.html 里。
  for (const marker of [
    'class="sidebar"',
    'class="bottom-nav"',
    'data-nav="agent"',
    'data-theme="light"',
  ]) {
    assert.ok(html.includes(marker), `missing shell marker ${marker}`);
  }
  assert.equal((html.match(/data-nav="community"/g) || []).length, 2, 'desktop and mobile each expose one Community entry');
  assert.equal(html.includes('data-nav="plan-shares"'), false, 'plan sharing belongs under Community, not the main navigation');
  assert.ok(app.includes("entry:'community', title:'社区', pages:[['community','旅行帖子'],['plan-shares','方案分享']]"));

  // 视图模板与行为：由 app.js 渲染/绑定，拆分后只在 app.js 里出现。
  for (const marker of [
    'class="hero-card home-hero"',
    'class="chat-shell"',
    'data-chat-form',
    'class="place-grid"',
    'class="memory-card"',
    '把日子过成',
    "action: 'plan-view-date'",
    "action: 'plan-view-date'",
    'data-action="delete-date-plan"',
    'data-action="add-to-plan"',
    'data-action="route-detail"',
    'data-action="versions"',
    'data-action="delete-saved-plan"',
    'data-action="confirm-delete-saved-plan"',
    'data-action="plan-draft-day"',
    'data-action="edit-selected-day-plan"',
    "plan: '方案候选'",
    'plan: renderPlan',
    // 动作已改成查表：navigate 的注册形式变了，断言跟着改成"表里确实有这一项"。
    'navigate: (el) => { closeSheet(); navigate(el.dataset.view); }',
    'const ACTIONS = {',
    '方案候选',
    '地点目录',
    '旅人推荐 · 已审核',
  ]) {
    assert.ok(app.includes(marker), `missing app marker ${marker}`);
  }
});

test('time editing preserves minute precision and expired schemes are re-based when loaded', async () => {
  const app = await readApp();
  assert.ok(app.includes('let minute = parsed ? Number(parsed[2]) : 0;'), 'opening a picker must retain the selected minute');
  assert.ok(app.includes("buildColumn('minute', 60, minute)"), 'users must be able to select every minute');
  assert.ok(app.includes('expiredDate'), 'a scheme with a past start date should be recognised as expired');
  assert.ok(app.includes('设置开始日期'), 'the scheme date control should describe the date picker it opens');
});

test('shared schemes retain their full reusable day structure during import', async () => {
  const { buildImportedSchemeDays } = await import(pathToFileURL(join(process.cwd(), 'public/lib/plan-import.js')).href) as {
    buildImportedSchemeDays: (
      days: unknown[],
      makeStopIds: (index: number, dayIndex: number) => { stopId: string; placeId: string },
      cityCode?: string,
    ) => Array<{ dayIndex: number; stops: Array<Record<string, any>> }>;
  };
  const days = buildImportedSchemeDays([
    { stops: [{ placeId: 'catalog_place_1', name: '第一站', durationMinutes: 60, coordinates: { lat: 31.2, lng: 121.4 } }] },
    { stops: [] },
    { stops: [{ placeId: 'catalog_place_2', name: '第三天的地点', durationMinutes: 45, coordinates: { lat: 31.3, lng: 121.5 } }] },
  ], (index, dayIndex) => ({ stopId: `stop_${dayIndex}_${index}`, placeId: `fallback_${dayIndex}_${index}` }), '310100');

  assert.deepEqual(days.map(day => day.dayIndex), [0, 1, 2]);
  assert.equal(days[1].stops.length, 0, 'an empty day keeps its place in the shared scheme');
  assert.equal(days[0].stops[0].placeId, 'catalog_place_1', 'shared places keep canonical catalog identities');
  assert.equal(days[2].stops[0].placeId, 'catalog_place_2');
  assert.equal(days[2].stops[0].status, 'planned', 'imported stops become reusable planned items');
});

test('opening Mine from a direct link loads the same plans and community counts as in-app navigation', async () => {
  const app = await readApp();
  assert.match(app, /if \(state\.currentView === 'mine' \|\| state\.currentView === 'profile'\) await Promise\.all\([\s\S]*?loadTracked\('community', loadCommunity\)/);
  assert.match(app, /if \(view === 'mine' \|\| view === 'profile'\) \{[\s\S]*?scheduleLoad\('plans'[\s\S]*?scheduleLoad\('community'/);
  assert.match(app, /if \(view === 'home'\) \{[\s\S]*?scheduleLoad\('plans'/);
  assert.match(app, /state\.currentView === 'memories' \|\| state\.currentView === 'mine' \|\| state\.currentView === 'profile'[\s\S]*?loadTracked\('memories', loadAllMemories\)/);
});

test('opening a tripless Agent chat directly reloads its persisted general chat history', async () => {
  const app = await readApp();
  assert.match(app, /loadGeneralMessages, loadReady/);
  assert.match(app, /if \(state\.currentView === 'agent'\) await loadTracked\('messages', loadGeneralMessages\);/);
  assert.match(app, /view === 'agent'[\s\S]*?scheduleLoad\('messages', usesSavedDayPlans\(\) \? loadGeneralMessages : loadMessages, view\)/);
});

test('the main UI never renders developer internals', async () => {
  const html = await readShell();
  const app = await readApp();

  // 这些是曾经直接渲染给用户的内部参数：版本号、UUID 前缀、entryVersion、原始枚举。
  // 它们只允许出现在「设置 → 高级信息」里，不能回到主界面。
  for (const leak of [
    '版本 v${',
    'v${trip.revision}',
    'tripId.slice(',
    'entryVersion ${',
    '生成 v${',
    '计划状态 ${escapeHtml',
    '校验：${escapeHtml(candidate.applicability)}',
    '${escapeHtml(state.trip.trip.timezone)}',
    '${escapeHtml(state.trip.trip.cityCode)}',
  ]) {
    assert.equal(app.includes(leak), false, `developer internals leaked into the UI: ${leak}`);
  }

  // 人话层必须存在，否则上面的断言只是把信息删掉而不是翻译。
  for (const label of [
    'const PLANNING_LABEL',
    'const LIFECYCLE_LABEL',
    'const APPLICABILITY_LABEL',
    'const FACILITY_LABELS',
    'const tripTitle =',
    'const facilityList =',
  ]) {
    assert.ok(app.includes(label), `missing human-readable label layer: ${label}`);
  }

  // 技术参数必须有归宿：「我的」页里有一个可折叠的高级信息区。
  assert.ok(app.includes('<details class="card advanced">'), 'mine needs an advanced section');
  assert.ok(app.includes('高级信息'), 'advanced section must be labelled in Chinese');

  // 右上角是带头像的「我的」入口：TITLES 注册 mine 视图，顶栏按钮用人形头像。
  const titles = /const TITLES = \{([^}]*)\}/.exec(app)?.[1] ?? '';
  assert.ok(titles.includes("mine: '我的'"), `nav title not renamed: ${titles}`);
  assert.ok(html.includes('data-nav="mine" class="icon-btn avatar-btn" aria-label="我的"'), 'avatar entry missing');
  assert.ok(!html.includes('data-nav="profile" class="icon-btn"'), 'old settings gear button should be gone');
});
